<?php
/**
 * org_groups.php
 * GET  ?action=list
 * GET  ?action=members&id=
 * POST ?action=create
 * POST ?action=update&id=
 * POST ?action=delete&id=
 * POST ?action=add_member
 * POST ?action=remove_member
 * POST ?action=update_member
 */

require_once __DIR__ . '/session_boot.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$action = $_GET['action'] ?? '';
$user = require_auth();

function check_org_access(array $user): void {
    require_can($user, 'team', 'org_view');
}

function check_group_ownership(array $user, int $groupId): void {
    if (is_super_admin($user)) {
        return;
    }
    if ((int)$user['org_group_id'] !== $groupId) {
        json_out(['ok' => false, 'msg' => '只能管理自己的团队'], 403);
    }
}

function require_group_leader(array $user, int $groupId): void {
    check_group_ownership($user, $groupId);
    if (is_super_admin($user)) {
        return;
    }
    if (($user['org_group_role'] ?? 'member') !== 'leader') {
        json_out(['ok' => false, 'msg' => '只有团队组长可以管理成员和团队设置'], 403);
    }
}

function cleanup_deleted_org_members(?int $groupId = null): void {
    $sql = "
        DELETE FROM org_group_members
        WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)
    ";
    $params = [];
    if ($groupId) {
        $sql .= " AND group_id = ?";
        $params[] = $groupId;
    }
    db()->prepare($sql)->execute($params);
}

function normalize_scopes($scopes): array {
    $defaults = ['inbound' => 'group', 'outbound' => 'group', 'parcels' => 'group'];
    if (!is_array($scopes)) {
        return $defaults;
    }

    foreach ($defaults as $key => $default) {
        $value = $scopes[$key] ?? $default;
        $defaults[$key] = in_array($value, ['global', 'group', 'self'], true) ? $value : $default;
    }

    return $defaults;
}

function ensure_member_permission_override_assignable(array $actor, array $override): void {
    if (is_super_admin($actor)) {
        return;
    }

    foreach (($override['add'] ?? []) as $perm) {
        [$resource, $action] = array_pad(explode(':', $perm, 2), 2, '');
        if ($resource === '' || $action === '' || !can($actor, $resource, $action)) {
            json_out(['ok' => false, 'msg' => 'Cannot assign permissions you do not already have'], 403);
        }
    }
}

function ensure_member_scope_override_assignable(array $actor, array $override): void {
    if (is_super_admin($actor)) {
        return;
    }

    $rank = ['self' => 0, 'group' => 1, 'global' => 2];
    $actorScopes = normalize_scopes($actor['data_scopes'] ?? null);
    foreach ($override as $resource => $scope) {
        if (!isset($rank[$scope])) {
            continue;
        }
        $actorScope = $actorScopes[$resource] ?? 'self';
        if (($rank[$scope] ?? 0) > ($rank[$actorScope] ?? 0)) {
            json_out(['ok' => false, 'msg' => 'Cannot assign a wider data scope than your own'], 403);
        }
    }
}

function normalize_leader_ids($ids): array {
    if (!is_array($ids)) {
        return [];
    }
    return array_values(array_unique(array_filter(array_map('intval', $ids), function ($id) {
        return $id > 0;
    })));
}

