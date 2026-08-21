<?php
/**
 * db.php — SQLite 连接单例
 */

// 所有 api/*.php 都会 require 这个文件，在这里统一关掉 PHP 报错/警告直接输出——
// 服务器上很多环境 display_errors 默认是开的，一旦哪个接口踩到未定义数组键之类的
// 警告，警告文本会直接混进本该是纯 JSON 的响应体里，前端 res.json() 直接解析失败
// （之前 inbound.php/parcels.php 就踩过这个坑）。改成记到错误日志，不影响调试，
// 只是不再往响应里泄漏。
ini_set('display_errors', '0');
ini_set('log_errors', '1');

define('DB_PATH', __DIR__ . '/../data/express.db');
define('SCHEMA_MAINTENANCE_VERSION', 2026072609);

// ── Redis 只读缓存（可选加速，不是数据源）───────────────────────
// 用于缓存"高频读、低频改"的数据（快递商列表、负责人下拉、公开查快递结果这类），
// 减轻并发高时对 SQLite 的重复查询压力。Redis 不可用时 cache_remember() 直接退化成
// "每次都查 SQLite"，跟没有这层缓存时完全一样——SQLite 本身不做任何改动，所有写
// 操作照旧，这里只是读路径前面加一层可选的旁路缓存。
function redis_or_null(): ?Redis {
    static $redis = null;
    static $tried = false;
    if ($tried) return $redis;
    $tried = true;

    if (!class_exists('Redis')) return null;
    try {
        $r = new Redis();
        if (!@$r->connect('127.0.0.1', 6379, 0.2)) return null;
        $redis = $r;
    } catch (\Throwable $e) {
        $redis = null;
    }
    return $redis;
}

/**
 * 先查缓存，命中就直接返回；没命中（或 Redis 不可用）就跑 $compute() 查 SQLite，
 * 查到的结果顺手写回缓存。$compute 的返回值必须是能 json_encode 的数组。
 */
function cache_remember(string $key, int $ttlSeconds, callable $compute): array {
    $redis = redis_or_null();
    if ($redis) {
        try {
            $cached = $redis->get($key);
            if ($cached !== false) {
                $decoded = json_decode($cached, true);
                if (is_array($decoded)) return $decoded;
            }
        } catch (\Throwable $e) { /* 缓存读失败当作没命中，走下面正常查库 */ }
    }

    $value = $compute();

    if ($redis) {
        try {
            $redis->setex($key, $ttlSeconds, json_encode($value, JSON_UNESCAPED_UNICODE));
        } catch (\Throwable $e) { /* 缓存写失败不影响本次请求，数据已经算出来了 */ }
    }

    return $value;
}

// SQLite 整个库同一时刻只能有一个写事务，busy_timeout 只保证排队等一等，队列本身
// 排太满还是会等到超时被拒绝（真实案例：早高峰多人同时登录+改单号，写请求瞬间
// 堆积超过 busy_timeout 窗口）。对这类瞬时冲突加一层短退避重试，比单纯拉长
// busy_timeout 更有效——只重试"database is locked"这一种异常，其他 DB 错误
// （约束冲突、语法错误等）重试没有意义，直接照常抛出。
function sqlite_retry(callable $fn, int $maxRetries = 2) {
    $attempt = 0;
    while (true) {
        try {
            return $fn();
        } catch (\PDOException $e) {
            $msg = $e->getMessage();
            $isLocked = str_contains($msg, 'database is locked')
                || str_contains($msg, 'database table is locked');
            if (!$isLocked || $attempt >= $maxRetries) {
                throw $e;
            }
            $attempt++;
            usleep($attempt === 1 ? 150000 : 400000);
        }
    }
}

function decode_permission_json($raw): array {
    if (is_array($raw)) {
        return array_values(array_filter($raw, 'is_string'));
    }

    $text = (string)($raw ?? '[]');
    $candidates = [$text, stripslashes($text)];
    foreach ($candidates as $candidate) {
        $value = $candidate;
        for ($i = 0; $i < 3; $i++) {
            $decoded = json_decode($value, true);
            if (is_array($decoded)) {
                return array_values(array_filter($decoded, 'is_string'));
            }
            if (is_string($decoded)) {
                $value = $decoded;
                continue;
            }
            break;
        }
    }

    error_log('Invalid permission JSON encountered: ' . substr($text, 0, 500));
    return [];
}

