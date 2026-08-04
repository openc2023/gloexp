<?php
/**
 * trash.php - soft-deleted parcel records.
 */

session_start();
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$action = $_GET['action'] ?? '';
$user   = require_auth();

function trash_scope_where(array $user, int $id = 0): array {
    $where = ["p.deleted_at IS NOT NULL"];
    $params = [];
    if ($id > 0) {
        $where[] = "p.id = ?";
        $params[] = $id;
    }

    [$scopeWhere, $scopeParams] = data_scope_condition($user, 'parcels');
    if ($scopeWhere) {
        $where[] = $scopeWhere;
        $params = array_merge($params, $scopeParams);
    }

    return [$where, $params];
}

if ($action === 'list') {
    require_can($user, 'trash', 'view');

    [$where, $params] = trash_scope_where($user);
    $where[] = "p.deleted_at >= ?";
    $params[] = date('Y-m-d H:i:s', strtotime('-2 months'));

    $stmt = db()->prepare("
        SELECT p.id, p.source, p.name, p.phone, p.status, p.deleted_at,
               c.name AS courier_name, u.username AS manager_name,
               datetime(p.deleted_at, '+2 months') AS expires_at
        FROM parcels p
        LEFT JOIN couriers c ON c.id = p.courier_id
        LEFT JOIN users u    ON u.id = p.manager_id
        WHERE " . implode(' AND ', $where) . "
        ORDER BY p.deleted_at DESC
    ");
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    $phoneAll      = can($user, 'parcels', 'phone');
    $phoneInbound  = $phoneAll || can($user, 'inbound', 'phone');
    foreach ($rows as &$r) {
        $canSee = $r['source'] === 'inbound' ? $phoneInbound : $phoneAll;
        if (!$canSee) {
            $r['phone'] = mask_phone($r['phone']);
        }
    }

    json_out(['ok' => true, 'data' => $rows]);
}

if ($action === 'restore') {
    method_must('POST');
    require_can($user, 'trash', 'restore');

    $id = (int)($_GET['id'] ?? 0);
    [$where, $params] = trash_scope_where($user, $id);
    $stmt = db()->prepare("SELECT p.name FROM parcels p WHERE " . implode(' AND ', $where) . " LIMIT 1");
    $stmt->execute($params);
    $recName = $stmt->fetchColumn();
    if ($recName === false) {
        json_out(['ok' => false, 'msg' => 'Deleted record not found'], 404);
    }

    db()->prepare("UPDATE parcels SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL")->execute([$id]);
    write_log($user, '还原', '回收站', $id, (string)$recName);
    json_out(['ok' => true]);
}

if ($action === 'purge') {
    method_must('POST');
    require_can($user, 'trash', 'purge');

    $id = (int)($_GET['id'] ?? 0);
    [$where, $params] = trash_scope_where($user, $id);
    $stmt = db()->prepare("SELECT p.name, p.images FROM parcels p WHERE " . implode(' AND ', $where) . " LIMIT 1");
    $stmt->execute($params);
    $row = $stmt->fetch();
    if (!$row) {
        json_out(['ok' => false, 'msg' => 'Deleted record not found'], 404);
    }

    foreach (json_decode($row['images'] ?? '[]', true) ?: [] as $path) {
        $full = __DIR__ . '/../' . ltrim((string)$path, '/');
        if (file_exists($full)) {
            @unlink($full);
        }
    }

    db()->prepare("DELETE FROM parcels WHERE id = ? AND deleted_at IS NOT NULL")->execute([$id]);
    write_log($user, '永久删除', '回收站', $id, (string)$row['name']);
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => 'Unknown action'], 400);
