<?php
/**
 * stats.php - dashboard summary.
 */

require_once __DIR__ . '/session_boot.php';
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$user   = require_auth();
$action = $_GET['action'] ?? '';
if ($action !== 'summary') json_out(['ok' => false, 'msg' => 'Unknown action'], 400);

$today = date('Y-m-d');
$where = ["p.deleted_at IS NULL"];
$params = [$today];
[$scopeWhere, $scopeParams] = data_scope_condition($user, 'parcels');
if ($scopeWhere) {
    $where[] = $scopeWhere;
    $params = array_merge($params, $scopeParams);
}

$stmt = db()->prepare("
    SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN DATE(p.created_at) = ? THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN p.status = 'pending-ship' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN p.status = 'shipped' THEN 1 ELSE 0 END) AS shipped,
        SUM(CASE WHEN p.status = 'not-arrived' THEN 1 ELSE 0 END) AS not_arrived,
        SUM(CASE WHEN p.status = 'arrived' THEN 1 ELSE 0 END) AS arrived,
        SUM(CASE WHEN p.status = 'notified' THEN 1 ELSE 0 END) AS notified
    FROM parcels p
    WHERE " . implode(' AND ', $where)
);
$stmt->execute($params);
$row = $stmt->fetch() ?: [];

json_out(['ok' => true, 'data' => [
    'total'       => (int)($row['total'] ?? 0),
    'today'       => (int)($row['today'] ?? 0),
    'pending'     => (int)($row['pending'] ?? 0),
    'shipped'     => (int)($row['shipped'] ?? 0),
    'not_arrived' => (int)($row['not_arrived'] ?? 0),
    'arrived'     => (int)($row['arrived'] ?? 0),
    'notified'    => (int)($row['notified'] ?? 0),
]]);