function normalize_data_scopes($raw): array {
    $defaults = ['inbound' => 'group', 'outbound' => 'group', 'parcels' => 'group'];
    $allowed = ['global', 'group', 'self'];

    if (is_string($raw)) {
        $raw = json_decode($raw, true);
    }
    if (!is_array($raw)) {
        $raw = [];
    }

    $out = [];
    foreach ($defaults as $key => $default) {
        $value = $raw[$key] ?? $default;
        $out[$key] = in_array($value, $allowed, true) ? $value : $default;
    }
    return $out;
}

function permission_catalog(): array {
    return [
        'inbound:view' => ['resource' => 'inbound', 'action' => 'view', 'label' => '查看入库单', 'legacy' => ['p_inbound'], 'dangerous' => 0],
        'inbound:create' => ['resource' => 'inbound', 'action' => 'create', 'label' => '新增入库单', 'legacy' => ['p_inbound_add'], 'dangerous' => 0],
        'inbound:edit' => ['resource' => 'inbound', 'action' => 'edit', 'label' => '编辑入库单', 'legacy' => ['p_inbound_edit'], 'dangerous' => 0],
        'inbound:delete' => ['resource' => 'inbound', 'action' => 'delete', 'label' => '删除入库单', 'legacy' => ['p_inbound_delete'], 'dangerous' => 1],
        'inbound:export' => ['resource' => 'inbound', 'action' => 'export', 'label' => '导出入库 CSV', 'legacy' => ['p_inbound_export'], 'dangerous' => 0],
        'inbound:phone' => ['resource' => 'inbound', 'action' => 'phone', 'label' => '查看入库手机号', 'legacy' => ['p_inbound_phone'], 'dangerous' => 1],
        'inbound:parse' => ['resource' => 'inbound', 'action' => 'parse', 'label' => '智能解析入库文本', 'legacy' => ['p_inbound_parse'], 'dangerous' => 0],

        'parcels:view' => ['resource' => 'parcels', 'action' => 'view', 'label' => '查看快递记录', 'legacy' => ['p_parcels', 'p_outbound'], 'dangerous' => 0],
        'parcels:create' => ['resource' => 'parcels', 'action' => 'create', 'label' => '新增快递记录', 'legacy' => ['p_parcels_add'], 'dangerous' => 0],
        'parcels:edit' => ['resource' => 'parcels', 'action' => 'edit', 'label' => '处理/编辑快递', 'legacy' => ['p_parcels_edit', 'p_outbound_edit'], 'dangerous' => 0],
        'parcels:delete' => ['resource' => 'parcels', 'action' => 'delete', 'label' => '删除快递记录', 'legacy' => ['p_parcels_delete'], 'dangerous' => 1],
        'parcels:export' => ['resource' => 'parcels', 'action' => 'export', 'label' => '导出快递 CSV', 'legacy' => ['p_outbound_export'], 'dangerous' => 0],
        'parcels:phone' => ['resource' => 'parcels', 'action' => 'phone', 'label' => '查看快递手机号', 'legacy' => ['p_parcels_phone', 'p_outbound_phone'], 'dangerous' => 1],
        'parcels:notify' => ['resource' => 'parcels', 'action' => 'notify', 'label' => '复制/发送客户通知', 'legacy' => [], 'dangerous' => 0],

        'couriers:view' => ['resource' => 'couriers', 'action' => 'view', 'label' => '查看快递商', 'legacy' => ['p_couriers'], 'dangerous' => 0],
        'couriers:create' => ['resource' => 'couriers', 'action' => 'create', 'label' => '新增快递商', 'legacy' => ['p_couriers_add'], 'dangerous' => 0],
        'couriers:edit' => ['resource' => 'couriers', 'action' => 'edit', 'label' => '编辑快递商', 'legacy' => ['p_couriers_edit'], 'dangerous' => 0],
        'couriers:delete' => ['resource' => 'couriers', 'action' => 'delete', 'label' => '删除快递商', 'legacy' => ['p_couriers_delete'], 'dangerous' => 1],

        'team:view' => ['resource' => 'team', 'action' => 'view', 'label' => '进入团队管理', 'legacy' => ['p_team'], 'dangerous' => 0],
        'team:accounts_view' => ['resource' => 'team', 'action' => 'accounts_view', 'label' => '查看账号管理', 'legacy' => ['p_managers'], 'dangerous' => 0],
        'team:accounts_create' => ['resource' => 'team', 'action' => 'accounts_create', 'label' => '新增账号', 'legacy' => ['p_managers_add'], 'dangerous' => 1],
        'team:accounts_edit' => ['resource' => 'team', 'action' => 'accounts_edit', 'label' => '编辑账号/重置密码', 'legacy' => ['p_managers_edit'], 'dangerous' => 1],
        'team:accounts_delete' => ['resource' => 'team', 'action' => 'accounts_delete', 'label' => '删除账号', 'legacy' => ['p_managers_delete'], 'dangerous' => 1],
        'team:groups_view' => ['resource' => 'team', 'action' => 'groups_view', 'label' => '查看权限组', 'legacy' => ['p_groups'], 'dangerous' => 0],
        'team:groups_create' => ['resource' => 'team', 'action' => 'groups_create', 'label' => '新增权限组', 'legacy' => ['p_groups_add'], 'dangerous' => 1],
        'team:groups_edit' => ['resource' => 'team', 'action' => 'groups_edit', 'label' => '编辑权限组', 'legacy' => ['p_groups_edit'], 'dangerous' => 1],
        'team:groups_delete' => ['resource' => 'team', 'action' => 'groups_delete', 'label' => '删除权限组', 'legacy' => ['p_groups_delete'], 'dangerous' => 1],
        'team:org_view' => ['resource' => 'team', 'action' => 'org_view', 'label' => '查看团队架构', 'legacy' => ['p_orggroups'], 'dangerous' => 0],
        'team:org_create' => ['resource' => 'team', 'action' => 'org_create', 'label' => '新增团队', 'legacy' => ['p_orggroups_add'], 'dangerous' => 1],
        'team:org_edit' => ['resource' => 'team', 'action' => 'org_edit', 'label' => '编辑团队', 'legacy' => ['p_orggroups_edit'], 'dangerous' => 1],
        'team:org_delete' => ['resource' => 'team', 'action' => 'org_delete', 'label' => '删除团队', 'legacy' => ['p_orggroups_delete'], 'dangerous' => 1],
        'team:member_add' => ['resource' => 'team', 'action' => 'member_add', 'label' => '添加团队成员', 'legacy' => ['p_orggroups_member_add'], 'dangerous' => 1],
        'team:member_edit' => ['resource' => 'team', 'action' => 'member_edit', 'label' => '调整团队成员角色', 'legacy' => ['p_orggroups_member_edit'], 'dangerous' => 1],
        'team:member_remove' => ['resource' => 'team', 'action' => 'member_remove', 'label' => '移出团队成员', 'legacy' => ['p_orggroups_member_remove'], 'dangerous' => 1],

        'trash:view' => ['resource' => 'trash', 'action' => 'view', 'label' => '查看回收站', 'legacy' => ['p_trash'], 'dangerous' => 0],
        'trash:restore' => ['resource' => 'trash', 'action' => 'restore', 'label' => '恢复记录', 'legacy' => ['p_trash_restore'], 'dangerous' => 0],
        'trash:purge' => ['resource' => 'trash', 'action' => 'purge', 'label' => '永久删除', 'legacy' => ['p_trash_purge'], 'dangerous' => 1],

        'logs:view' => ['resource' => 'logs', 'action' => 'view', 'label' => '查看操作日志', 'legacy' => ['p_logs', 'p_logs_view'], 'dangerous' => 0],
        'logs:clear' => ['resource' => 'logs', 'action' => 'clear', 'label' => '清空操作日志', 'legacy' => ['p_logs_clear'], 'dangerous' => 1],
        'logs:export' => ['resource' => 'logs', 'action' => 'export', 'label' => '导出操作日志', 'legacy' => [], 'dangerous' => 0],
    ];
}

