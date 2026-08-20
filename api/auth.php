<?php
/**
 * auth.php
 * GET  ?action=check
 * POST ?action=login
 * POST ?action=logout
 * POST ?action=change_pwd
 */

require_once __DIR__ . '/session_boot.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/db.php';

function is_super_admin(array $user): bool {
    return ($user['role'] ?? '') === 'admin';
}

function normalize_perm_override($raw): array {
    if (is_string($raw)) {
        $raw = json_decode($raw, true);
    }
    if (!is_array($raw)) {
        $raw = [];
    }

    $clean = function ($items): array {
        if (!is_array($items)) {
            return [];
        }
        return normalize_permission_keys(array_values(array_filter($items, 'is_string')));
    };

    return [
        'add' => $clean($raw['add'] ?? []),
        'remove' => $clean($raw['remove'] ?? []),
    ];
}

function apply_perm_override(array $basePerms, array $override): array {
    if (in_array('*', $basePerms, true)) {
        return ['*'];
    }

    $added = $override['add'] ?? [];
    $removed = $override['remove'] ?? [];
    $merged = normalize_permission_keys(array_merge($basePerms, $added));
    return normalize_permission_keys(array_values(array_diff($merged, $removed)), true);
}

function normalize_scope_override($raw): array {
    if (is_string($raw)) {
        $raw = json_decode($raw, true);
    }
    if (!is_array($raw)) {
        return [];
    }

    $out = [];
    foreach (['inbound', 'outbound', 'parcels'] as $key) {
        if (isset($raw[$key]) && in_array($raw[$key], ['global', 'group', 'self'], true)) {
            $out[$key] = $raw[$key];
        }
    }
    return $out;
}

/**
 * Build the latest session context for a user.
 * Permission layers:
 * - users.role: super admin switch
 * - group_permissions: base feature permissions
 * - org_group_members: org identity and member role
 * - member overrides: explicit per-member permission/scope exceptions
 */
