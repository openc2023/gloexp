<?php
/**
 * managers.php - account management.
 *
 * GET  ?action=dropdown
 * GET  ?action=list
 * POST ?action=create
 * POST ?action=update&id=
 * POST ?action=delete&id=
 * POST ?action=reset_pwd&id=
 */

if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$user = require_auth();

function get_active_user(int $id): ?array {
    $stmt = db()->prepare("
        SELECT id, username, role, group_id
        FROM users
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1
    ");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function active_admin_count(): int {
    return (int)db()->query("SELECT COUNT(*) FROM users WHERE role = 'admin' AND deleted_at IS NULL")->fetchColumn();
}

function protect_admin_account(array $actor, array $target): void {
    if (is_super_admin($actor)) {
        return;
    }
    if (($target['role'] ?? '') === 'admin') {
        json_out(['ok' => false, 'msg' => '只有超级管理员可以操作超级管理员账号'], 403);
    }
    // 目标账号当前权限组里的任意一项权限，只要超出操作人自己拥有的权限范围，
    // 就不允许操作（编辑/改权限组/重置密码/删除）——防止低权限账号通过"账号管理"
    // 权限点去降级甚至接管权限比自己大的账号。
    if (!empty($target['group_id'])) {
        $targetPerms = group_permission_keys(db(), (int)$target['group_id']);
        foreach ($targetPerms as $perm) {
            [$resource, $action] = array_pad(explode(':', $perm, 2), 2, '');
            if ($resource === '' || $action === '' || !can($actor, $resource, $action)) {
                json_out(['ok' => false, 'msg' => '该账号的权限组超出您自己的权限范围，无法操作'], 403);
            }
        }
    }
}

function ensure_assignable_group(array $actor, $groupId): void {
    if (is_super_admin($actor) || empty($groupId)) {
        return;
    }

    $targetPerms = group_permission_keys(db(), (int)$groupId);
    foreach ($targetPerms as $perm) {
        [$resource, $action] = array_pad(explode(':', $perm, 2), 2, '');
        if ($resource === '' || $action === '' || !can($actor, $resource, $action)) {
            json_out(['ok' => false, 'msg' => '不能分配超过自己权限范围的权限组'], 403);
        }
    }
}

if ($action === 'dropdown') {
    $stmt = db()->query("SELECT id, username FROM users WHERE deleted_at IS NULL ORDER BY username ASC");
    json_out(['ok' => true, 'data' => $stmt->fetchAll()]);
}

if ($action === 'list') {
    require_can($user, 'team', 'accounts_view');
    $stmt = db()->query("
        SELECT u.id, u.username, u.role, u.group_id, g.name AS group_name, u.created_at
        FROM users u
        LEFT JOIN groups g ON g.id = u.group_id
        WHERE u.deleted_at IS NULL
        ORDER BY u.id ASC
    ");
    json_out(['ok' => true, 'data' => $stmt->fetchAll()]);
}

if ($action === 'create') {
    method_must('POST');
    require_can($user, 'team', 'accounts_create');

    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $uname = trim((string)($body['username'] ?? ''));
    $pwd = trim((string)($body['password'] ?? 'glo2026'));
    $gid = !empty($body['group_id']) ? (int)$body['group_id'] : null;

    if (mb_strlen($uname) < 2) {
        json_out(['ok' => false, 'msg' => '账号至少 2 个字符']);
    }
    if (strlen($pwd) < 6) {
        json_out(['ok' => false, 'msg' => '密码至少 6 位']);
    }
    ensure_assignable_group($user, $gid);

    $hash = password_hash($pwd, PASSWORD_BCRYPT);
    $existingStmt = db()->prepare("SELECT id, role, deleted_at FROM users WHERE username = ? LIMIT 1");
    $existingStmt->execute([$uname]);
    $existing = $existingStmt->fetch();

    if ($existing && empty($existing['deleted_at'])) {
        json_out(['ok' => false, 'msg' => '账号已存在']);
    }

    if ($existing && !empty($existing['deleted_at'])) {
        $existingId = (int)$existing['id'];
        db()->prepare("
            UPDATE users
            SET password = ?,
                role = 'viewer',
                group_id = ?,
                must_change_pwd = 1,
                last_active_at = NULL,
                deleted_at = NULL
            WHERE id = ?
        ")->execute([$hash, $gid, $existingId]);
        db()->prepare("DELETE FROM org_group_members WHERE user_id = ?")->execute([$existingId]);
        write_log($user, '恢复账号', '账号', $existingId, $uname, '恢复已删除账号并重置为普通账号');
        json_out(['ok' => true, 'id' => $existingId, 'restored' => true]);
    }

    db()->prepare("
        INSERT INTO users (username, password, role, group_id, must_change_pwd)
        VALUES (?, ?, 'viewer', ?, 1)
    ")->execute([$uname, $hash, $gid]);
    $newId = (int)db()->lastInsertId();
    write_log($user, '创建', '账号', $newId, $uname, 'role=viewer');
    json_out(['ok' => true, 'id' => $newId]);
}

if ($action === 'update') {
    method_must('POST');
    require_can($user, 'team', 'accounts_edit');

    $id = (int)($_GET['id'] ?? 0);
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $target = get_active_user($id);
    if (!$target) {
        json_out(['ok' => false, 'msg' => '账号不存在'], 404);
    }
    protect_admin_account($user, $target);

    if (isset($body['role'])) {
        json_out(['ok' => false, 'msg' => '系统角色不允许在账号管理里修改'], 403);
    }

    $fields = [];
    $params = [];
    $detail = [];

    if (array_key_exists('username', $body)) {
        $newUname = trim((string)$body['username']);
        if (mb_strlen($newUname) < 2) {
            json_out(['ok' => false, 'msg' => '账号至少 2 个字符']);
        }
        if ($newUname !== $target['username']) {
            // users.username 在数据库层是全局 UNIQUE（不区分是否软删除），但这里查重
            // 之前只看了 deleted_at IS NULL 的未删除账号——如果改成一个已经被软删除
            // 账号占用过的名字，这里会误判"没有重复"，真正执行 UPDATE 时才会撞上
            // 数据库的 UNIQUE 约束，抛出没被 catch 的 PDOException，变成一个不知所云
            // 的 500 网络异常。查重范围要覆盖软删除账号。
            $dupStmt = db()->prepare("SELECT id, deleted_at FROM users WHERE username = ? AND id != ? LIMIT 1");
            $dupStmt->execute([$newUname, $id]);
            $dup = $dupStmt->fetch();
            if ($dup) {
                if (empty($dup['deleted_at'])) {
                    json_out(['ok' => false, 'msg' => '账号已存在']);
                }
                // 撞上的是已删除账号——名字应该让给正常账号继续用，不能因为回收站里
                // 躺着一条早就不再活跃的记录就把这个名字永久占死。把那条软删除记录
                // 的用户名让开（加后缀避免再撞 UNIQUE），它在回收站里其它信息不受
                // 影响，仍然可以按需要恢复；只是不能再用这个名字恢复了。
                db()->prepare("UPDATE users SET username = ? WHERE id = ?")
                    ->execute([$newUname . '_deleted_' . $dup['id'] . '_' . time(), (int)$dup['id']]);
            }
            $fields[] = 'username = ?';
            $params[] = $newUname;
            $detail[] = 'username: ' . $target['username'] . ' -> ' . $newUname;
        }
    }

    if (($target['role'] ?? '') !== 'admin' && array_key_exists('group_id', $body)) {
        if (!is_super_admin($user) && $id === (int)$user['uid']) {
            json_out(['ok' => false, 'msg' => '不能修改自己的权限组'], 403);
        }
        $gid = !empty($body['group_id']) ? (int)$body['group_id'] : null;
        ensure_assignable_group($user, $gid);
        $fields[] = 'group_id = ?';
        $params[] = $gid;
        $detail[] = 'group_id=' . ($gid ?? 'null');
    }

    if (!empty($body['password'])) {
        $pwd = trim((string)$body['password']);
        if (strlen($pwd) < 6) {
            json_out(['ok' => false, 'msg' => '密码至少 6 位']);
        }
        $fields[] = 'password = ?';
        $params[] = password_hash($pwd, PASSWORD_BCRYPT);
        $detail[] = 'password=changed';
    }

    if (!$fields) {
        json_out(['ok' => false, 'msg' => '没有可更新的内容']);
    }

    $params[] = $id;
    db()->prepare("UPDATE users SET " . implode(', ', $fields) . " WHERE id = ? AND deleted_at IS NULL")->execute($params);
    write_log($user, '编辑', '账号', $id, (string)$target['username'], implode('; ', $detail));
    json_out(['ok' => true]);
}

if ($action === 'delete') {
    method_must('POST');
    require_can($user, 'team', 'accounts_delete');

    $id = (int)($_GET['id'] ?? 0);
    if ($id === (int)$user['uid']) {
        json_out(['ok' => false, 'msg' => '不能删除自己'], 403);
    }

    $target = get_active_user($id);
    if (!$target) {
        json_out(['ok' => false, 'msg' => '账号不存在'], 404);
    }
    protect_admin_account($user, $target);

    if (($target['role'] ?? '') === 'admin' && active_admin_count() <= 1) {
        json_out(['ok' => false, 'msg' => '至少保留一个超级管理员'], 403);
    }

    db()->prepare("UPDATE users SET deleted_at = datetime('now','localtime') WHERE id = ? AND deleted_at IS NULL")->execute([$id]);
    db()->prepare("DELETE FROM org_group_members WHERE user_id = ?")->execute([$id]);
    write_log($user, '删除', '账号', $id, (string)$target['username']);
    json_out(['ok' => true]);
}

if ($action === 'reset_pwd') {
    method_must('POST');
    require_can($user, 'team', 'accounts_edit');

    $id = (int)($_GET['id'] ?? 0);
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $target = get_active_user($id);
    if (!$target) {
        json_out(['ok' => false, 'msg' => '账号不存在'], 404);
    }
    protect_admin_account($user, $target);

    $pwd = trim((string)($body['password'] ?? 'glo2026'));
    if (strlen($pwd) < 6) {
        json_out(['ok' => false, 'msg' => '密码至少 6 位']);
    }

    db()->prepare("UPDATE users SET password = ? WHERE id = ? AND deleted_at IS NULL")
        ->execute([password_hash($pwd, PASSWORD_BCRYPT), $id]);
    write_log($user, '重置密码', '账号', $id, (string)$target['username']);
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => '无效操作'], 400);