function legacy_permission_map(): array {
    $map = [];
    foreach (permission_catalog() as $canonical => $meta) {
        foreach (($meta['legacy'] ?? []) as $legacy) {
            $map[$legacy] = $canonical;
        }
    }
    return $map;
}

function permission_expansion_map(): array {
    return [
        'team:view' => ['team:view', 'team:accounts_view', 'team:groups_view', 'team:org_view'],
        'team:accounts_manage' => ['team:accounts_create', 'team:accounts_edit', 'team:accounts_delete'],
        'team:groups_manage' => ['team:groups_create', 'team:groups_edit', 'team:groups_delete'],
        'team:org_manage' => ['team:org_create', 'team:org_edit', 'team:org_delete', 'team:member_add', 'team:member_edit', 'team:member_remove'],
    ];
}

function canonical_permission_for(string $permission): string {
    if ($permission === '*') {
        return '*';
    }
    if (isset(permission_catalog()[$permission])) {
        return $permission;
    }
    return legacy_permission_map()[$permission] ?? $permission;
}

function normalize_permission_keys(array $permissions, bool $includeAliases = false): array {
    if (in_array('*', $permissions, true)) {
        return ['*'];
    }

    $catalog = permission_catalog();
    $out = [];
    foreach ($permissions as $permission) {
        if (!is_string($permission) || $permission === '') {
            continue;
        }
        if (isset(permission_expansion_map()[$permission])) {
            $out = array_merge($out, permission_expansion_map()[$permission]);
            continue;
        }
        $canonical = canonical_permission_for($permission);
        $out[] = $canonical;
        if ($includeAliases && isset($catalog[$canonical])) {
            $out = array_merge($out, $catalog[$canonical]['legacy'] ?? []);
        }
    }
    return array_values(array_unique($out));
}

