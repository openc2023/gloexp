<?php
/**
 * groups.php - permission group management (admin only)
 *
 * GET  ?action=list
 * GET  ?action=perms_meta
 * GET  ?action=permission_lookup&permission=
 * POST ?action=create
 * POST ?action=update&id=
 * POST ?action=delete&id=
 */

require_once __DIR__ . '/session_boot.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$action = $_GET['action'] ?? '';
$user = require_auth();

function perms_meta(): array {
    return [
        ['gate' => 'p_inbound', 'canonical' => 'inbound:view', 'label' => '新增入库单', 'description' => '录入客户资料、入库信息、图片和备注。', 'children' => [
            ['key' => 'p_inbound_add',    'canonical' => 'inbound:create', 'label' => '新增入库单'],
            ['key' => 'p_inbound_edit',   'canonical' => 'inbound:edit', 'label' => '编辑入库单'],
            ['key' => 'p_inbound_delete', 'canonical' => 'inbound:delete', 'label' => '删除入库单'],
            ['key' => 'p_inbound_parse',  'canonical' => 'inbound:parse', 'label' => '使用智能解析'],
            ['key' => 'p_inbound_phone',  'canonical' => 'inbound:phone', 'label' => '查看明文手机号'],
            ['key' => 'p_inbound_export', 'canonical' => 'inbound:export', 'label' => '导出 CSV'],
        ]],
        ['gate' => 'p_outbound', 'canonical' => 'parcels:view', 'label' => '快递管理', 'description' => '处理待邮寄/已邮寄快递、单号、物流、客户通知和图片。', 'children' => [
            ['key' => 'p_outbound_edit',   'canonical' => 'parcels:edit', 'label' => '处理/编辑快递'],
            ['key' => 'p_outbound_phone',  'canonical' => 'parcels:phone', 'label' => '查看明文手机号'],
            ['key' => 'p_outbound_export', 'canonical' => 'parcels:export', 'label' => '导出 CSV'],
            ['key' => 'p_parcels_delete',  'canonical' => 'parcels:delete', 'label' => '删除快递记录'],
        ]],
        ['gate' => 'p_team', 'canonical' => 'team:view', 'label' => '团队管理', 'description' => '账号、权限组、团队架构和数据范围。', 'children' => [
            ['key' => 'p_managers',                'canonical' => 'team:accounts_view', 'label' => '查看账号管理'],
            ['key' => 'p_managers_add',            'canonical' => 'team:accounts_create', 'label' => '新增账号'],
            ['key' => 'p_managers_edit',           'canonical' => 'team:accounts_edit', 'label' => '编辑账号/重置密码'],
            ['key' => 'p_managers_delete',         'canonical' => 'team:accounts_delete', 'label' => '删除账号'],
            ['key' => 'p_groups',                  'canonical' => 'team:groups_view', 'label' => '查看权限组'],
            ['key' => 'p_groups_add',              'canonical' => 'team:groups_create', 'label' => '新增权限组'],
            ['key' => 'p_groups_edit',             'canonical' => 'team:groups_edit', 'label' => '编辑权限组'],
            ['key' => 'p_groups_delete',           'canonical' => 'team:groups_delete', 'label' => '删除权限组'],
            ['key' => 'p_orggroups',               'canonical' => 'team:org_view', 'label' => '查看团队架构'],
            ['key' => 'p_orggroups_add',           'canonical' => 'team:org_create', 'label' => '新增团队'],
            ['key' => 'p_orggroups_edit',          'canonical' => 'team:org_edit', 'label' => '编辑团队'],
            ['key' => 'p_orggroups_delete',        'canonical' => 'team:org_delete', 'label' => '删除团队'],
            ['key' => 'p_orggroups_member_add',    'canonical' => 'team:member_add', 'label' => '添加团队成员'],
            ['key' => 'p_orggroups_member_edit',   'canonical' => 'team:member_edit', 'label' => '调整成员角色'],
            ['key' => 'p_orggroups_member_remove', 'canonical' => 'team:member_remove', 'label' => '移出团队成员'],
        ]],
        ['gate' => 'p_couriers', 'canonical' => 'couriers:view', 'label' => '快递商管理', 'description' => '维护快递公司、分类、服务类型和物流链接。', 'children' => [
            ['key' => 'p_couriers_add',    'canonical' => 'couriers:create', 'label' => '新增快递商'],
            ['key' => 'p_couriers_edit',   'canonical' => 'couriers:edit', 'label' => '编辑快递商'],
            ['key' => 'p_couriers_delete', 'canonical' => 'couriers:delete', 'label' => '删除快递商'],
        ]],
        ['gate' => 'p_trash', 'canonical' => 'trash:view', 'label' => '回收站', 'description' => '恢复或彻底删除已删除记录。', 'children' => [
            ['key' => 'p_trash_restore', 'canonical' => 'trash:restore', 'label' => '恢复记录'],
            ['key' => 'p_trash_purge',   'canonical' => 'trash:purge', 'label' => '永久删除'],
        ]],
        ['gate' => 'p_logs', 'canonical' => 'logs:view', 'label' => '操作日志', 'description' => '查看后台操作记录和清理日志。', 'children' => [
            ['key' => 'p_logs_view',  'canonical' => 'logs:view', 'label' => '查看操作日志'],
            ['key' => 'p_logs_clear', 'canonical' => 'logs:clear', 'label' => '清空日志'],
        ]],
    ];
}

