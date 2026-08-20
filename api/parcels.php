<?php
/**
 * parcels.php — 快递管理 + 前台查询
 *
 * GET  ?action=query&q=         前台查询（无需登录，手机号脱敏）
 * GET  ?action=list             后台列表（分页+筛选）
 * POST ?action=create           新增
 * POST ?action=update&id=       编辑
 * POST ?action=delete&id=       软删除
 * GET  ?action=export           导出 CSV
 * POST ?action=smart_parse      智能解析文本
 */

require_once __DIR__ . '/session_boot.php';
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

// ══ 辅助函数（被 inbound.php require_once 时始终可用）═════════

function trim_address_business_tail(string $value): string {
    $value = trim(preg_replace('/\s+/u', ' ', $value));
    if ($value === '') return '';
    $pattern = '/(快递数量|快递数|包裹数量|负责人|卡张数|天数|客户备注|内部备注|备注|快递公司|服务类型|快递单号|物流单号|单号|物流|通知|(?:普通|特快|顺丰|EMS|圆通|中通|申通|韵达|极兔|京东|德邦|邮政)\s*\d+)/u';
    // 用 preg_split 取匹配点之前的部分，避免 PREG_OFFSET_CAPTURE 返回字节偏移量
    // 但 mb_substr 按字符计数导致的错位（中文文本下会截断错误甚至完全不截断）。
    $parts = preg_split($pattern, $value, 2);
    if (isset($parts[0]) && mb_strlen($parts[0], 'UTF-8') >= 4) {
        $value = $parts[0];
    }
    return trim(preg_replace('/[，,、;；:+＋\s]+$/u', '', $value));
}