function legacy_permissions_for(array $permissions): array {
    if (in_array('*', $permissions, true)) {
        return ['*'];
    }

    $catalog = permission_catalog();
    $out = [];
    foreach (normalize_permission_keys($permissions) as $permission) {
        if (isset($catalog[$permission])) {
            $legacy = $catalog[$permission]['legacy'] ?? [];
            $out = array_merge($out, $legacy ?: [$permission]);
        } else {
            $out[] = $permission;
        }
    }
    return array_values(array_unique($out));
}

function group_permission_keys(PDO $pdo, int $groupId, bool $includeAliases = false): array {
    $stmt = $pdo->prepare("SELECT permission_key FROM group_permissions WHERE group_id = ? ORDER BY permission_key ASC");
    try {
        $stmt->execute([$groupId]);
        $keys = array_column($stmt->fetchAll(PDO::FETCH_ASSOC), 'permission_key');
    } catch (\Throwable $e) {
        $keys = [];
    }

    if (!$keys) {
        $fallback = $pdo->prepare("SELECT permissions FROM groups WHERE id = ? LIMIT 1");
        $fallback->execute([$groupId]);
        $keys = decode_permission_json((string)($fallback->fetchColumn() ?: '[]'));
    }

    return normalize_permission_keys($keys, $includeAliases);
}

function save_group_permission_keys(PDO $pdo, int $groupId, array $permissions): array {
    $canonical = normalize_permission_keys($permissions);
    $pdo->prepare("DELETE FROM group_permissions WHERE group_id = ?")->execute([$groupId]);
    if ($canonical && !in_array('*', $canonical, true)) {
        $ins = $pdo->prepare("INSERT OR IGNORE INTO group_permissions (group_id, permission_key) VALUES (?, ?)");
        foreach ($canonical as $permission) {
            $ins->execute([$groupId, $permission]);
        }
    }

    $legacy = legacy_permissions_for($canonical);
    $pdo->prepare("UPDATE groups SET permissions = ? WHERE id = ?")
        ->execute([json_encode($legacy, JSON_UNESCAPED_UNICODE), $groupId]);
    return $legacy;
}

