<?php
/**
 * couriers.php — 快递商管理
 *
 * GET  ?action=list              全部列表（含服务类型）
 * POST ?action=create
 * POST ?action=update&id=
 * POST ?action=delete&id=
 */

session_start();
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$action = $_GET['action'] ?? '';
$user   = require_auth();

if ($action === 'list') {
    // 快递商列表无需特殊权限，登录即可（表单用）
    $stmt = db()->query("SELECT * FROM couriers WHERE deleted_at IS NULL ORDER BY category, id ASC");
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['service_types'] = json_decode($r['service_types'] ?? '["普通"]', true);
    }
    json_out(['ok' => true, 'data' => $rows]);
}

if ($action === 'create') {
    method_must('POST');
    require_can($user, 'couriers', 'create');
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $name = trim($body['name'] ?? '');
    $cat  = trim($body['category'] ?? 'cn');
    if (!$name) json_out(['ok' => false, 'msg' => '名称必填']);
    $st = json_encode(
        array_values(array_filter(array_map('trim', $body['service_types'] ?? ['普通']))),
        JSON_UNESCAPED_UNICODE
    );
    db()->prepare("INSERT INTO couriers (name,category,tracking_url,service_types) VALUES (?,?,?,?)")
        ->execute([$name, $cat, trim($body['tracking_url'] ?? ''), $st]);
    $newId = (int)db()->lastInsertId();
    write_log($user, '新增', '快递商', $newId, $name);
    json_out(['ok' => true, 'id' => $newId]);
}

if ($action === 'update') {
    method_must('POST');
    require_can($user, 'couriers', 'edit');
    $id   = (int)($_GET['id'] ?? 0);
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $fields = []; $params = [];
    if (isset($body['name']))         { $fields[] = "name = ?";         $params[] = trim($body['name']); }
    if (isset($body['category']))     { $fields[] = "category = ?";     $params[] = trim($body['category']); }
    if (isset($body['tracking_url'])) { $fields[] = "tracking_url = ?"; $params[] = trim($body['tracking_url']); }
    if (isset($body['service_types'])) {
        $fields[] = "service_types = ?";
        $params[] = json_encode(
            array_values(array_filter(array_map('trim', $body['service_types']))),
            JSON_UNESCAPED_UNICODE
        );
    }
    if (!$fields) json_out(['ok' => false, 'msg' => '无更新字段']);
    $params[] = $id;
    db()->prepare("UPDATE couriers SET " . implode(', ', $fields) . " WHERE id = ? AND deleted_at IS NULL")->execute($params);
    $s = db()->prepare("SELECT name FROM couriers WHERE id = ? LIMIT 1"); $s->execute([$id]);
    write_log($user, '编辑', '快递商', $id, (string)($s->fetchColumn() ?? ''));
    json_out(['ok' => true]);
}

if ($action === 'delete') {
    method_must('POST');
    require_can($user, 'couriers', 'delete');
    $id = (int)($_GET['id'] ?? 0);
    $s = db()->prepare("SELECT name FROM couriers WHERE id = ? LIMIT 1"); $s->execute([$id]);
    $recName = (string)($s->fetchColumn() ?? '');
    db()->prepare("UPDATE couriers SET deleted_at = datetime('now','localtime') WHERE id = ? AND deleted_at IS NULL")->execute([$id]);
    write_log($user, '删除', '快递商', $id, $recName);
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => '未知操作'], 400);