function parse_express_text(string $text, array $user): array {
    $out = [
        'name'         => '',
        'phone'        => '',
        'address'      => '',
        'manager_id'   => null,
        'manager_name' => '',
        'service_type' => '普通',
        'courier_id'   => null,
        'courier_name' => '',
        'note_append'  => $text,
        'auto_created' => null,
    ];

    $lines = preg_split('/[\n\r]+/', $text);
    $region = '';
    $detail = '';

    foreach ($lines as $line) {
        $line = trim($line);
        if (!$line) continue;

        // 地址：支持"地址"单字段，也支持"所在地区"+"详细地址"两段式（不 continue：
        // 同一行可能还带手机号/负责人/快递公司等其它字段，尤其是逗号分隔的单行粘贴文本）
        // (?<!详细) 防止"详细地址"里的"地址"被当成独立的单字段地址标签命中，
        // 抢在下面的两段式拼接逻辑之前把 $out['address'] 占掉，导致"所在地区"部分丢失。
        if (preg_match('/(?:邮寄地址|收件地址|(?<!详细)地址)[：:]\s*(.+)/u', $line, $m)) {
            $out['address'] = trim_address_business_tail($m[1]);
        }
        if (preg_match('/所在地区[：:]\s*(.+)/u', $line, $m)) {
            $region = trim_address_business_tail($m[1]);
        }
        if (preg_match('/详细地址[：:]\s*(.+)/u', $line, $m)) {
            $detail = trim_address_business_tail($m[1]);
        }
        // 电话/手机（含"手机号码""联系电话"等变体标签）
        if (preg_match('/(?:手机号码|手机号|联系电话|联系方式|电话|手机)[：:]\s*([0-9\-\s]{7,20})/u', $line, $m)) {
            $out['phone'] = preg_replace('/[\s\-]/', '', $m[1]);
        }
        // 无标签手机号（11位中国手机）
        if (empty($out['phone']) && preg_match('/\b(1[3-9]\d{9})\b/', $line, $m)) {
            $out['phone'] = $m[1];
        }
        // 姓名
        if (preg_match('/(?:姓名|收件人)[：:\s]\s*([\x{4e00}-\x{9fa5}a-zA-Z]{2,10})/u', $line, $m)) {
            $out['name'] = trim($m[1]);
        }
        // 负责人（按空格/中英文逗号顿号分号切first token，避免把同一行里后面的快递公司/备注也吞进用户名——
        // 之前只按空格 explode 会把"负责人：admin，中通"整段当成用户名，静默建出垃圾账号）
        if (preg_match('/负责人[：:]\s*(.{1,20})/u', $line, $m)) {
            $mgr_name = trim(preg_replace('/[\s，,。.]+$/u', '', $m[1]));
            $mgr_name = mb_substr(preg_split('/[\s，,、；;]+/u', $mgr_name)[0], 0, 20);
            $mgr = resolve_manager($mgr_name, $user);
            $out['manager_id']   = $mgr['id'];
            $out['manager_name'] = $mgr['name'];
            if ($mgr['created']) $out['auto_created'] = $mgr['name'];
        }
        // 服务类型关键词检测
        $st = detect_service_type($line);
        if ($st && $out['service_type'] === '普通') $out['service_type'] = $st;
        // 快递公司关键词检测
        if (!$out['courier_id']) {
            $cr = detect_courier($line);
            if ($cr) {
                $out['courier_id']   = $cr['id'];
                $out['courier_name'] = $cr['name'];
            }
        }
    }

    // 所在地区 + 详细地址 两段式：只有在没有命中单字段"地址"标签时才拼接使用
    if (!$out['address'] && ($region !== '' || $detail !== '')) {
        $out['address'] = trim_address_business_tail($region . $detail);
    }

    // 如果没解析到姓名，尝试无标签中文短词
    if (!$out['address'] && preg_match('/((?:北京市|天津市|上海市|重庆市|[\x{4e00}-\x{9fa5}]{2,}(?:省|自治区|特别行政区)).+)/u', $text, $m)) {
        $out['address'] = trim_address_business_tail($m[1]);
    }

    if (!$out['name']) {
        if (preg_match_all('/[\x{4e00}-\x{9fa5}]{2,4}/u', $text, $m)) {
            $keywords = ['邮寄','地址','电话','手机','姓名','负责人','快递','数量','普通','特快','标快'];
            foreach ($m[0] as $w) {
                if (preg_match('/(省|市|区|县|镇|乡|村|路|街|号|园|快递|数量|普通|特快|顺丰|负责人|通讯社)/u', $w)) continue;
                if (!in_array($w, $keywords, true)) {
                    $out['name'] = $w;
                    break;
                }
            }
        }
    }

    return $out;
}

function detect_service_type(string $text): string {
    $map = [
        '半日达' => '半日达', '即日'   => '即日专递', '特快'  => '特快',
        '标快'   => '标快',   '次日'   => '标快',     '飞快'  => '飞快',
        '好快'   => '好快',   '优先'   => '优先',     '经济'  => '经济',
        '普通'   => '普通',   '一般'   => '普通',
    ];
    foreach ($map as $kw => $type) {
        if (mb_strpos($text, $kw) !== false) return $type;
    }
    return '';
}

function detect_courier(string $text): ?array {
    $keywords = [
        '顺丰' => '顺丰速运', '京东' => '京东快递', 'EMS' => 'EMS中国邮政',
        '邮政' => 'EMS中国邮政', '德邦' => '德邦快递', '圆通' => '圆通速递',
        '中通' => '中通快递', '韵达' => '韵达速递', '申通' => '申通快递',
        '极兔' => '极兔速递', '菜鸟' => '菜鸟速递',
        'CJ'   => 'CJ대한통운', '한진' => '한진택배', '롯데' => '롯데택배',
        '우체국' => '우체국택배',
    ];
    foreach ($keywords as $kw => $name) {
        if (mb_stripos($text, $kw) !== false) {
            $stmt = db()->prepare("SELECT id, name FROM couriers WHERE name = ? AND deleted_at IS NULL LIMIT 1");
            $stmt->execute([$name]);
            $row = $stmt->fetch();
            if ($row) return $row;
        }
    }
    return null;
}