function create_core_indexes(PDO $pdo): void {
    $indexes = [
        "CREATE INDEX IF NOT EXISTS idx_parcels_list ON parcels (deleted_at, source, status, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_parcels_manager ON parcels (manager_id, deleted_at, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_parcels_courier ON parcels (courier_id)",
        "CREATE INDEX IF NOT EXISTS idx_parcels_phone ON parcels (phone)",
        "CREATE INDEX IF NOT EXISTS idx_parcels_tracking ON parcels (tracking_number)",
        "CREATE INDEX IF NOT EXISTS idx_users_deleted ON users (deleted_at)",
        "CREATE INDEX IF NOT EXISTS idx_users_group ON users (group_id)",
        "CREATE INDEX IF NOT EXISTS idx_logs_list ON operation_logs (created_at, username, action, target_type)",
        "CREATE INDEX IF NOT EXISTS idx_org_groups_parent ON org_groups (parent_id, deleted_at)",
        "CREATE INDEX IF NOT EXISTS idx_org_members_group ON org_group_members (group_id, user_id)",
        "CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_group_members (user_id)",
    ];

    foreach ($indexes as $sql) {
        $pdo->exec($sql);
    }
}

function backfill_admin_group_permissions(PDO $pdo): void {
    $teamPerms = [
        'p_team',
        'p_orggroups', 'p_orggroups_add', 'p_orggroups_edit', 'p_orggroups_delete',
        'p_orggroups_member_add', 'p_orggroups_member_edit', 'p_orggroups_member_remove',
        'p_logs', 'p_logs_view', 'p_logs_clear', 'p_trash_purge',
    ];
    $rows = $pdo->query("SELECT id, name, permissions FROM groups")->fetchAll(PDO::FETCH_ASSOC);
    $upd = $pdo->prepare("UPDATE groups SET permissions = ? WHERE id = ?");
    foreach ($rows as $row) {
        $perms = decode_permission_json($row['permissions'] ?? '[]');
        $shouldBackfill = in_array('p_groups', $perms, true)
            || in_array('p_managers', $perms, true)
            || in_array('*', $perms, true)
            || mb_strpos((string)($row['name'] ?? ''), 'admin') !== false
            || mb_strpos((string)($row['name'] ?? ''), '管理员') !== false;
        if (!$shouldBackfill) {
            continue;
        }

        $merged = array_values(array_unique(array_merge($perms, $teamPerms)));
        if ($merged !== $perms || json_encode($perms, JSON_UNESCAPED_UNICODE) !== ($row['permissions'] ?? '')) {
            $upd->execute([json_encode($merged, JSON_UNESCAPED_UNICODE), (int)$row['id']]);
        }
    }
}