function sync_group_leaders(PDO $db, int $groupId, array $leaderIds): void {
    $leaderIds = normalize_leader_ids($leaderIds);
    $db->prepare("UPDATE org_group_members SET role_in_group = 'member' WHERE group_id = ? AND role_in_group = 'leader'")
        ->execute([$groupId]);

    if (!$leaderIds) {
        return;
    }

    $stmt = $db->prepare("
        INSERT INTO org_group_members (group_id, user_id, role_in_group, perm_override, scope_override)
        VALUES (?, ?, 'leader', '{\"add\":[],\"remove\":[]}', '{}')
        ON CONFLICT(group_id, user_id) DO UPDATE SET role_in_group = 'leader'
    ");
    $clearExisting = $db->prepare("DELETE FROM org_group_members WHERE user_id = ? AND group_id <> ?");
    foreach ($leaderIds as $leaderId) {
        $clearExisting->execute([$leaderId, $groupId]);
        $stmt->execute([$groupId, $leaderId]);
    }
}

if ($action === 'list') {
    check_org_access($user);
    $db = db();
    cleanup_deleted_org_members();

    $where = ["og.deleted_at IS NULL"];
    $params = [];
    if (!is_super_admin($user)) {
        $where[] = "og.id = ?";
        $params[] = (int)$user['org_group_id'];
    }

    $stmt = $db->prepare("
        SELECT og.*,
               p.name AS parent_name,
               (SELECT COUNT(*)
                FROM org_group_members ogm
                JOIN users mu ON mu.id = ogm.user_id AND mu.deleted_at IS NULL
                WHERE ogm.group_id = og.id) AS member_count
        FROM org_groups og
        LEFT JOIN org_groups p ON p.id = og.parent_id AND p.deleted_at IS NULL
        WHERE " . implode(' AND ', $where) . "
        ORDER BY og.parent_id ASC, og.id ASC
    ");
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    $allLeaderIds = [];
    foreach ($rows as &$row) {
        $leaderIds = json_decode($row['leader_ids'] ?? '[]', true);
        $leaderIds = is_array($leaderIds) ? array_map('intval', $leaderIds) : [];
        $row['leader_ids'] = $leaderIds;
        $allLeaderIds = array_merge($allLeaderIds, $leaderIds);
        $row['data_scopes'] = normalize_scopes(json_decode($row['data_scopes'] ?? '{}', true));
        $row['member_count'] = (int)$row['member_count'];
        $row['permissions'] = [];
        $row['template_id'] = null;
        $row['template_name'] = null;
    }
    unset($row);

    $leaderNameMap = [];
    $allLeaderIds = array_values(array_unique(array_filter($allLeaderIds)));
    if ($allLeaderIds) {
        $ph = implode(',', array_fill(0, count($allLeaderIds), '?'));
        $ls = $db->prepare("SELECT id, username FROM users WHERE id IN ($ph) AND deleted_at IS NULL");
        $ls->execute($allLeaderIds);
        foreach ($ls->fetchAll() as $leader) {
            $leaderNameMap[(int)$leader['id']] = $leader['username'];
        }
    }
    foreach ($rows as &$row) {
        $row['leader_names'] = array_values(array_filter(array_map(function ($id) use ($leaderNameMap) {
            return $leaderNameMap[(int)$id] ?? null;
        }, $row['leader_ids'])));
    }
    unset($row);

    json_out(['ok' => true, 'data' => $rows]);
}

if ($action === 'members') {
    check_org_access($user);
    $groupId = (int)($_GET['id'] ?? 0);
    check_group_ownership($user, $groupId);

    $stmt = db()->prepare("
        SELECT ogm.group_id, ogm.user_id, ogm.role_in_group, ogm.joined_at,
               u.username, u.role AS user_role, u.last_active_at,
               ogm.perm_override, ogm.scope_override,
               g.name AS perm_group_name
        FROM org_group_members ogm
        JOIN users u ON u.id = ogm.user_id AND u.deleted_at IS NULL
        LEFT JOIN groups g ON g.id = u.group_id
        WHERE ogm.group_id = ?
        ORDER BY ogm.role_in_group ASC, u.username ASC
    ");
    $stmt->execute([$groupId]);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$row) {
        $row['perm_override'] = normalize_perm_override($row['perm_override'] ?? null);
        $row['scope_override'] = normalize_scope_override($row['scope_override'] ?? null);
    }
    unset($row);
    json_out(['ok' => true, 'data' => $rows]);
}

if ($action === 'create') {
    method_must('POST');
    require_can($user, 'team', 'org_create');
    if (false) {
        json_out(['ok' => false, 'msg' => '只有超级管理员可以新建团队'], 403);
    }

    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $name = trim($body['name'] ?? '');
    if (mb_strlen($name) < 2) {
        json_out(['ok' => false, 'msg' => '团队名称至少 2 个字']);
    }

    $parentId = !empty($body['parent_id']) ? (int)$body['parent_id'] : null;
    $leaderIds = normalize_leader_ids($body['leader_ids'] ?? []);
    $dataScopes = normalize_scopes($body['data_scopes'] ?? null);
    $description = trim($body['description'] ?? '');

    if (!is_super_admin($user)) {
        $ownGroupId = (int)($user['org_group_id'] ?? 0);
        if ($ownGroupId <= 0 || $parentId !== $ownGroupId) {
            json_out(['ok' => false, 'msg' => 'Non-admin users can only create child teams under their own team'], 403);
        }
        require_group_leader($user, $ownGroupId);
    }

    if ($parentId) {
        $depth = 0;
        $pid = $parentId;
        while ($pid) {
            $ps = db()->prepare("SELECT parent_id FROM org_groups WHERE id = ? AND deleted_at IS NULL LIMIT 1");
            $ps->execute([$pid]);
            $pr = $ps->fetch();
            $pid = $pr ? $pr['parent_id'] : null;
            if (++$depth >= 3) {
                json_out(['ok' => false, 'msg' => '团队层级最多支持 3 级']);
            }
        }
    }

    db()->prepare("
        INSERT INTO org_groups (name, parent_id, description, leader_ids, template_id, permissions, data_scopes)
        VALUES (?, ?, ?, ?, NULL, '[]', ?)
    ")->execute([
        $name,
        $parentId,
        $description,
        json_encode($leaderIds, JSON_UNESCAPED_UNICODE),
        json_encode($dataScopes, JSON_UNESCAPED_UNICODE),
    ]);

    $newId = (int)db()->lastInsertId();
    sync_group_leaders(db(), $newId, $leaderIds);
    write_log($user, '创建', '团队', $newId, $name, 'parent_id=' . ($parentId ?? 'null'));
    json_out(['ok' => true, 'id' => $newId]);
}

if ($action === 'update') {
    method_must('POST');
    $id = (int)($_GET['id'] ?? 0);
    require_can($user, 'team', 'org_edit');
    require_group_leader($user, $id);

    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $fields = [];
    $params = [];
    $leaderIdsForSync = null;

    if (array_key_exists('name', $body)) {
        $fields[] = 'name = ?';
        $params[] = trim($body['name']);
    }
    if (array_key_exists('description', $body)) {
        $fields[] = 'description = ?';
        $params[] = trim($body['description']);
    }
    if (array_key_exists('leader_ids', $body)) {
        $leaderIdsForSync = normalize_leader_ids($body['leader_ids'] ?? []);
        $fields[] = 'leader_ids = ?';
        $params[] = json_encode($leaderIdsForSync, JSON_UNESCAPED_UNICODE);
    }
    if (array_key_exists('data_scopes', $body)) {
        $fields[] = 'data_scopes = ?';
        $params[] = json_encode(normalize_scopes($body['data_scopes']), JSON_UNESCAPED_UNICODE);
    }

    // 每次保存都顺手清掉旧的模板/附加权限，保持规则唯一。
    $fields[] = 'template_id = NULL';
    $fields[] = "permissions = '[]'";
    $fields[] = "updated_at = datetime('now','localtime')";

    if (!$fields) {
        json_out(['ok' => false, 'msg' => '没有可更新的内容']);
    }

    $params[] = $id;
    db()->prepare("UPDATE org_groups SET " . implode(', ', $fields) . " WHERE id = ? AND deleted_at IS NULL")->execute($params);
    if ($leaderIdsForSync !== null) {
        sync_group_leaders(db(), $id, $leaderIdsForSync);
    }

    $s = db()->prepare("SELECT name FROM org_groups WHERE id = ? LIMIT 1");
    $s->execute([$id]);
    write_log($user, '更新', '团队', $id, (string)($s->fetchColumn() ?? ''));
    json_out(['ok' => true]);
}

if ($action === 'delete') {
    method_must('POST');
    require_can($user, 'team', 'org_delete');

    $id = (int)($_GET['id'] ?? 0);
    require_group_leader($user, $id);
    cleanup_deleted_org_members($id);

    $cs = db()->prepare("SELECT COUNT(*) FROM org_groups WHERE parent_id = ? AND deleted_at IS NULL");
    $cs->execute([$id]);
    if ((int)$cs->fetchColumn() > 0) {
        json_out(['ok' => false, 'msg' => '请先删除子团队']);
    }

    $ms = db()->prepare("
        SELECT COUNT(*)
        FROM org_group_members ogm
        JOIN users u ON u.id = ogm.user_id AND u.deleted_at IS NULL
        WHERE ogm.group_id = ?
    ");
    $ms->execute([$id]);
    if ((int)$ms->fetchColumn() > 0) {
        json_out(['ok' => false, 'msg' => '请先移除团队成员']);
    }

    $s = db()->prepare("SELECT name FROM org_groups WHERE id = ? LIMIT 1");
    $s->execute([$id]);
    $name = (string)($s->fetchColumn() ?? '');

    db()->prepare("UPDATE org_groups SET deleted_at = datetime('now','localtime') WHERE id = ?")->execute([$id]);
    write_log($user, '删除', '团队', $id, $name);
    json_out(['ok' => true]);
}

if ($action === 'add_member') {
    method_must('POST');
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $groupId = (int)($body['group_id'] ?? 0);
    $userId = (int)($body['user_id'] ?? 0);
    require_can($user, 'team', 'member_add');
    require_group_leader($user, $groupId);

    $role = in_array($body['role_in_group'] ?? '', ['leader', 'senior', 'member'], true)
        ? $body['role_in_group']
        : 'member';
    if (!is_super_admin($user) && $role === 'leader') {
        json_out(['ok' => false, 'msg' => '只有超级管理员可以任命组长'], 403);
    }

    $ex = db()->prepare("SELECT group_id FROM org_group_members WHERE user_id = ? LIMIT 1");
    $ex->execute([$userId]);
    $existing = $ex->fetch();
    if ($existing && (int)$existing['group_id'] !== $groupId) {
        json_out(['ok' => false, 'msg' => '该成员已在其他团队，请先移除旧团队']);
    }

    try {
        db()->prepare("
            INSERT INTO org_group_members (group_id, user_id, role_in_group, perm_override, scope_override)
            VALUES (?, ?, ?, '{\"add\":[],\"remove\":[]}', '{}')
            ON CONFLICT(group_id, user_id) DO UPDATE SET role_in_group = excluded.role_in_group
        ")->execute([$groupId, $userId, $role]);
    } catch (\Throwable $e) {
        json_out(['ok' => false, 'msg' => '添加成员失败: ' . $e->getMessage()]);
    }

    $s = db()->prepare("SELECT username FROM users WHERE id = ? LIMIT 1");
    $s->execute([$userId]);
    $uname = (string)($s->fetchColumn() ?? '');
    write_log($user, '创建', '团队成员', $userId, $uname, 'group_id=' . $groupId . ', role=' . $role);
    json_out(['ok' => true]);
}

if ($action === 'remove_member') {
    method_must('POST');
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $groupId = (int)($body['group_id'] ?? 0);
    $userId = (int)($body['user_id'] ?? 0);
    require_can($user, 'team', 'member_remove');
    require_group_leader($user, $groupId);
    if (!is_super_admin($user) && $userId === (int)$user['uid']) {
        json_out(['ok' => false, 'msg' => '不能将自己移出团队'], 403);
    }

    db()->prepare("DELETE FROM org_group_members WHERE group_id = ? AND user_id = ?")->execute([$groupId, $userId]);
    $s = db()->prepare("SELECT username FROM users WHERE id = ? LIMIT 1");
    $s->execute([$userId]);
    write_log($user, '删除', '团队成员', $userId, (string)($s->fetchColumn() ?? ''), 'group_id=' . $groupId);
    json_out(['ok' => true]);
}

if ($action === 'update_member') {
    method_must('POST');
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $groupId = (int)($body['group_id'] ?? 0);
    $userId = (int)($body['user_id'] ?? 0);
    require_can($user, 'team', 'member_edit');
    require_group_leader($user, $groupId);
    if (!is_super_admin($user) && $userId === (int)$user['uid']) {
        json_out(['ok' => false, 'msg' => '不能调整自己的团队角色'], 403);
    }

    $role = $body['role_in_group'] ?? '';
    if (!in_array($role, ['leader', 'senior', 'member'], true)) {
        json_out(['ok' => false, 'msg' => '无效团队角色']);
    }
    if (!is_super_admin($user) && $role === 'leader') {
        json_out(['ok' => false, 'msg' => '只有超级管理员可以任命组长'], 403);
    }

    $fields = ['role_in_group = ?'];
    $params = [$role];
    $detailParts = ['role=' . $role];

    if (array_key_exists('perm_override', $body)) {
        $override = normalize_perm_override($body['perm_override']);
        ensure_member_permission_override_assignable($user, $override);
        $fields[] = 'perm_override = ?';
        $params[] = json_encode($override, JSON_UNESCAPED_UNICODE);
        $detailParts[] = 'perm_override=' . json_encode($override, JSON_UNESCAPED_UNICODE);
    }

    if (array_key_exists('scope_override', $body)) {
        $scopeOverride = normalize_scope_override($body['scope_override']);
        ensure_member_scope_override_assignable($user, $scopeOverride);
        $fields[] = 'scope_override = ?';
        $params[] = json_encode($scopeOverride, JSON_UNESCAPED_UNICODE);
        $detailParts[] = 'scope_override=' . json_encode($scopeOverride, JSON_UNESCAPED_UNICODE);
    }

    $params[] = $groupId;
    $params[] = $userId;
    db()->prepare("
        UPDATE org_group_members
        SET " . implode(', ', $fields) . "
        WHERE group_id = ? AND user_id = ?
    ")->execute($params);

    $s = db()->prepare("SELECT username FROM users WHERE id = ? LIMIT 1");
    $s->execute([$userId]);
    write_log($user, '更新', '团队成员', $userId, (string)($s->fetchColumn() ?? ''), 'role=' . $role);
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => '无效操作'], 400);