function build_session_context(int $uid): ?array {
    $db = db();

    $stmt = $db->prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1");
    $stmt->execute([$uid]);
    $u = $stmt->fetch();
    if (!$u) {
        return null;
    }

    $basePerms = [];
    $groupDataScopes = ['inbound' => 'group', 'outbound' => 'group', 'parcels' => 'group'];
    if ($u['role'] === 'admin') {
        $basePerms = ['*'];
    } elseif (!empty($u['group_id'])) {
        $g = $db->prepare("SELECT data_scopes FROM groups WHERE id = ? LIMIT 1");
        $g->execute([(int)$u['group_id']]);
        $grp = $g->fetch();
        $basePerms = group_permission_keys($db, (int)$u['group_id'], true);
        $groupDataScopes = normalize_data_scopes($grp['data_scopes'] ?? null);
    }

    $orgGroupId = null;
    $orgGroupRole = 'member';
    $dataScopes = $u['role'] === 'admin'
        ? ['inbound' => 'global', 'outbound' => 'global', 'parcels' => 'global']
        : $groupDataScopes;

    if ($u['role'] !== 'admin') {
        $m = $db->prepare("
            SELECT ogm.group_id, ogm.role_in_group, ogm.perm_override, ogm.scope_override, og.data_scopes
            FROM org_group_members ogm
            JOIN org_groups og ON og.id = ogm.group_id AND og.deleted_at IS NULL
            WHERE ogm.user_id = ?
            LIMIT 1
        ");
        $m->execute([$uid]);
        $mem = $m->fetch();

        if ($mem) {
            $orgGroupId = (int)$mem['group_id'];
            $orgGroupRole = $mem['role_in_group'] ?: 'member';
            $groupScopes = json_decode($mem['data_scopes'] ?? '{}', true);
            $dataScopes = array_merge($dataScopes, normalize_data_scopes($groupScopes), normalize_scope_override($mem['scope_override'] ?? null));
            $basePerms = apply_perm_override($basePerms, normalize_perm_override($mem['perm_override'] ?? null));
        }
    }

    return [
        'uid'             => (int)$u['id'],
        'username'        => $u['username'],
        'role'            => $u['role'],
        'group_id'        => $u['group_id'],
        'perms'           => array_values(array_unique($basePerms)),
        'org_group_id'    => $orgGroupId,
        'org_group_role'  => $orgGroupRole,
        'data_scopes'     => $dataScopes,
        'is_leader'       => ($orgGroupRole === 'leader'),
        'must_change_pwd' => (bool)($u['must_change_pwd'] ?? false),
    ];
}

function require_auth(): array {
    if (empty($_SESSION['uid'])) {
        json_out(['ok' => false, 'msg' => 'UNAUTHORIZED', 'redirect' => 'login'], 401);
    }
    $idleLimit = 2 * 60 * 60;
    $now = time();
    $lastSeen = (int)($_SESSION['last_seen_at'] ?? $now);
    if ($now - $lastSeen > $idleLimit) {
        session_destroy();
        json_out(['ok' => false, 'msg' => 'SESSION_EXPIRED', 'redirect' => 'login'], 401);
    }
    $_SESSION['last_seen_at'] = $now;

    return [
        'uid'            => $_SESSION['uid'],
        'username'       => $_SESSION['username'],
        'role'           => $_SESSION['role'],
        'group_id'       => $_SESSION['group_id'],
        'perms'          => $_SESSION['perms'] ?? [],
        'org_group_id'   => $_SESSION['org_group_id'] ?? null,
        'org_group_role' => $_SESSION['org_group_role'] ?? 'member',
        'data_scopes'    => $_SESSION['data_scopes'] ?? ['inbound' => 'global', 'outbound' => 'global', 'parcels' => 'global'],
    ];
}

function _save_context_to_session(array $ctx): void {
    $_SESSION['uid'] = $ctx['uid'];
    $_SESSION['username'] = $ctx['username'];
    $_SESSION['role'] = $ctx['role'];
    $_SESSION['group_id'] = $ctx['group_id'];
    $_SESSION['perms'] = $ctx['perms'];
    $_SESSION['org_group_id'] = $ctx['org_group_id'];
    $_SESSION['org_group_role'] = $ctx['org_group_role'];
    $_SESSION['data_scopes'] = $ctx['data_scopes'];
}

function touch_last_active(int $uid, bool $force = false): void {
    $now = time();
    $last = (int)($_SESSION['last_active_touch'] ?? 0);
    if (!$force && $now - $last < 300) {
        return;
    }

    db()->prepare("UPDATE users SET last_active_at = datetime('now','localtime') WHERE id = ?")->execute([$uid]);
    $_SESSION['last_active_touch'] = $now;
}

function can(array $user, string $resource, string $action): bool {
    if (is_super_admin($user)) {
        return true;
    }

    $perms = $user['perms'] ?? [];
    if (in_array('*', $perms, true)) {
        return true;
    }

    $permission = canonical_permission_for($resource . ':' . $action);
    return in_array($permission, $perms, true);
}

function require_can(array $user, string $resource, string $action): void {
    if (!can($user, $resource, $action)) {
        json_out(['ok' => false, 'msg' => '权限不足'], 403);
    }
}

function unused_permission_gate(array $user, string $perm): void {
    if (true) {
        json_out(['ok' => false, 'msg' => '没有权限'], 403);
    }
}

function mask_phone(string $phone): string {
    if (strlen($phone) >= 7) {
        return substr($phone, 0, 3) . '****' . substr($phone, -4);
    }
    return $phone ? '****' : '';
}

if (basename($_SERVER['SCRIPT_FILENAME']) !== 'auth.php') {
    return;
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

if ($action === 'login') {
    method_must('POST');
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $username = trim($body['username'] ?? '');
    $password = trim($body['password'] ?? '');

    if ($username === '' || $password === '') {
        json_out(['ok' => false, 'msg' => '请输入账号和密码']);
    }

    $stmt = db()->prepare("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1");
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if (!$user || !password_verify($password, $user['password'])) {
        json_out(['ok' => false, 'msg' => '账号或密码错误']);
    }

    $ctx = build_session_context((int)$user['id']);
    if (!$ctx) {
        json_out(['ok' => false, 'msg' => '登录失败，用户不存在']);
    }

    _save_context_to_session($ctx);
    session_regenerate_id(true);
    $_SESSION['last_seen_at'] = time();
    touch_last_active((int)$user['id'], true);

    json_out(['ok' => true, 'user' => $ctx]);
}

if ($action === 'logout') {
    session_destroy();
    json_out(['ok' => true]);
}

if ($action === 'check') {
    $sess = require_auth();
    $ctx = build_session_context((int)$sess['uid']);
    if (!$ctx) {
        session_destroy();
        json_out(['ok' => false, 'msg' => 'UNAUTHORIZED'], 401);
    }

    _save_context_to_session($ctx);
    touch_last_active((int)$sess['uid']);
    json_out(['ok' => true, 'user' => $ctx]);
}

if ($action === 'change_pwd') {
    method_must('POST');
    $user = require_auth();
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $oldPwd = trim($body['old_password'] ?? '');
    $newPwd = trim($body['new_password'] ?? '');

    if (strlen($newPwd) < 6) {
        json_out(['ok' => false, 'msg' => '新密码至少 6 位']);
    }

    $stmt = db()->prepare("SELECT password FROM users WHERE id = ? LIMIT 1");
    $stmt->execute([(int)$user['uid']]);
    $row = $stmt->fetch();

    if (!$row || !password_verify($oldPwd, $row['password'])) {
        json_out(['ok' => false, 'msg' => '旧密码错误']);
    }

    $hash = password_hash($newPwd, PASSWORD_BCRYPT);
    db()->prepare("UPDATE users SET password = ?, must_change_pwd = 0 WHERE id = ?")->execute([$hash, (int)$user['uid']]);
    json_out(['ok' => true, 'msg' => '密码已更新']);
}

json_out(['ok' => false, 'msg' => '无效操作'], 400);