function resolve_manager(string $name, array $user): array {
    $stmt = db()->prepare("SELECT id, username FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1");
    $stmt->execute([$name]);
    $row = $stmt->fetch();
    if ($row) return ['id' => $row['id'], 'name' => $row['username'], 'created' => false];

    // 自动创建查看员账号
    $hash = password_hash('glo2026', PASSWORD_BCRYPT);
    $g = db()->prepare("SELECT id FROM groups WHERE name LIKE '%查看员%' LIMIT 1");
    $g->execute();
    $group = $g->fetch();
    $gid = $group ? $group['id'] : null;

    $ins = db()->prepare("INSERT INTO users (username, password, role, group_id) VALUES (?, ?, 'viewer', ?)");
    $ins->execute([$name, $hash, $gid]);
    $new_id = db()->lastInsertId();
    return ['id' => $new_id, 'name' => $name, 'created' => true];
}

// ══ 路由（仅直接请求 parcels.php 时执行）═════════════════════

if (basename($_SERVER['SCRIPT_FILENAME']) !== 'parcels.php') return;

maybe_gc();

$action = $_GET['action'] ?? $_POST['action'] ?? '';

function escape_like_query(string $value): string {
    return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $value);
}

// ── 前台查询（公开，无需登录）─────────────────────────────────
if ($action === 'query') {
    $type = trim($_GET['type'] ?? '');
    $q = trim($_GET['q'] ?? '');
    $name = trim($_GET['name'] ?? '');
    $phone = trim($_GET['phone'] ?? '');

    $where = ["p.deleted_at IS NULL"];
    $params = [];

    if ($type === 'tracking') {
        if (strlen($q) < 4) {
            json_out(['ok' => false, 'msg' => 'Tracking number is too short']);
        }
        $where[] = "p.tracking_number = ?";
        $params[] = $q;
    } elseif ($type === 'name' || $name !== '' || strpos($q, '|') !== false) {
        if ($name === '' && strpos($q, '|') !== false) {
            [$name, $phone] = array_pad(explode('|', $q, 2), 2, '');
            $name = trim($name);
            $phone = trim($phone);
        } elseif ($name === '') {
            $name = $q;
        }

        if (mb_strlen($name) < 2) {
            json_out(['ok' => false, 'msg' => 'Name is too short']);
        }
        $where[] = "p.name LIKE ? ESCAPE '\\'";
        $params[] = '%' . escape_like_query($name) . '%';

        if ($phone !== '') {
            $tail = substr(preg_replace('/\D+/', '', $phone), -4);
            if (strlen($tail) < 4) {
                json_out(['ok' => false, 'msg' => 'Phone tail must be 4 digits']);
            }
            $where[] = "substr(p.phone, -4) = ?";
            $params[] = $tail;
        }
    } else {
        if (strlen($q) < 2) {
            json_out(['ok' => false, 'msg' => 'Query is too short']);
        }
        $where[] = "p.name LIKE ? ESCAPE '\\'";
        $params[] = '%' . escape_like_query($q) . '%';
    }

    // 前台查快递不需要登录，客户很可能短时间内对同一个单号/姓名重复点查询（网络
    // 波动重试、切到别的 App 又切回来），缓存 45 秒——这个输出跟谁在查无关（手机号
    // 已经在下面统一脱敏，不存在"缓存了别人能看到的完整手机号"这种权限泄漏问题），
    // 缓存 key 按实际用到的查询条件（where 子句 + 参数）算，条件不同天然不会撞。
    $cacheKey = 'parcels:query:' . md5(implode('|', $where) . '::' . implode('|', $params));
    $rows = cache_remember($cacheKey, 45, function () use ($where, $params) {
        $stmt = db()->prepare("
            SELECT p.id, p.name, p.phone, p.courier_id, p.service_type, p.tracking_number,
                   p.address, p.status, p.note, p.images, p.created_at,
                   c.name AS courier_name, u.username AS manager_name
            FROM parcels p
            LEFT JOIN couriers c ON c.id = p.courier_id AND c.deleted_at IS NULL
            LEFT JOIN users u    ON u.id = p.manager_id AND u.deleted_at IS NULL
            WHERE " . implode(' AND ', $where) . "
            ORDER BY p.created_at DESC
            LIMIT 50
        ");
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        foreach ($rows as &$r) {
            $r['phone']  = mask_phone($r['phone']);
            $r['images'] = json_decode($r['images'] ?? '[]', true);
        }
        return $rows;
    });
    json_out(['ok' => true, 'data' => $rows]);

    $q = trim($_GET['q'] ?? '');
    if (strlen($q) < 2) {
        json_out(['ok' => false, 'msg' => '请输入姓名或手机号']);
    }

    $stmt = db()->prepare("
        SELECT p.*, c.name AS courier_name, u.username AS manager_name
        FROM parcels p
        LEFT JOIN couriers c ON c.id = p.courier_id AND c.deleted_at IS NULL
        LEFT JOIN users u    ON u.id = p.manager_id AND u.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
          AND (p.name LIKE ? OR p.phone = ?)
        ORDER BY p.created_at DESC
        LIMIT 50
    ");
    $stmt->execute(['%' . $q . '%', $q]);
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['phone']  = mask_phone($r['phone']);
        $r['images'] = json_decode($r['images'] ?? '[]', true);
    }
    json_out(['ok' => true, 'data' => $rows]);
}

// ── 以下需要登录 ───────────────────────────────────────────────
$user = require_auth();

// ── 列表 ──────────────────────────────────────────────────────
if ($action === 'list') {
    require_can($user, 'parcels', 'view');

    $page   = max(1, (int)($_GET['page']   ?? 1));
    $limit  = in_array((int)($_GET['limit'] ?? 20), [20, 50, 100]) ? (int)$_GET['limit'] : 20;
    $offset = ($page - 1) * $limit;

    $where  = ["p.deleted_at IS NULL", "p.source = 'manual'"];
    $params = [];

    if ($v = trim($_GET['name']    ?? '')) { $where[] = "p.name LIKE ?";     $params[] = "%$v%"; }
    if ($v = trim($_GET['manager'] ?? '')) { $where[] = "u.username LIKE ?"; $params[] = "%$v%"; }
    if ($v = trim($_GET['status']  ?? '')) { $where[] = "p.status = ?";      $params[] = $v; }
    if ($v = trim($_GET['category']?? '')) { $where[] = "p.category = ?";    $params[] = $v; }
    if ($v = trim($_GET['start']   ?? '')) { $where[] = "DATE(p.created_at) >= ?"; $params[] = $v; }
    if ($v = trim($_GET['end']     ?? '')) { $where[] = "DATE(p.created_at) <= ?"; $params[] = $v; }

    // 数据范围过滤（group / self）
    [$scopeWhere, $scopeParams] = data_scope_condition($user, 'parcels');
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

// ── 新增 ──────────────────────────────────────────────────────
if ($action === 'create') {
    method_must('POST');
    require_can($user, 'parcels', 'create');

    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $name = trim($body['name'] ?? '');
    if (!$name) json_out(['ok' => false, 'msg' => '姓名必填']);

    $stmt = db()->prepare("
        INSERT INTO parcels (source, name, phone, manager_id, category, courier_id, service_type,
                             tracking_number, address, status, note, internal_note)
        VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ");
    $stmt->execute([
        $name,
        trim($body['phone']           ?? ''),
        ($body['manager_id'] ?? '')   ?: null,
        trim($body['category']        ?? 'cn'),
        ($body['courier_id'] ?? '')   ?: null,
        trim($body['service_type']    ?? '普通'),
        trim($body['tracking_number'] ?? ''),
        trim($body['address']         ?? ''),
        trim($body['status']          ?? 'not-arrived'),
        trim($body['note']            ?? ''),
        trim($body['internal_note']   ?? ''),
    ]);
    json_out(['ok' => true, 'id' => db()->lastInsertId()]);
}

// ── 编辑 ──────────────────────────────────────────────────────
if ($action === 'update') {
    method_must('POST');
    require_can($user, 'parcels', 'edit');

    $id   = (int)($_GET['id'] ?? 0);
    $body = json_decode(file_get_contents('php://input'), true) ?? [];

    $fields = [];
    $params = [];
    $allowed = ['name','phone','manager_id','category','courier_id','service_type',
                'tracking_number','address','status','note','internal_note'];
    foreach ($allowed as $f) {
        if (array_key_exists($f, $body)) {
            $fields[] = "$f = ?";
            $params[] = $f === 'manager_id' || $f === 'courier_id'
                        ? ($body[$f] ?: null)
                        : trim((string)$body[$f]);
        }
    }
    if (!$fields) json_out(['ok' => false, 'msg' => '无更新字段']);

    $fields[] = "updated_at = datetime('now','localtime')";
    $params[] = $id;

    db()->prepare("UPDATE parcels SET " . implode(', ', $fields) . " WHERE id = ? AND deleted_at IS NULL")->execute($params);
    json_out(['ok' => true]);
}

// ── 软删除 ────────────────────────────────────────────────────
if ($action === 'delete') {
    method_must('POST');
    require_can($user, 'parcels', 'delete');

    $id = (int)($_GET['id'] ?? 0);
    db()->prepare("UPDATE parcels SET deleted_at = datetime('now','localtime') WHERE id = ? AND deleted_at IS NULL")->execute([$id]);
    json_out(['ok' => true]);
}

// ── 导出 CSV ──────────────────────────────────────────────────
if ($action === 'export') {
    require_can($user, 'parcels', 'export');
    $showPhone = can($user, 'parcels', 'phone');

    $stmt = db()->prepare("
        SELECT p.*, c.name AS courier_name, u.username AS manager_name
        FROM parcels p
        LEFT JOIN couriers c ON c.id = p.courier_id AND c.deleted_at IS NULL
        LEFT JOIN users u    ON u.id = p.manager_id AND u.deleted_at IS NULL
        WHERE p.deleted_at IS NULL AND p.source = 'manual'
        ORDER BY p.created_at DESC
    ");
    $stmt->execute();
    $rows = $stmt->fetchAll();

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="parcels_' . date('Ymd_His') . '.csv"');
    echo "\xEF\xBB\xBF"; // BOM for Excel

    $out = fopen('php://output', 'w');
    fputcsv($out, ['录入时间','姓名','手机号','负责人','分类','快递公司','服务类型','快递单号','状态','地址','客户可见备注','内部备注']);
    foreach ($rows as $r) {
        fputcsv($out, [
            $r['created_at'],
            $r['name'],
            $showPhone ? $r['phone'] : mask_phone($r['phone']),
            $r['manager_name'] ?? '',
            $r['category'] === 'cn' ? '中国快递' : '韩国快递',
            $r['courier_name'] ?? '',
            $r['service_type'] ?? '',
            $r['tracking_number'] ?? '',
            $r['status'] ?? '',
            $r['address'] ?? '',
            $r['note'] ?? '',
            $r['internal_note'] ?? '',
        ]);
    }
    fclose($out);
    exit;
}

// ── 智能解析 ──────────────────────────────────────────────────
if ($action === 'smart_parse') {
    method_must('POST');
    require_can($user, 'parcels', 'create');

    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $text = trim($body['text'] ?? '');
    if (!$text) json_out(['ok' => false, 'msg' => '请传入文本']);

    $result = parse_express_text($text, $user);
    json_out(['ok' => true, 'data' => $result]);
}

json_out(['ok' => false, 'msg' => '未知操作'], 400);