function group_data_scopes_from_body(array $body): array {
    return normalize_data_scopes($body['data_scopes'] ?? null);
}

function all_permission_keys(): array {
    $keys = array_keys(permission_catalog());
    foreach (perms_meta() as $module) {
        if (!empty($module['gate'])) {
            $keys[] = $module['gate'];
        }
        foreach (($module['children'] ?? []) as $child) {
            if (!empty($child['key'])) {
                $keys[] = $child['key'];
            }
        }
    }
    return array_values(array_unique($keys));
}

function has_permission_key(array $perms, string $permission): bool {
    if (in_array('*', $perms, true)) {
        return true;
    }
    $canonical = canonical_permission_for($permission);
    $canonicalPerms = normalize_permission_keys($perms);
    return in_array($canonical, $canonicalPerms, true);
}

function permission_change_detail(array $oldPerms, array $newPerms, ?array $oldScopes = null, ?array $newScopes = null): string {
    $oldCanonical = normalize_permission_keys($oldPerms);
    $newCanonical = normalize_permission_keys($newPerms);
    $added = array_values(array_diff($newCanonical, $oldCanonical));
    $removed = array_values(array_diff($oldCanonical, $newCanonical));
    $parts = [];
    if ($added) {
        $parts[] = '新增权限：' . implode(',', $added);
    }
    if ($removed) {
        $parts[] = '移除权限：' . implode(',', $removed);
    }
    if ($oldScopes !== null && $newScopes !== null) {
        $scopeChanges = [];
        foreach (['inbound' => '入库', 'outbound' => '快递', 'parcels' => '回收/统计'] as $key => $label) {
            $old = $oldScopes[$key] ?? 'group';
            $new = $newScopes[$key] ?? 'group';
            if ($old !== $new) {
                $scopeChanges[] = $label . ':' . $old . '->' . $new;
            }
        }
        if ($scopeChanges) {
            $parts[] = '范围变更：' . implode(',', $scopeChanges);
        }
    }
    return $parts ? implode('；', $parts) : '权限未变化';
}

function row_permissions_for_ui(PDO $db, int $groupId): array {
    return legacy_permissions_for(group_permission_keys($db, $groupId));
}

function ensure_assignable_permissions(array $actor, array $permissions): void {
    if (is_super_admin($actor)) {
        return;
    }

    foreach (normalize_permission_keys($permissions) as $perm) {
        [$resource, $action] = array_pad(explode(':', $perm, 2), 2, '');
        if ($resource === '' || $action === '' || !can($actor, $resource, $action)) {
            json_out(['ok' => false, 'msg' => 'Cannot assign permissions you do not already have'], 403);
        }
    }
}

function require_not_own_permission_group(array $actor, int $groupId): void {
    if (!is_super_admin($actor) && $groupId > 0 && (int)($actor['group_id'] ?? 0) === $groupId) {
        json_out(['ok' => false, 'msg' => 'Cannot manage your own permission group'], 403);
    }
}

