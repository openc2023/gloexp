<?php
/**
 * outbound.php — 填单号 / 出库
 *
 * GET  ?action=list              分页列表（pending-ship + shipped）
 * POST ?action=fill&id=          填写单号+图片（pending-ship → shipped）
 * POST ?action=update&id=        补改单号/图片（已邮寄也可改）
 * POST ?action=delete&id=        软删除
 */

require_once __DIR__ . '/session_boot.php';
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$user   = require_auth();

function outbound_record_for_user(array $user, int $id): array {
    $where = ["p.id = ?", "p.source = 'inbound'", "p.deleted_at IS NULL"];
    $params = [$id];
    [$scopeWhere, $scopeParams] = data_scope_condition($user, 'outbound');
    if ($scopeWhere) {
        $where[] = $scopeWhere;
        $params = array_merge($params, $scopeParams);
    }

    $stmt = db()->prepare("SELECT p.id, p.name, p.manager_id, p.tracking_number FROM parcels p WHERE " . implode(' AND ', $where) . " LIMIT 1");
    $stmt->execute($params);
    $row = $stmt->fetch();
    if (!$row) {
        json_out(['ok' => false, 'msg' => 'NO_ACCESS_OR_NOT_FOUND'], 403);
    }
    return $row;
}

function manager_allowed_in_outbound_scope(array $user, ?int $managerId): bool {
    if ($user['role'] === 'admin' || in_array('*', $user['perms'] ?? [], true)) {
        return true;
    }

    $scope = ($user['data_scopes'] ?? [])['outbound'] ?? 'global';
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

function require_outbound_manager_assignment(array $user, array $body): void {
    if (!array_key_exists('manager_id', $body)) {
        return;
    }
    $managerId = !empty($body['manager_id']) ? (int)$body['manager_id'] : null;
    if (!manager_allowed_in_outbound_scope($user, $managerId)) {
        json_out(['ok' => false, 'msg' => 'MANAGER_OUT_OF_SCOPE'], 403);
    }
}

function outbound_tracking_duplicate(string $tracking, int $excludeId = 0): ?array {
    $tracking = trim($tracking);
    if ($tracking === '') return null;
    $sql = "SELECT p.id, p.tracking_number, p.status, c.name AS courier_name
            FROM parcels p
            LEFT JOIN couriers c ON c.id = p.courier_id AND c.deleted_at IS NULL
            WHERE p.deleted_at IS NULL
              AND TRIM(p.tracking_number) <> ''
              AND UPPER(TRIM(p.tracking_number)) = UPPER(?)";
    $params = [$tracking];
    if ($excludeId > 0) {
        $sql .= " AND p.id <> ?";
        $params[] = $excludeId;
    }
    $sql .= " ORDER BY p.id ASC LIMIT 1";
    $stmt = db()->prepare($sql);
    $stmt->execute($params);
    $row = $stmt->fetch();
    return $row ?: null;
}

if ($action === 'check_tracking') {
    require_can($user, 'parcels', 'edit');
    $tracking = trim((string)($_GET['tracking'] ?? ''));
    if ($tracking === '') json_out(['ok' => false, 'msg' => '快递单号不能为空']);
    $duplicate = outbound_tracking_duplicate($tracking, (int)($_GET['exclude_id'] ?? 0));
    json_out(['ok' => true, 'exists' => $duplicate !== null, 'data' => $duplicate]);
}

// ── 列表（待邮寄 + 已邮寄）───────────────────────────────────
if ($action === 'list') {
    require_can($user, 'parcels', 'view');

    $page   = max(1, (int)($_GET['page']  ?? 1));
    $requestedLimit = (int)($_GET['limit'] ?? 20);
    $isExport = ($_GET['export'] ?? '') === '1';
    if ($isExport) {
        require_can($user, 'parcels', 'export');
        $limit = min(max($requestedLimit, 1), 10000);
    } else {
        $limit = in_array($requestedLimit, [20,50,100], true) ? $requestedLimit : 20;
    }
    $offset = ($page - 1) * $limit;

    $where  = ["p.deleted_at IS NULL", "p.source = 'inbound'", "p.status IN ('pending-ship','shipped','exception')"];
    $params = [];

    if ($v = trim($_GET['q']          ?? '')) {
        $where[] = "(p.name LIKE ? OR p.phone LIKE ? OR u.username LIKE ? OR p.tracking_number LIKE ? OR p.address LIKE ?)";
        array_push($params, "%$v%", "%$v%", "%$v%", "%$v%", "%$v%");
    }
    if ($v = trim($_GET['name']       ?? '')) { $where[] = "p.name LIKE ?";           $params[] = "%$v%"; }
    if ($v = trim($_GET['phone']      ?? '')) { $where[] = "p.phone LIKE ?";          $params[] = "%$v%"; }
    if ($v = trim($_GET['manager']    ?? '')) { $where[] = "u.username LIKE ?";       $params[] = "%$v%"; }
    if ($v = trim($_GET['courier_id'] ?? '')) { $where[] = "p.courier_id = ?";        $params[] = (int)$v; }
    if ($v = trim($_GET['status']     ?? '')) { $where[] = "p.status = ?";            $params[] = $v; }
    if ($v = trim($_GET['date']       ?? '')) { $where[] = "DATE(p.created_at) = ?";  $params[] = $v; }
    if ($v = trim($_GET['date_start'] ?? '')) { $where[] = "DATE(p.created_at) >= ?"; $params[] = $v; }
    if ($v = trim($_GET['date_end']   ?? '')) { $where[] = "DATE(p.created_at) <= ?"; $params[] = $v; }

    // 数据范围过滤（group / self）
    [$scopeWhere, $scopeParams] = data_scope_condition($user, 'outbound');
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

    $showPhone = can($user, 'parcels', 'phone');
    foreach ($rows as &$r) {
        if (!$showPhone) $r['phone'] = mask_phone($r['phone']);
        $r['images'] = json_decode($r['images'] ?? '[]', true);
    }

    json_out(['ok' => true, 'total' => $total, 'page' => $page, 'limit' => $limit, 'data' => $rows]);
}

// ── 填单号（首次出库）─────────────────────────────────────────
if ($action === 'fill') {
    method_must('POST');
    require_can($user, 'parcels', 'edit');

    $id   = (int)($_GET['id'] ?? 0);
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $record = outbound_record_for_user($user, $id);
    require_outbound_manager_assignment($user, $body);
    $tracking = trim($body['tracking_number'] ?? '');
    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') json_out(['ok' => false, 'msg' => '客户姓名不能为空']);
    if (!$tracking) json_out(['ok' => false, 'msg' => '快递单号不能为空']);
    if ($duplicate = outbound_tracking_duplicate($tracking, $id)) {
        json_out(['ok' => false, 'msg' => '这个快递单号已经录入', 'duplicate' => $duplicate], 409);
    }

    $phone = trim((string)($body['phone'] ?? ''));
    $managerId = !empty($body['manager_id']) ? (int)$body['manager_id'] : null;
    $category = in_array(($body['category'] ?? 'cn'), ['cn', 'kr'], true) ? $body['category'] : 'cn';
    $courierId = !empty($body['courier_id']) ? (int)$body['courier_id'] : null;
    $serviceType = trim((string)($body['service_type'] ?? '普通'));
    $address = trim((string)($body['address'] ?? ''));
    $note = trim((string)($body['note'] ?? ''));
    $internalNote = trim((string)($body['internal_note'] ?? ''));
    $images = json_encode(array_values((array)($body['images'] ?? [])), JSON_UNESCAPED_UNICODE);

    db()->prepare("
        UPDATE parcels
        SET name = ?,
            phone = ?,
            manager_id = ?,
            category = ?,
            courier_id = ?,
            service_type = ?,
            tracking_number = ?,
            address = ?,
            status = 'shipped',
            note = ?,
            internal_note = ?,
            images = ?,
            updated_at = datetime('now','localtime')
        WHERE id = ? AND source = 'inbound' AND deleted_at IS NULL
    ")->execute([
        $name, $phone, $managerId, $category, $courierId, $serviceType,
        $tracking, $address, $note, $internalNote, $images, $id
    ]);
    write_log($user, '出库', '快递管理', $id, $name ?: (string)($record['name'] ?? ''), '单号：' . $tracking);
    json_out(['ok' => true]);
    if (!$tracking) json_out(['ok' => false, 'msg' => '快递单号必填']);

    $images = json_encode($body['images'] ?? [], JSON_UNESCAPED_UNICODE);

    $s = db()->prepare("SELECT name FROM parcels WHERE id = ? LIMIT 1"); $s->execute([$id]);
    $recName = (string)($s->fetchColumn() ?? '');
    db()->prepare("
        UPDATE parcels
        SET tracking_number = ?,
            images  = ?,
            status  = 'shipped',
            updated_at = datetime('now','localtime')
        WHERE id = ? AND source = 'inbound' AND deleted_at IS NULL
    ")->execute([$tracking, $images, $id]);
    write_log($user, '填单号', '填单号', $id, $recName, '单号：' . $tracking);
    json_out(['ok' => true]);
}

// ── 补改单号/图片 ─────────────────────────────────────────────
if ($action === 'update') {
    method_must('POST');
    require_can($user, 'parcels', 'edit');

    $id   = (int)($_GET['id'] ?? 0);
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $record = outbound_record_for_user($user, $id);
    require_outbound_manager_assignment($user, $body);

    // 单号可能不在这次请求体里（比如批量改状态只传 status），这种情况要看记录当前
    // 已经存的单号，不能一概而论地当成"没填"——不然像批量改状态这类只改单个字段的
    // 调用，会被这条校验误伤（明明数据库里已经有单号了）。
    if (array_key_exists('status', $body) && $body['status'] === 'shipped') {
        $effectiveTracking = array_key_exists('tracking_number', $body)
            ? trim((string)$body['tracking_number'])
            : trim((string)($record['tracking_number'] ?? ''));
        if ($effectiveTracking === '') {
            json_out(['ok' => false, 'msg' => '已邮寄状态需要填写快递单号']);
        }
    }
    if (array_key_exists('name', $body) && trim((string)$body['name']) === '') {
        json_out(['ok' => false, 'msg' => '客户姓名不能为空']);
    }
    if (array_key_exists('tracking_number', $body)) {
        $newTracking = trim((string)$body['tracking_number']);
        if ($newTracking !== '' && ($duplicate = outbound_tracking_duplicate($newTracking, $id))) {
            json_out(['ok' => false, 'msg' => '这个快递单号已经录入', 'duplicate' => $duplicate], 409);
        }
    }

    $fields = [];
    $params = [];
    $allowed = ['name','phone','manager_id','category','courier_id','service_type','tracking_number','address','status','note','internal_note'];
    foreach ($allowed as $f) {
        if (!array_key_exists($f, $body)) continue;
        if ($f === 'status' && !in_array($body[$f], ['pending-ship', 'shipped', 'exception'], true)) continue;
        if ($f === 'category' && !in_array($body[$f], ['cn', 'kr'], true)) continue;
        $fields[] = "$f = ?";
        if (in_array($f, ['manager_id','courier_id'], true)) {
            $params[] = $body[$f] ? (int)$body[$f] : null;
        } else {
            $params[] = trim((string)$body[$f]);
        }
    }
    if (array_key_exists('images', $body)) {
        $fields[] = "images = ?";
        $params[] = json_encode(array_values((array)$body['images']), JSON_UNESCAPED_UNICODE);
    }
    if (!$fields) json_out(['ok' => false, 'msg' => '没有可更新的内容']);

    $fields[] = "updated_at = datetime('now','localtime')";
    $params[] = $id;

    db()->prepare("UPDATE parcels SET " . implode(', ', $fields) . " WHERE id = ? AND source = 'inbound' AND deleted_at IS NULL")->execute($params);
    $s = db()->prepare("SELECT name FROM parcels WHERE id = ? LIMIT 1"); $s->execute([$id]);
    write_log($user, '编辑', '快递管理', $id, (string)($s->fetchColumn() ?: ($record['name'] ?? '')));
    json_out(['ok' => true]);

    $fields = [];
    $params = [];

    if (array_key_exists('tracking_number', $body)) {
        $fields[] = "tracking_number = ?";
        $params[] = trim($body['tracking_number']);
    }
    if (array_key_exists('images', $body)) {
        $fields[] = "images = ?";
        $params[] = json_encode($body['images'], JSON_UNESCAPED_UNICODE);
    }
    if (!$fields) json_out(['ok' => false, 'msg' => '无更新字段']);

    $fields[] = "updated_at = datetime('now','localtime')";
    $params[] = $id;

    db()->prepare("UPDATE parcels SET " . implode(', ', $fields) . " WHERE id = ? AND source = 'inbound' AND deleted_at IS NULL")->execute($params);
    $s = db()->prepare("SELECT name FROM parcels WHERE id = ? LIMIT 1"); $s->execute([$id]);
    write_log($user, '修改单号', '填单号', $id, (string)($s->fetchColumn() ?? ''));
    json_out(['ok' => true]);
}

// ── 软删除 ────────────────────────────────────────────────────
if ($action === 'delete') {
    method_must('POST');
    require_can($user, 'parcels', 'delete');

    $id = (int)($_GET['id'] ?? 0);
    $record = outbound_record_for_user($user, $id);
    $recName = (string)($record['name'] ?? '');
    db()->prepare("UPDATE parcels SET deleted_at = datetime('now','localtime') WHERE id = ? AND source = 'inbound' AND deleted_at IS NULL")->execute([$id]);
    write_log($user, '删除', '填单号', $id, $recName);
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => '未知操作'], 400);
