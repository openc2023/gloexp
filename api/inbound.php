<?php
/**
 * inbound.php — 入库单
 *
 * GET  ?action=list              分页列表
 * POST ?action=create            新增入库单（status=pending-ship）
 * POST ?action=parse             智能解析文本
 * POST ?action=update&id=        编辑
 * POST ?action=delete&id=        软删除
 */

session_start();
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/parcels.php'; // 复用 parse_express_text / resolve_manager

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$user   = require_auth();

// 负责人指派范围校验：与 outbound.php 的 manager_allowed_in_outbound_scope 同一套逻辑，
// 复用 data_scopes.inbound（仅自己/本团队/全部），非管理员默认只能把入库单指派给自己。
function manager_allowed_in_inbound_scope(array $user, ?int $managerId): bool {
    if ($user['role'] === 'admin' || in_array('*', $user['perms'] ?? [], true)) {
        return true;
    }
    $scope = ($user['data_scopes'] ?? [])['inbound'] ?? 'global';
    if ($scope === 'global') {
        return true;
    }
    if (!$managerId) {
        return false;
    }
    if ($scope === 'self') {
        return $managerId === (int)$user['uid'];
    }
    if ($scope === 'group' && !empty($user['org_group_id'])) {
        $stmt = db()->prepare("SELECT COUNT(*) FROM org_group_members WHERE group_id = ? AND user_id = ?");
        $stmt->execute([(int)$user['org_group_id'], $managerId]);
        return (int)$stmt->fetchColumn() > 0;
    }
    return $managerId === (int)$user['uid'];
}
function require_inbound_manager_assignment(array $user, array $body): void {
    if (!array_key_exists('manager_id', $body)) {
        return;
    }
    $managerId = !empty($body['manager_id']) ? (int)$body['manager_id'] : null;
    if (!manager_allowed_in_inbound_scope($user, $managerId)) {
        json_out(['ok' => false, 'msg' => 'MANAGER_OUT_OF_SCOPE'], 403);
    }
}

// ── 列表 ──────────────────────────────────────────────────────
if ($action === 'list') {
    require_can($user, 'inbound', 'view');

    $page   = max(1, (int)($_GET['page']   ?? 1));
    $requestedLimit = (int)($_GET['limit'] ?? 20);
    $isExport = ($_GET['export'] ?? '') === '1';
    if ($isExport) {
        require_can($user, 'inbound', 'export');
        $limit = min(max($requestedLimit, 1), 10000);
    } else {
        $limit = in_array($requestedLimit, [20,50,100], true) ? $requestedLimit : 20;
    }
    $offset = ($page - 1) * $limit;

    $where  = ["p.deleted_at IS NULL", "p.source = 'inbound'"];
    $params = [];

    if ($v = trim($_GET['q']          ?? '')) {
        $where[] = "(p.name LIKE ? OR p.phone LIKE ? OR u.username LIKE ? OR p.tracking_number LIKE ? OR p.address LIKE ?)";
        array_push($params, "%$v%", "%$v%", "%$v%", "%$v%", "%$v%");
    }
    if ($v = trim($_GET['name']       ?? '')) { $where[] = "p.name LIKE ?";            $params[] = "%$v%"; }
    if ($v = trim($_GET['phone']      ?? '')) { $where[] = "p.phone LIKE ?";           $params[] = "%$v%"; }
    if ($v = trim($_GET['manager']    ?? '')) { $where[] = "u.username LIKE ?";        $params[] = "%$v%"; }
    if ($v = trim($_GET['courier_id'] ?? '')) { $where[] = "p.courier_id = ?";         $params[] = (int)$v; }
    if ($v = trim($_GET['date']       ?? '')) { $where[] = "DATE(p.created_at) = ?";   $params[] = $v; }
    if ($v = trim($_GET['date_start'] ?? '')) { $where[] = "DATE(p.created_at) >= ?";  $params[] = $v; }
    if ($v = trim($_GET['date_end']   ?? '')) { $where[] = "DATE(p.created_at) <= ?";  $params[] = $v; }
    if ($v = trim($_GET['status']     ?? '')) { $where[] = "p.status = ?";             $params[] = $v; }

    // 数据范围过滤（group / self）
    [$scopeWhere, $scopeParams] = data_scope_condition($user, 'inbound');
    if ($scopeWhere) { $where[] = $scopeWhere; $params = array_merge($params, $scopeParams); }

    $sql = "FROM parcels p
            LEFT JOIN couriers c ON c.id = p.courier_id AND c.deleted_at IS NULL
            LEFT JOIN users u    ON u.id = p.manager_id AND u.deleted_at IS NULL
            WHERE " . implode(' AND ', $where);

    $cstmt = db()->prepare("SELECT COUNT(*) $sql");
    $cstmt->execute($params);
    $total = (int)$cstmt->fetchColumn();

    $lstmt = db()->prepare("SELECT p.*, c.name AS courier_name, u.username AS manager_name $sql ORDER BY p.created_at DESC LIMIT ? OFFSET ?");
    $lstmt->execute(array_merge($params, [$limit, $offset]));
    $rows = $lstmt->fetchAll();

    $showPhone = can($user, 'inbound', 'phone') || can($user, 'parcels', 'phone');
    foreach ($rows as &$r) {
        if (!$showPhone) $r['phone'] = mask_phone($r['phone']);
        $r['images'] = json_decode($r['images'] ?? '[]', true);
    }

    json_out(['ok' => true, 'total' => $total, 'page' => $page, 'limit' => $limit, 'data' => $rows]);
}

