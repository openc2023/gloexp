<?php
/**
 * perm_templates.php — 权限模板库管理
 *
 * GET  ?action=list            所有模板（含使用群组数）
 * POST ?action=create          新建模板
 * POST ?action=update&id=      编辑模板（系统模板不可改名/删除 permissions 字段可改）
 * POST ?action=delete&id=      删除模板（系统模板 & 使用中模板不可删）
 */

session_start();
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$action = $_GET['action'] ?? '';
$user   = require_auth();

// 仅管理员可操作
if (!can($user, 'team', 'groups_view')) {
    json_out(['ok' => false, 'msg' => '权限不足'], 403);
}

function ensure_template_permissions_assignable(array $actor, array $permissions): void {
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

function template_change_detail(array $oldPerms, array $newPerms, array $oldScopes, array $newScopes): string {
    $added = array_values(array_diff(array_unique($newPerms), array_unique($oldPerms)));
    $removed = array_values(array_diff(array_unique($oldPerms), array_unique($newPerms)));
    $parts = [];
    if ($added) {
        $parts[] = '新增权限：' . implode(',', $added);
    }
    if ($removed) {
        $parts[] = '移除权限：' . implode(',', $removed);
    }
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
    return $parts ? implode('；', $parts) : '无权限点变化';
}

// ── 模板列表 ─────────────────────────────────────────────────
if ($action === 'list') {
    $stmt = db()->prepare("
        SELECT pt.*,
               (SELECT COUNT(*) FROM org_groups og WHERE og.template_id = pt.id AND og.deleted_at IS NULL) AS used_count
        FROM perm_templates pt
        ORDER BY pt.is_system DESC, pt.id ASC
    ");
    $stmt->execute();
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $canonical = normalize_permission_keys(decode_permission_json($r['permissions'] ?? '[]'));
        $r['permissions'] = $canonical;
        $r['legacy_permissions'] = legacy_permissions_for($canonical);
        $r['data_scopes'] = json_decode($r['data_scopes'] ?? '{}', true);
        $r['used_count']  = (int)$r['used_count'];
        $r['is_system']   = (bool)$r['is_system'];
    }
    json_out(['ok' => true, 'data' => $rows]);
}

// ── 新建模板 ─────────────────────────────────────────────────
if ($action === 'create') {
    method_must('POST');
    require_can($user, 'team', 'groups_create');
    $b    = json_decode(file_get_contents('php://input'), true) ?? [];
    $name = trim($b['name'] ?? '');
    $desc = trim($b['description'] ?? '');

    if (strlen($name) < 2) json_out(['ok' => false, 'msg' => '模板名称至少2个字符']);

    // 名称唯一检查
    $ck = db()->prepare("SELECT id FROM perm_templates WHERE name = ? LIMIT 1");
    $ck->execute([$name]);
    if ($ck->fetch()) json_out(['ok' => false, 'msg' => '模板名称已存在']);

    ensure_template_permissions_assignable($user, (array)($b['permissions'] ?? []));
    $perms      = json_encode(normalize_permission_keys((array)($b['permissions'] ?? [])), JSON_UNESCAPED_UNICODE);
    $dataScopes = json_encode($b['data_scopes'] ?? ['inbound' => 'group', 'outbound' => 'group', 'parcels' => 'group'], JSON_UNESCAPED_UNICODE);

    db()->prepare("
        INSERT INTO perm_templates (name, description, permissions, data_scopes)
        VALUES (?, ?, ?, ?)
    ")->execute([$name, $desc, $perms, $dataScopes]);

    $newId = (int)db()->lastInsertId();
    write_log($user, '新增', '权限模板', $newId, $name);
    json_out(['ok' => true, 'id' => $newId]);
}

// ── 编辑模板 ─────────────────────────────────────────────────
if ($action === 'update') {
    method_must('POST');
    require_can($user, 'team', 'groups_edit');
    $id = (int)($_GET['id'] ?? 0);

    // 检查模板存在
    $t = db()->prepare("SELECT * FROM perm_templates WHERE id = ? LIMIT 1");
    $t->execute([$id]);
    $tpl = $t->fetch();
    if (!$tpl) json_out(['ok' => false, 'msg' => '模板不存在']);

    $b      = json_decode(file_get_contents('php://input'), true) ?? [];
    $fields = []; $params = [];
    $oldPerms = decode_permission_json($tpl['permissions'] ?? '[]');
    $oldScopes = normalize_data_scopes($tpl['data_scopes'] ?? null);
    $newPerms = $oldPerms;
    $newScopes = $oldScopes;

    // 系统模板名称不可修改
    if (isset($b['name'])) {
        if ($tpl['is_system']) {
            json_out(['ok' => false, 'msg' => '系统内置模板不可改名']);
        }
        $newName = trim($b['name']);
        if (strlen($newName) < 2) json_out(['ok' => false, 'msg' => '模板名称至少2个字符']);
        // 唯一性检查（排除自身）
        $ck = db()->prepare("SELECT id FROM perm_templates WHERE name = ? AND id != ? LIMIT 1");
        $ck->execute([$newName, $id]);
        if ($ck->fetch()) json_out(['ok' => false, 'msg' => '模板名称已存在']);
        $fields[] = 'name = ?'; $params[] = $newName;
    }

    if (isset($b['description'])) {
        $fields[] = 'description = ?'; $params[] = trim($b['description']);
    }

    if (isset($b['permissions'])) {
        ensure_template_permissions_assignable($user, (array)$b['permissions']);
        $newPerms = normalize_permission_keys(array_values(array_unique(array_filter((array)$b['permissions'], 'is_string'))));
        $fields[] = 'permissions = ?';
        $params[] = json_encode($newPerms, JSON_UNESCAPED_UNICODE);
    }

    if (isset($b['data_scopes'])) {
        $newScopes = normalize_data_scopes($b['data_scopes']);
        $fields[] = 'data_scopes = ?';
        $params[] = json_encode($newScopes, JSON_UNESCAPED_UNICODE);
    }

    if (!$fields) json_out(['ok' => false, 'msg' => '无更新字段']);

    $params[] = $id;
    db()->prepare("UPDATE perm_templates SET " . implode(', ', $fields) . " WHERE id = ?")->execute($params);

    write_log($user, '编辑', '权限模板', $id, (string)($tpl['name']), template_change_detail($oldPerms, $newPerms, $oldScopes, $newScopes));
    json_out(['ok' => true]);
}

// ── 删除模板 ─────────────────────────────────────────────────
if ($action === 'delete') {
    method_must('POST');
    require_can($user, 'team', 'groups_delete');
    $id = (int)($_GET['id'] ?? 0);

    $t = db()->prepare("SELECT * FROM perm_templates WHERE id = ? LIMIT 1");
    $t->execute([$id]);
    $tpl = $t->fetch();
    if (!$tpl) json_out(['ok' => false, 'msg' => '模板不存在']);

    // 系统模板不可删除
    if ($tpl['is_system']) json_out(['ok' => false, 'msg' => '系统内置模板不可删除']);

    // 使用中的模板不可删除
    $us = db()->prepare("SELECT COUNT(*) FROM org_groups WHERE template_id = ? AND deleted_at IS NULL");
    $us->execute([$id]);
    if ((int)$us->fetchColumn() > 0) json_out(['ok' => false, 'msg' => '该模板正在被群组使用，请先解除引用']);

    db()->prepare("DELETE FROM perm_templates WHERE id = ?")->execute([$id]);
    write_log($user, '删除', '权限模板', $id, (string)$tpl['name']);
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => '未知操作'], 400);
