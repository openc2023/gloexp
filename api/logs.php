<?php
/**
 * logs.php — 操作日志
 *
 * GET  ?action=list             分页列表（需 p_logs_view）
 * POST ?action=clear            清空日志（需 p_logs_clear）
 */

require_once __DIR__ . '/session_boot.php';
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$user   = require_auth();

// ── 列表 ──────────────────────────────────────────────────────
if ($action === 'list') {
    require_can($user, 'logs', 'view');

    $page   = max(1, (int)($_GET['page']  ?? 1));
    $requestedLimit = (int)($_GET['limit'] ?? 20);
    $limit  = in_array($requestedLimit, [20,50,100], true) ? $requestedLimit : 20;
    $offset = ($page - 1) * $limit;

    $where  = ['1=1'];
    $params = [];

    if ($v = trim($_GET['q'] ?? '')) {
        $where[] = "(username LIKE ? OR target_name LIKE ? OR detail LIKE ?)";
        array_push($params, "%$v%", "%$v%", "%$v%");
    }
    if ($v = trim($_GET['username']    ?? '')) { $where[] = "username LIKE ?";    $params[] = "%$v%"; }
    if ($v = trim($_GET['action_kw']   ?? '')) { $where[] = "action LIKE ?";      $params[] = "%$v%"; }
    if ($v = trim($_GET['target_type'] ?? '')) { $where[] = "target_type = ?";    $params[] = $v; }
    if ($v = trim($_GET['date_start']  ?? '')) { $where[] = "DATE(created_at) >= ?"; $params[] = $v; }
    if ($v = trim($_GET['date_end']    ?? '')) { $where[] = "DATE(created_at) <= ?"; $params[] = $v; }

    $sql = "FROM operation_logs WHERE " . implode(' AND ', $where);

    $cstmt = db()->prepare("SELECT COUNT(*) $sql");
    $cstmt->execute($params);
    $total = (int)$cstmt->fetchColumn();

    $lstmt = db()->prepare("SELECT * $sql ORDER BY id DESC LIMIT ? OFFSET ?");
    $lstmt->execute(array_merge($params, [$limit, $offset]));
    $rows = $lstmt->fetchAll();

    json_out(['ok' => true, 'total' => $total, 'data' => $rows]);
}

// ── 清空日志 ──────────────────────────────────────────────────
if ($action === 'clear') {
    method_must('POST');
    require_can($user, 'logs', 'clear');
    db()->exec("DELETE FROM operation_logs");
    write_log($user, '清空日志', '操作日志', 0, '');
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => '未知操作'], 400);