if ($action === 'perms_meta') {
    require_can($user, 'team', 'groups_view');
    json_out(['ok' => true, 'data' => perms_meta(), 'catalog' => permission_catalog()]);
}

if ($action === 'permission_lookup') {
    require_can($user, 'team', 'groups_view');

    $permission = trim((string)($_GET['permission'] ?? ''));
    if ($permission === '') {
        json_out(['ok' => false, 'msg' => 'permission is required'], 400);
    }
    if (!in_array($permission, all_permission_keys(), true) && $permission !== '*') {
        json_out(['ok' => false, 'msg' => 'unknown permission'], 400);
    }

    $canonical = canonical_permission_for($permission);
    $db = db();
    $groupRows = $db->query("SELECT id, name FROM groups ORDER BY id ASC")->fetchAll();
    $matchedGroups = [];
    $groupPerms = [];
    foreach ($groupRows as $group) {
        $perms = group_permission_keys($db, (int)$group['id']);
        $groupPerms[(int)$group['id']] = $perms;
        if (has_permission_key($perms, $canonical)) {
            $matchedGroups[] = [
                'id' => (int)$group['id'],
                'name' => $group['name'],
                'match' => in_array('*', $perms, true) ? '*' : 'permission',
            ];
        }
    }

    $stmt = $db->query("
        SELECT u.id, u.username, u.role, u.group_id, g.name AS group_name,
               ogm.group_id AS org_group_id, ogm.role_in_group, ogm.perm_override
        FROM users u
        LEFT JOIN groups g ON g.id = u.group_id
        LEFT JOIN org_group_members ogm ON ogm.user_id = u.id
        WHERE u.deleted_at IS NULL
        ORDER BY u.role DESC, u.username ASC
    ");
    $matchedUsers = [];
    foreach ($stmt->fetchAll() as $row) {
        $source = '';
        $basePerms = [];
        if (($row['role'] ?? '') === 'admin') {
            $source = 'super_admin';
            $basePerms = ['*'];
        } elseif (!empty($row['group_id'])) {
            $basePerms = $groupPerms[(int)$row['group_id']] ?? [];
            if (has_permission_key($basePerms, $canonical)) {
                $source = 'permission_group';
            }
        }

        $override = normalize_perm_override($row['perm_override'] ?? null);
        if (has_permission_key($override['remove'] ?? [], $canonical)) {
            continue;
        }
        if (has_permission_key($override['add'] ?? [], $canonical)) {
            $source = 'member_override';
        }
        if ($source === '') {
            continue;
        }

        $matchedUsers[] = [
            'id' => (int)$row['id'],
            'username' => $row['username'],
            'role' => $row['role'],
            'group_id' => $row['group_id'] ? (int)$row['group_id'] : null,
            'group_name' => $row['group_name'],
            'org_group_id' => $row['org_group_id'] ? (int)$row['org_group_id'] : null,
            'role_in_group' => $row['role_in_group'] ?: null,
            'source' => $source,
        ];
    }

    json_out(['ok' => true, 'data' => [
        'permission' => $permission,
        'canonical' => $canonical,
        'groups' => $matchedGroups,
        'users' => $matchedUsers,
    ]]);
}

if ($action === 'list') {
    require_can($user, 'team', 'groups_view');
    $db = db();
    $stmt = $db->query("
        SELECT g.id, g.name, g.data_scopes, g.created_at,
               (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id AND u.deleted_at IS NULL) AS user_count
        FROM groups g
        ORDER BY g.id ASC
    ");
    $rows = $stmt->fetchAll();
    foreach ($rows as &$row) {
        $canonical = group_permission_keys($db, (int)$row['id']);
        $row['permissions'] = legacy_permissions_for($canonical);
        $row['canonical_permissions'] = $canonical;
        $row['data_scopes'] = normalize_data_scopes($row['data_scopes'] ?? null);
        $row['user_count'] = (int)($row['user_count'] ?? 0);
    }
    unset($row);
    json_out(['ok' => true, 'data' => $rows]);
}

if ($action === 'create') {
    method_must('POST');
    require_can($user, 'team', 'groups_create');

    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') {
        json_out(['ok' => false, 'msg' => '权限组名称不能为空']);
    }

    $permissions = array_values(array_unique(array_filter((array)($body['permissions'] ?? []), 'is_string')));
    ensure_assignable_permissions($user, $permissions);
    $dataScopes = group_data_scopes_from_body($body);
    $db = db();
    $db->prepare("INSERT INTO groups (name, permissions, data_scopes) VALUES (?, '[]', ?)")
        ->execute([$name, json_encode($dataScopes, JSON_UNESCAPED_UNICODE)]);

    $newId = (int)$db->lastInsertId();
    save_group_permission_keys($db, $newId, $permissions);
    write_log($user, '创建', '权限组', $newId, $name, 'permissions=' . implode(',', normalize_permission_keys($permissions)));
    json_out(['ok' => true, 'id' => $newId]);
}

if ($action === 'update') {
    method_must('POST');
    require_can($user, 'team', 'groups_edit');

    $id = (int)($_GET['id'] ?? 0);
    require_not_own_permission_group($user, $id);
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $db = db();
    $oldStmt = $db->prepare("SELECT name, data_scopes FROM groups WHERE id = ? LIMIT 1");
    $oldStmt->execute([$id]);
    $oldRow = $oldStmt->fetch();
    if (!$oldRow) {
        json_out(['ok' => false, 'msg' => '权限组不存在'], 404);
    }

    $fields = [];
    $params = [];
    if (array_key_exists('name', $body)) {
        $name = trim((string)$body['name']);
        if ($name === '') {
            json_out(['ok' => false, 'msg' => '权限组名称不能为空']);
        }
        $fields[] = "name = ?";
        $params[] = $name;
    }

    $oldPermissions = group_permission_keys($db, $id);
    $oldScopes = normalize_data_scopes($oldRow['data_scopes'] ?? null);
    $newPermissions = $oldPermissions;
    $newScopes = $oldScopes;

    if (array_key_exists('data_scopes', $body)) {
        $newScopes = group_data_scopes_from_body($body);
        $fields[] = "data_scopes = ?";
        $params[] = json_encode($newScopes, JSON_UNESCAPED_UNICODE);
    }

    if ($fields) {
        $params[] = $id;
        $db->prepare("UPDATE groups SET " . implode(', ', $fields) . " WHERE id = ?")->execute($params);
    }

    if (array_key_exists('permissions', $body)) {
        $newPermissions = normalize_permission_keys(array_values(array_unique(array_filter((array)$body['permissions'], 'is_string'))));
        ensure_assignable_permissions($user, $newPermissions);
        save_group_permission_keys($db, $id, $newPermissions);
    } elseif (!$fields) {
        json_out(['ok' => false, 'msg' => '没有可更新的内容']);
    }

    $stmt = $db->prepare("SELECT name FROM groups WHERE id = ? LIMIT 1");
    $stmt->execute([$id]);
    write_log($user, '编辑', '权限组', $id, (string)($stmt->fetchColumn() ?? ''), permission_change_detail($oldPermissions, $newPermissions, $oldScopes, $newScopes));
    json_out(['ok' => true]);
}

if ($action === 'delete') {
    method_must('POST');
    require_can($user, 'team', 'groups_delete');

    $id = (int)($_GET['id'] ?? 0);
    require_not_own_permission_group($user, $id);
    $db = db();
    $stmt = $db->prepare("SELECT name FROM groups WHERE id = ? LIMIT 1");
    $stmt->execute([$id]);
    $name = (string)($stmt->fetchColumn() ?? '');
    $uc = $db->prepare("SELECT COUNT(*) FROM users WHERE group_id = ? AND deleted_at IS NULL");
    $uc->execute([$id]);
    $affectedUsers = (int)$uc->fetchColumn();

    $db->prepare("UPDATE users SET group_id = NULL WHERE group_id = ?")->execute([$id]);
    $db->prepare("DELETE FROM group_permissions WHERE group_id = ?")->execute([$id]);
    $db->prepare("DELETE FROM groups WHERE id = ?")->execute([$id]);

    write_log($user, '删除', '权限组', $id, $name, '影响账号：' . $affectedUsers);
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => '无效操作'], 400);
