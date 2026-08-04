<?php
/**
 * install.php — 系统初始化向导
 * 完成后请删除此文件
 */

define('DB_PATH', __DIR__ . '/data/express.db');
define('UPLOADS_PATH', __DIR__ . '/uploads');

$error = '';
$success = false;
$step = 1;

// 已安装检测
if (file_exists(DB_PATH)) {
    try {
        $pdo = new PDO('sqlite:' . DB_PATH);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $check = $pdo->query("SELECT COUNT(*) FROM users")->fetchColumn();
        if ((int)$check > 0) {
            header('Location: admin.html');
            exit;
        }
    } catch (Throwable $e) {
        // Treat a partial/corrupt database as not installed so the wizard can repair it.
    }
}

// 环境检测
$envOk = true;
$envChecks = [];

// PHP 版本
$phpOk = version_compare(PHP_VERSION, '7.4', '>=');
$envChecks[] = ['label' => 'PHP 版本 (需 ≥ 7.4)', 'ok' => $phpOk, 'value' => PHP_VERSION];

// PDO SQLite
$sqliteOk = extension_loaded('pdo_sqlite');
$envChecks[] = ['label' => 'PDO SQLite 扩展', 'ok' => $sqliteOk, 'value' => $sqliteOk ? '已启用' : '未启用'];

// data 目录写权限
$dataDir = __DIR__ . '/data';
if (!is_dir($dataDir)) @mkdir($dataDir, 0755, true);
$dataWritable = is_writable($dataDir);
$envChecks[] = ['label' => 'data/ 目录写权限', 'ok' => $dataWritable, 'value' => $dataWritable ? '可写' : '不可写'];

// uploads 目录写权限
if (!is_dir(UPLOADS_PATH)) @mkdir(UPLOADS_PATH, 0755, true);
$uploadsWritable = is_writable(UPLOADS_PATH);
$envChecks[] = ['label' => 'uploads/ 目录写权限', 'ok' => $uploadsWritable, 'value' => $uploadsWritable ? '可写' : '不可写'];

foreach ($envChecks as $c) { if (!$c['ok']) $envOk = false; }