function create_standard_rbac_schema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS permissions (
        permission_key TEXT PRIMARY KEY,
        resource       TEXT NOT NULL,
        action         TEXT NOT NULL,
        label          TEXT NOT NULL DEFAULT '',
        description    TEXT NOT NULL DEFAULT '',
        legacy_key     TEXT NOT NULL DEFAULT '',
        is_dangerous   INTEGER NOT NULL DEFAULT 0,
        sort_order     INTEGER NOT NULL DEFAULT 0
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS group_permissions (
        group_id       INTEGER NOT NULL,
        permission_key TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        PRIMARY KEY (group_id, permission_key)
    )");
    $pdo->exec("CREATE INDEX IF NOT EXISTS idx_group_permissions_key ON group_permissions (permission_key)");

    $upsert = $pdo->prepare("
        INSERT INTO permissions (permission_key, resource, action, label, description, legacy_key, is_dangerous, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(permission_key) DO UPDATE SET
            resource = excluded.resource,
            action = excluded.action,
            label = excluded.label,
            description = excluded.description,
            legacy_key = excluded.legacy_key,
            is_dangerous = excluded.is_dangerous,
            sort_order = excluded.sort_order
    ");

    $i = 10;
    foreach (permission_catalog() as $key => $meta) {
        $upsert->execute([
            $key,
            $meta['resource'],
            $meta['action'],
            $meta['label'],
            $meta['description'] ?? '',
            implode(',', $meta['legacy'] ?? []),
            (int)($meta['dangerous'] ?? 0),
            $i,
        ]);
        $i += 10;
    }

    $keys = array_keys(permission_catalog());
    if ($keys) {
        $ph = implode(',', array_fill(0, count($keys), '?'));
        $pdo->prepare("DELETE FROM permissions WHERE permission_key NOT IN ($ph)")->execute($keys);
    }
}

function migrate_group_permissions(PDO $pdo): void {
    create_standard_rbac_schema($pdo);
    $rows = $pdo->query("SELECT id, permissions FROM groups ORDER BY id ASC")->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as $row) {
        $groupId = (int)$row['id'];
        $existing = $pdo->prepare("SELECT permission_key FROM group_permissions WHERE group_id = ?");
        $existing->execute([$groupId]);
        $current = array_column($existing->fetchAll(PDO::FETCH_ASSOC), 'permission_key');
        $legacy = decode_permission_json($row['permissions'] ?? '[]');
        $merged = array_values(array_unique(array_merge($current, $legacy)));
        if (!$merged) {
            continue;
        }
        save_group_permission_keys($pdo, $groupId, $merged);
    }
}

function run_schema_maintenance(PDO $pdo): void {
    $version = (int)$pdo->query('PRAGMA user_version')->fetchColumn();
    if ($version >= SCHEMA_MAINTENANCE_VERSION) {
        return;
    }

    create_core_indexes($pdo);
    backfill_admin_group_permissions($pdo);
    migrate_group_permissions($pdo);
    $pdo->exec('PRAGMA user_version = ' . SCHEMA_MAINTENANCE_VERSION);
}

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        if (!file_exists(DB_PATH)) {
            http_response_code(503);
            echo json_encode(['ok' => false, 'msg' => '数据库未初始化，请运行 install.php']);
            exit;
        }
        $pdo = new PDO('sqlite:' . DB_PATH);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $pdo->exec('PRAGMA journal_mode=WAL;');
        $pdo->exec('PRAGMA foreign_keys=ON;');
        // synchronous=NORMAL：WAL 模式下这个设置能减少每次写入强制刷盘（fsync）的
        // 次数，代价是极端断电场景下可能丢最后一笔还没落盘的事务，但不会损坏数据库
        // 本身（WAL 保证这个）——高并发写入时磁盘压力会明显小一些，用不丢数据换
        // 一点点这种极端情况下的风险，是常见的合理取舍。
        // mmap_size：把数据库文件映射进内存读，减少重复的 read() 系统调用；
        // 256MB 对现在的数据规模足够，就算以后数据变大也只是退化成部分走 mmap、
        // 部分走普通读，不会出错。
        $pdo->exec('PRAGMA synchronous=NORMAL;');
        $pdo->exec('PRAGMA mmap_size=268435456;');
        // busy_timeout：SQLite 同一时刻只能有一个写操作在进行，默认没设这个的话，
        // 抢不到写锁的请求会立刻抛 SQLITE_BUSY 异常，不会等——压测时发现的真实
        // 问题：多个并发请求同时更新同一个账号的 last_active_at（比如同一账号被
        // 多人同时登录），抢不到锁的那几个直接报了个没被 catch 住的致命错误，
        // 变成一个不知所云的 500。改成等 5 秒再放弃，绝大多数并发写入场景下
        // 5 秒内锁早就释放了，请求会自动排队等一下，而不是直接报错。
        $pdo->exec('PRAGMA busy_timeout=8000;');
        // ── 自动迁移（向后兼容，按需添加字段/表）─────────────────
        // v5.0: users 首次登录改密标记
        try { $pdo->exec("ALTER TABLE users ADD COLUMN must_change_pwd INTEGER NOT NULL DEFAULT 0"); } catch (\Throwable $e) {}
        // v5.2: 团队群组管理 ─────────────────────────────────────
        try { $pdo->exec("ALTER TABLE users ADD COLUMN group_role TEXT NOT NULL DEFAULT 'member'"); } catch (\Throwable $e) {}
        try { $pdo->exec("ALTER TABLE users ADD COLUMN last_active_at TEXT"); } catch (\Throwable $e) {}
        try { $pdo->exec("ALTER TABLE parcels ADD COLUMN internal_note TEXT DEFAULT ''"); } catch (\Throwable $e) {}
        try { $pdo->exec("ALTER TABLE groups ADD COLUMN data_scopes TEXT NOT NULL DEFAULT '{\"inbound\":\"group\",\"outbound\":\"group\",\"parcels\":\"group\"}'"); } catch (\Throwable $e) {}

        // 权限模板库
        $pdo->exec("CREATE TABLE IF NOT EXISTS perm_templates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            permissions TEXT NOT NULL DEFAULT '[]',
            data_scopes TEXT NOT NULL DEFAULT '{}',
            is_system   INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )");
        // 内置系统模板（仅首次）
        if ((int)$pdo->query("SELECT COUNT(*) FROM perm_templates")->fetchColumn() === 0) {
            $allPerms = ['p_parcels','p_parcels_add','p_parcels_edit','p_parcels_delete','p_parcels_phone',
                         'p_inbound','p_inbound_add','p_inbound_edit','p_inbound_delete','p_inbound_parse','p_inbound_phone','p_inbound_export',
                         'p_outbound','p_outbound_edit','p_outbound_phone','p_outbound_export',
                         'p_team','p_managers','p_couriers','p_orggroups','p_orggroups_add','p_orggroups_edit','p_orggroups_delete',
                         'p_orggroups_member_add','p_orggroups_member_edit','p_orggroups_member_remove',
                         'p_trash','p_trash_restore','p_trash_purge','p_logs','p_logs_view','p_logs_clear'];
            $ins = $pdo->prepare("INSERT INTO perm_templates (name,description,permissions,data_scopes,is_system) VALUES (?,?,?,?,1)");
            $ins->execute(['店长模板','店长级，完整操作权限',json_encode($allPerms,JSON_UNESCAPED_UNICODE),'{"inbound":"group","outbound":"group","parcels":"group"}']);
            $ins->execute(['仓库操作模板','入库/出库日常操作员',json_encode(['p_inbound','p_inbound_add','p_inbound_edit','p_inbound_parse','p_outbound','p_outbound_edit'],JSON_UNESCAPED_UNICODE),'{"inbound":"group","outbound":"group","parcels":"self"}']);
            $ins->execute(['客服查询模板','只读查询，不可修改',json_encode(['p_inbound','p_outbound'],JSON_UNESCAPED_UNICODE),'{"inbound":"global","outbound":"global","parcels":"global"}']);
        }

        // 团队群组
        $pdo->exec("CREATE TABLE IF NOT EXISTS org_groups (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            parent_id   INTEGER DEFAULT NULL,
            description TEXT NOT NULL DEFAULT '',
            leader_ids  TEXT NOT NULL DEFAULT '[]',
            template_id INTEGER DEFAULT NULL,
            permissions TEXT NOT NULL DEFAULT '[]',
            data_scopes TEXT NOT NULL DEFAULT '{\"inbound\":\"group\",\"outbound\":\"group\",\"parcels\":\"group\"}',
            created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at  TEXT,
            deleted_at  TEXT
        )");

        // 群组成员关系
        $pdo->exec("CREATE TABLE IF NOT EXISTS org_group_members (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id      INTEGER NOT NULL,
            user_id       INTEGER NOT NULL,
            role_in_group TEXT NOT NULL DEFAULT 'member',
            perm_override TEXT NOT NULL DEFAULT '{\"add\":[],\"remove\":[]}',
            scope_override TEXT NOT NULL DEFAULT '{}',
            joined_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE(group_id, user_id)
        )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS operation_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER,
            username    TEXT NOT NULL DEFAULT '',
            action      TEXT NOT NULL DEFAULT '',
            target_type TEXT NOT NULL DEFAULT '',
            target_id   INTEGER,
            target_name TEXT NOT NULL DEFAULT '',
            detail      TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )");

        try { run_schema_maintenance($pdo); } catch (\Throwable $e) {}

        if (false) { try {
            $teamPerms = [
                'p_team',
                'p_orggroups', 'p_orggroups_add', 'p_orggroups_edit', 'p_orggroups_delete',
                'p_orggroups_member_add', 'p_orggroups_member_edit', 'p_orggroups_member_remove',
                'p_logs', 'p_logs_view', 'p_logs_clear', 'p_trash_purge',
            ];
            $rows = $pdo->query("SELECT id, name, permissions FROM groups")->fetchAll(PDO::FETCH_ASSOC);
            $upd = $pdo->prepare("UPDATE groups SET permissions = ? WHERE id = ?");
            foreach ($rows as $row) {
                $perms = decode_permission_json($row['permissions'] ?? '[]');
                $shouldHaveTeamPerms = in_array('p_groups', $perms, true)
                    || in_array('p_managers', $perms, true)
                    || mb_strpos((string)($row['name'] ?? ''), '管理员') !== false;
                if (!$shouldHaveTeamPerms) {
                    continue;
                }
                $merged = array_values(array_unique(array_merge($perms, $teamPerms)));
                if ($merged !== $perms || json_encode($perms, JSON_UNESCAPED_UNICODE) !== ($row['permissions'] ?? '')) {
                    $upd->execute([json_encode($merged, JSON_UNESCAPED_UNICODE), (int)$row['id']]);
                }
            }
        } catch (\Throwable $e) {} }
    }
    return $pdo;
}

