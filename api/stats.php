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

// 首页统计是对整张 parcels 表做 COUNT/SUM 聚合，比前面几个简单 SELECT 贵，
// 每个人打开首页都要查一次——100 人同时开首页就是 100 次全表聚合扫描，值得缓存。
// 但这个输出是按各人的数据范围（仅自己/本团队/全部）算出来的，不是所有人看到
// 的数字都一样，缓存 key 必须把范围条件（含参数）和"今天"这个日期都编进去——
// 同一个范围、同一天的人共享一份缓存，不会把甲的数字缓存给乙看到；过了午夜
// "今天"变了，key 自然跟着变，不会拿旧的一天缓存值当新一天的数字用。
// TTL 故意比前面那几个短：这是个"实时看板"，别让缓存拖慢太久感觉不到新数据。
$cacheKey = 'stats:summary:' . md5(implode('|', $where) . '::' . implode('|', $params) . '::' . $today);
$data = cache_remember($cacheKey, 20, function () use ($where, $params) {
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

    return [
        'total'       => (int)($row['total'] ?? 0),
        'today'       => (int)($row['today'] ?? 0),
        'pending'     => (int)($row['pending'] ?? 0),
        'shipped'     => (int)($row['shipped'] ?? 0),
        'not_arrived' => (int)($row['not_arrived'] ?? 0),
        'arrived'     => (int)($row['arrived'] ?? 0),
        'notified'    => (int)($row['notified'] ?? 0),
    ];
});

json_out(['ok' => true, 'data' => $data]);