// ── 新增入库单 ────────────────────────────────────────────────
if ($action === 'create') {
    method_must('POST');
    require_can($user, 'inbound', 'create');

    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $name = trim($body['name'] ?? '');
    if (!$name) json_out(['ok' => false, 'msg' => '姓名必填']);

    require_inbound_manager_assignment($user, $body);
    $managerId = !empty($body['manager_id']) ? (int)$body['manager_id'] : null;
    $isPrivileged = $user['role'] === 'admin' || in_array('*', $user['perms'] ?? [], true);
    if ($managerId === null && !$isPrivileged) {
        $scope = ($user['data_scopes'] ?? [])['inbound'] ?? 'global';
        if ($scope !== 'global') {
            $managerId = (int)$user['uid']; // 未指定时，非全局范围默认归属自己
        }
    }

    $images = json_encode(array_values((array)($body['images'] ?? [])), JSON_UNESCAPED_UNICODE);

    $stmt = db()->prepare("
        INSERT INTO parcels (source, name, phone, manager_id, category, courier_id, service_type, tracking_number, address, status, note, internal_note, images)
        VALUES ('inbound', ?, ?, ?, ?, ?, ?, ?, ?, 'pending-ship', ?, ?, ?)
    ");
    $stmt->execute([
        $name,
        trim($body['phone']        ?? ''),
        $managerId,
        trim($body['category']     ?? 'cn'),
        ($body['courier_id'] ?? '') ?: null,
        trim($body['service_type'] ?? '普通'),
        trim($body['tracking_number'] ?? ''),
        trim($body['address']      ?? ''),
        trim($body['note']         ?? ''),
        trim($body['internal_note'] ?? ''),
        $images,
    ]);
    $newId = (int)db()->lastInsertId();
    write_log($user, '新增', '入库单', $newId, $name);
    json_out(['ok' => true, 'id' => $newId]);
}

// ── 智能解析 ──────────────────────────────────────────────────
if ($action === 'parse') {
    method_must('POST');
    require_can($user, 'inbound', 'parse');

    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $text = trim($body['text'] ?? '');
    if (!$text) json_out(['ok' => false, 'msg' => '请传入文本']);

    $result = parse_express_text($text, $user);
    json_out(['ok' => true, 'data' => $result]);
}

// ── 编辑 ──────────────────────────────────────────────────────
if ($action === 'update') {
    method_must('POST');
    require_can($user, 'inbound', 'edit');

    $id   = (int)($_GET['id'] ?? 0);
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    require_inbound_manager_assignment($user, $body);

    $fields = [];
    $params = [];
    $allowed = ['name','phone','manager_id','category','courier_id','service_type','address','note','internal_note','status'];
    foreach ($allowed as $f) {
        if (array_key_exists($f, $body)) {
            $fields[] = "$f = ?";
            $params[] = in_array($f, ['manager_id','courier_id']) ? ($body[$f] ?: null) : trim((string)$body[$f]);
        }
    }
    if (array_key_exists('images', $body)) {
        $fields[] = "images = ?";
        $params[] = json_encode(array_values((array)$body['images']), JSON_UNESCAPED_UNICODE);
    }
    if (!$fields) json_out(['ok' => false, 'msg' => '无更新字段']);
    $fields[] = "updated_at = datetime('now','localtime')";
    $params[] = $id;

    db()->prepare("UPDATE parcels SET " . implode(', ', $fields) . " WHERE id = ? AND deleted_at IS NULL AND source = 'inbound'")->execute($params);
    $s = db()->prepare("SELECT name FROM parcels WHERE id = ? LIMIT 1"); $s->execute([$id]);
    write_log($user, '编辑', '入库单', $id, (string)($s->fetchColumn() ?? ''));
    json_out(['ok' => true]);
}

// ── 软删除 ────────────────────────────────────────────────────
if ($action === 'delete') {
    method_must('POST');
    require_can($user, 'inbound', 'delete');

    $id = (int)($_GET['id'] ?? 0);
    $s = db()->prepare("SELECT name FROM parcels WHERE id = ? LIMIT 1"); $s->execute([$id]);
    $recName = (string)($s->fetchColumn() ?? '');
    db()->prepare("UPDATE parcels SET deleted_at = datetime('now','localtime') WHERE id = ? AND source = 'inbound' AND deleted_at IS NULL")->execute([$id]);
    write_log($user, '删除', '入库单', $id, $recName);
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => '未知操作'], 400);