/**
 * 写操作日志（失败不影响主流程）
 * @param array  $user        require_auth() 返回值
 * @param string $action      操作名：新增/编辑/删除/永久删除/还原/填单号/改密码
 * @param string $target_type 对象类型：入库单/填单号/快递记录/负责人/快递商/权限组
 * @param int    $target_id   对象 ID
 * @param string $target_name 对象名称（快照）
 * @param string $detail      附加说明
 */
function write_log(array $user, string $action, string $target_type, int $target_id, string $target_name, string $detail = ''): void {
    try {
        db()->prepare(
            "INSERT INTO operation_logs (user_id, username, action, target_type, target_id, target_name, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?)"
        )->execute([
            $user['uid'], $user['username'], $action, $target_type, $target_id, $target_name, $detail
        ]);
    } catch (\Throwable $e) { /* 日志失败不影响主流程 */ }
}

/**
 * 数据范围 WHERE 条件（用于 inbound/outbound/parcels 列表查询）
 * @return array [where_string_or_empty, params_array]
 */
function data_scope_condition(array $user, string $module): array {
    if ($user['role'] === 'admin' || in_array('*', $user['perms'] ?? [])) {
        return ['', []];
    }
    $scopes      = $user['data_scopes'] ?? [];
    $scope       = $scopes[$module] ?? 'global';
    if ($scope === 'global') return ['', []];
    if ($scope === 'group' && !empty($user['org_group_id'])) {
        return [
            "p.manager_id IN (SELECT user_id FROM org_group_members WHERE group_id = ?)",
            [(int)$user['org_group_id']],
        ];
    }
    // self（含未分组降级）
    return ["p.manager_id = ?", [(int)$user['uid']]];
}