// 处理安装表单
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'install') {
    $username = trim($_POST['username'] ?? '');
    $password = trim($_POST['password'] ?? '');
    $confirm  = trim($_POST['confirm'] ?? '');

    if (!$envOk) {
        $error = '环境检测未通过，无法安装';
    } elseif (strlen($username) < 2) {
        $error = '账号至少 2 个字符';
    } elseif (strlen($password) < 6) {
        $error = '密码至少 6 位';
    } elseif ($password !== $confirm) {
        $error = '两次密码不一致';
    } else {
        try {
            $pdo = new PDO('sqlite:' . DB_PATH);
            $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $pdo->exec('PRAGMA journal_mode=WAL;');
            $pdo->exec('PRAGMA foreign_keys=ON;');

            // ── 建表 ──────────────────────────────────────────────
            $pdo->exec("
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer',
  group_id   INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  data_scopes TEXT NOT NULL DEFAULT '{\"inbound\":\"group\",\"outbound\":\"group\",\"parcels\":\"group\"}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS couriers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  tracking_url  TEXT DEFAULT '',
  service_types TEXT NOT NULL DEFAULT '[\"普通\"]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS parcels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL DEFAULT 'manual',
  name            TEXT NOT NULL,
  phone           TEXT DEFAULT '',
  manager_id      INTEGER,
  category        TEXT DEFAULT 'cn',
  courier_id      INTEGER,
  service_type    TEXT DEFAULT '普通',
  tracking_number TEXT DEFAULT '',
  address         TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'not-arrived',
  note            TEXT DEFAULT '',
  internal_note   TEXT DEFAULT '',
  images          TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT,
  deleted_at      TEXT
);
            ");

            // ── 默认权限组 ─────────────────────────────────────────
            $pdo->exec("
CREATE INDEX IF NOT EXISTS idx_parcels_list ON parcels (deleted_at, source, status, created_at);
CREATE INDEX IF NOT EXISTS idx_parcels_manager ON parcels (manager_id, deleted_at, created_at);
CREATE INDEX IF NOT EXISTS idx_parcels_courier ON parcels (courier_id);
CREATE INDEX IF NOT EXISTS idx_parcels_phone ON parcels (phone);
CREATE INDEX IF NOT EXISTS idx_parcels_tracking ON parcels (tracking_number);
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users (deleted_at);
CREATE INDEX IF NOT EXISTS idx_users_group ON users (group_id);
            ");

            $adminPerms = json_encode([
                'p_parcels','p_parcels_add','p_parcels_edit','p_parcels_delete','p_parcels_phone',
                'p_inbound','p_inbound_add','p_inbound_edit','p_inbound_delete','p_inbound_parse','p_inbound_phone','p_inbound_export',
                'p_outbound','p_outbound_edit','p_outbound_phone','p_outbound_export',
                'p_managers','p_managers_add','p_managers_edit','p_managers_delete',
                'p_couriers','p_couriers_add','p_couriers_edit','p_couriers_delete',
                'p_team',
                'p_groups','p_groups_add','p_groups_edit','p_groups_delete',
                'p_orggroups','p_orggroups_add','p_orggroups_edit','p_orggroups_delete',
                'p_orggroups_member_add','p_orggroups_member_edit','p_orggroups_member_remove',
                'p_trash','p_trash_restore','p_trash_purge',
                'p_logs','p_logs_view','p_logs_clear'
            ]);
            $viewerPerms = json_encode(['p_inbound','p_inbound_add','p_outbound','p_outbound_edit']);

            $adminScopes = addslashes(json_encode(['inbound' => 'global', 'outbound' => 'global', 'parcels' => 'global'], JSON_UNESCAPED_UNICODE));
            $viewerScopes = addslashes(json_encode(['inbound' => 'group', 'outbound' => 'group', 'parcels' => 'group'], JSON_UNESCAPED_UNICODE));
            $pdo->exec("INSERT INTO groups (name, permissions, data_scopes) VALUES ('管理员组', '" . addslashes($adminPerms) . "', '" . $adminScopes . "')");
            $pdo->exec("INSERT INTO groups (name, permissions, data_scopes) VALUES ('查看员组', '" . addslashes($viewerPerms) . "', '" . $viewerScopes . "')");

            // ── 默认快递商 ─────────────────────────────────────────
            $couriers = [
                ['顺丰速运', 'cn', 'https://www.sf-express.com/cn/sc/dynamic_functions/waybill/#search/bill-number/{num}',
                 ['半日达','特快','标快','生鲜专递','集运','卡航','冷运','普通']],
                ['京东快递', 'cn', 'https://www.jdl.com/waybill/queryInfo?waybillCode={num}',
                 ['京东特快','京东标快','生鲜特快','生鲜标快','同城送','普通']],
                ['EMS中国邮政', 'cn', 'https://www.ems.com.cn/querytrace.html?mailno={num}',
                 ['即日专递','国内特快','标准快递','电商标快','快递包裹','普通']],
                ['德邦快递', 'cn', 'https://www.deppon.com/trace.html?mailNos={num}',
                 ['标准快递','特准快件','大件快递','零担','整车','普通']],
                ['圆通速递', 'cn', 'https://www.yto.net.cn/trace?waybillno={num}',
                 ['承诺达特快','圆准达','同城当日达','大件快递','普通']],
                ['中通快递', 'cn', 'https://www.zto.com/express/waybillno.html?waybillno={num}',
                 ['飞快','好快','普件','快运小件','标准快运']],
                ['韵达速递', 'cn', 'https://www.yundaex.com/cn/trace.php?nu={num}',
                 ['OFFICE快递','电商快递','贵重物品','普通']],
                ['申通快递', 'cn', 'https://www.sto.cn/portal/query/index?billcode={num}',
                 ['标准快递','普通']],
                ['极兔速递', 'cn', 'https://www.jtexpress.com.cn/waybillno.html?waybillno={num}',
                 ['标准快递','国际标快','普通']],
                ['菜鸟速递', 'cn', 'https://www.cainiao.com/track.html?mailNos={num}',
                 ['优先','标准','经济','普通']],
                ['CJ대한통운', 'kr', 'https://www.cjlogistics.com/ko/tool/parcel/tracking?gnbInvcNo={num}',
                 ['일반','당일']],
                ['한진택배', 'kr', 'https://www.hanjin.co.kr/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2={num}',
                 ['일반','특급']],
                ['롯데택배', 'kr', 'https://www.lotteglogis.com/home/personal/tracking/index?InvNo={num}',
                 ['일반']],
                ['우체국택배', 'kr', 'https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1={num}',
                 ['일반','EMS']],
            ];

            $stmt = $pdo->prepare("INSERT INTO couriers (name, category, tracking_url, service_types) VALUES (?, ?, ?, ?)");
            foreach ($couriers as $c) {
                $stmt->execute([$c[0], $c[1], $c[2], json_encode($c[3], JSON_UNESCAPED_UNICODE)]);
            }

            // ── 创建 admin 账号 ───────────────────────────────────
            $hash = password_hash($password, PASSWORD_BCRYPT);
            $stmt = $pdo->prepare("INSERT INTO users (username, password, role, group_id) VALUES (?, ?, 'admin', 1)");
            $stmt->execute([$username, $hash]);

            $success = true;
        } catch (Exception $e) {
            $error = '安装失败：' . $e->getMessage();
        }
    }
}
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>系统初始化 — 快递管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.1);width:100%;max-width:480px;padding:40px}
.logo{text-align:center;margin-bottom:32px}
.logo-icon{width:56px;height:56px;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px}
.logo-icon svg{fill:white;width:28px;height:28px}
h1{font-size:22px;font-weight:700;color:#111}
.sub{color:#6b7280;font-size:14px;margin-top:4px}
.section{margin-bottom:28px}
.section-title{font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
.check-list{list-style:none}
.check-list li{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:14px}
.check-list li:last-child{border-bottom:none}
.badge{font-size:12px;font-weight:600;padding:2px 8px;border-radius:20px}
.badge-ok{background:#dcfce7;color:#166534}
.badge-err{background:#fee2e2;color:#991b1b}
.form-group{margin-bottom:16px}
label{display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;outline:none;transition:border-color .2s}
input:focus{border-color:#2563eb}
.btn{width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:background .2s}
.btn:hover{background:#1d4ed8}
.btn:disabled{background:#9ca3af;cursor:not-allowed}
.error{background:#fee2e2;color:#991b1b;padding:12px;border-radius:8px;font-size:14px;margin-bottom:16px}
.success-box{text-align:center;padding:20px 0}
.success-icon{font-size:48px;margin-bottom:16px}
.success-title{font-size:20px;font-weight:700;color:#166534;margin-bottom:8px}
.success-msg{color:#374151;font-size:14px;line-height:1.6}
.warn{background:#fef9c3;border:1px solid #fde047;color:#713f12;padding:12px;border-radius:8px;font-size:13px;margin-top:16px}
.goto{display:block;margin-top:20px;padding:12px;background:#166534;color:#fff;border-radius:8px;font-size:15px;font-weight:600;text-align:center;text-decoration:none}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">
      <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
        <path d="M13 4.5L8 2 3 4.5v4c0 2.8 2 5.3 5 6 3-0.7 5-3.2 5-6v-4z"/>
      </svg>
    </div>
    <h1>环球寄件</h1>
    <p class="sub">系统初始化向导</p>
  </div>

  <?php if ($success): ?>
  <div class="success-box">
    <div class="success-icon">✅</div>
    <div class="success-title">安装成功！</div>
    <div class="success-msg">数据库已创建，管理员账号已就绪。</div>
    <div class="warn">⚠️ 安全提示：请立即删除 <strong>install.php</strong> 文件，防止他人重新初始化系统。</div>
    <a href="admin.html" class="goto">进入后台管理</a>
  </div>

  <?php else: ?>

  <!-- 环境检测 -->
  <div class="section">
    <div class="section-title">环境检测</div>
    <ul class="check-list">
      <?php foreach ($envChecks as $c): ?>
      <li>
        <span><?= htmlspecialchars($c['label']) ?></span>
        <span class="badge <?= $c['ok'] ? 'badge-ok' : 'badge-err' ?>">
          <?= htmlspecialchars($c['value']) ?>
        </span>
      </li>
      <?php endforeach; ?>
    </ul>
  </div>

  <!-- 安装表单 -->
  <div class="section">
    <div class="section-title">创建管理员账号</div>
    <?php if ($error): ?>
    <div class="error"><?= htmlspecialchars($error) ?></div>
    <?php endif; ?>
    <form method="POST">
      <input type="hidden" name="action" value="install">
      <div class="form-group">
        <label for="username">管理员账号</label>
        <input type="text" id="username" name="username" value="<?= htmlspecialchars($_POST['username'] ?? '') ?>" placeholder="至少 2 个字符" required>
      </div>
      <div class="form-group">
        <label for="password">密码</label>
        <input type="password" id="password" name="password" placeholder="至少 6 位" required>
      </div>
      <div class="form-group">
        <label for="confirm">确认密码</label>
        <input type="password" id="confirm" name="confirm" placeholder="再次输入密码" required>
      </div>
      <button type="submit" class="btn" <?= !$envOk ? 'disabled' : '' ?>>
        <?= !$envOk ? '环境检测未通过，无法安装' : '开始安装' ?>
      </button>
    </form>
  </div>
  <?php endif; ?>
</div>
</body>
</html>