function json_out(array $data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function method_must(string ...$methods): void {
    if (!in_array($_SERVER['REQUEST_METHOD'], $methods, true)) {
        json_out(['ok' => false, 'msg' => 'Method Not Allowed'], 405);
    }
}

// 自动清理超过 3 个月的软删除记录 + 超过 3 个月的操作日志（每次请求有 5% 概率
// 触发，减少性能损耗——不用每个请求都跑一遍清理逻辑）。
// 之前这里被 getenv('EXP_INLINE_GC') !== '1' 挡住了，等于没设这个环境变量的话
// 这个函数永远直接返回、什么都不做——正常的共享主机部署基本不会有人专门去设
// 这个变量，所以"回收站 2 个月自动清理"这句话实际上从来没真正生效过，被删除的
// 记录和关联图片一直堆在数据库和磁盘里。现在去掉这道没意义的门槛。
function maybe_gc(): void {
    if (mt_rand(1, 20) !== 1) return;
    $cutoff = date('Y-m-d H:i:s', strtotime('-3 months'));
    $db = db();
    // 删除过期 parcels 的关联图片
    $rows = $db->prepare("SELECT images FROM parcels WHERE deleted_at IS NOT NULL AND deleted_at < ?");
    $rows->execute([$cutoff]);
    foreach ($rows->fetchAll() as $row) {
        $imgs = json_decode($row['images'] ?? '[]', true);
        foreach ($imgs as $path) {
            $full = __DIR__ . '/../' . ltrim($path, '/');
            if (file_exists($full)) @unlink($full);
        }
    }
    $db->prepare("DELETE FROM parcels WHERE deleted_at IS NOT NULL AND deleted_at < ?")->execute([$cutoff]);
    $db->prepare("DELETE FROM users  WHERE deleted_at IS NOT NULL AND deleted_at < ?")->execute([$cutoff]);
    // 操作日志之前完全没有自动清理，只有手动"清空日志"（一次性全清）。这里加上
    // 按时间自动清理，跟回收站用同一个 3 个月的口径、同一次触发一起做。
    $db->prepare("DELETE FROM operation_logs WHERE created_at < ?")->execute([$cutoff]);
}
