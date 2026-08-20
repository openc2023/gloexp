<?php
/**
 * system_update.php - 系统一键更新（仅超级管理员）。
 * 从固定写死的 GitHub 仓库拉取最新代码，覆盖前自动备份，绝不触碰 data/ 和 uploads/。
 *
 * GET  ?action=status        检查是否有新版本
 * POST ?action=set_baseline  手动标记"当前代码=某个版本号"（首次部署/建仓库后用一次）
 * GET  ?action=backups       列出可回滚的备份
 * POST ?action=update        执行更新（备份 + 拉取 + 覆盖）
 * POST ?action=rollback      回滚到指定备份
 */

require_once __DIR__ . '/session_boot.php';
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$user = require_auth();
if (!is_super_admin($user)) {
    json_out(['ok' => false, 'msg' => '只有超级管理员可以操作系统更新'], 403);
}

// 仓库地址写死在服务端代码里，不接受前端传参——防止有人篡改成任意地址，
// 诱导服务器拉取并覆盖成来路不明的代码。
const UPDATE_REPO_OWNER = 'openc2023';
const UPDATE_REPO_NAME = 'gloexp';
const UPDATE_REPO_BRANCH = 'main';

define('VERSION_FILE', __DIR__ . '/../data/VERSION');
define('BACKUP_DIR', __DIR__ . '/../data/backups');
// 更新/备份/回滚只触碰这些路径——白名单，data/ uploads/ .git 永远不在里面。
define('DEPLOY_PATHS', [
    'api', 'assets', '.htaccess', 'install.php',
    'index.html', 'login.html', 'inbound.html', 'outbound.html',
    'team.html', 'couriers.html', 'trash.html', 'logs.html', 'track.html',
]);

function get_local_version(): string {
    return file_exists(VERSION_FILE) ? trim((string)file_get_contents(VERSION_FILE)) : '';
}
function set_local_version(string $sha): void {
    file_put_contents(VERSION_FILE, $sha);
}

function github_api_get(string $url): array {
    $ctx = stream_context_create(['http' => [
        'header' => "User-Agent: gloexp-update-checker\r\nAccept: application/vnd.github+json\r\n",
        'timeout' => 15,
    ]]);
    $raw = @file_get_contents($url, false, $ctx);
    if ($raw === false) {
        throw new Exception('无法连接 GitHub，请检查服务器网络');
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new Exception('GitHub 返回数据异常');
    }
    return $data;
}

function download_to_file(string $url, string $dest): void {
    $ctx = stream_context_create(['http' => [
        'header' => "User-Agent: gloexp-update-checker\r\n",
        'timeout' => 120,
        'follow_location' => 1,
    ]]);
    $data = @file_get_contents($url, false, $ctx);
    if ($data === false) {
        throw new Exception('下载更新包失败，请检查服务器网络后重试');
    }
    file_put_contents($dest, $data);
}

function rrmdir(string $dir): void {
    if (!is_dir($dir)) return;
    foreach (scandir($dir) as $item) {
        if ($item === '.' || $item === '..') continue;
        $path = $dir . '/' . $item;
        is_dir($path) ? rrmdir($path) : @unlink($path);
    }
    @rmdir($dir);
}

function rcopy(string $src, string $dst): void {
    if (is_dir($src)) {
        if (!is_dir($dst)) mkdir($dst, 0755, true);
        foreach (scandir($src) as $item) {
            if ($item === '.' || $item === '..') continue;
            rcopy($src . '/' . $item, $dst . '/' . $item);
        }
    } elseif (is_file($src)) {
        copy($src, $dst);
    }
}

// 只保留最近几份备份，多的自动清掉——不然 data/backups/ 会随着更新次数无限膨胀。
define('BACKUP_RETENTION', 3);

function prune_old_backups(): void {
    if (!is_dir(BACKUP_DIR)) return;
    $items = [];
    foreach (scandir(BACKUP_DIR) as $item) {
        if ($item === '.' || $item === '..') continue;
        $path = BACKUP_DIR . '/' . $item;
        if (is_dir($path)) $items[] = ['path' => $path, 'time' => filemtime($path)];
    }
    usort($items, fn($a, $b) => $b['time'] <=> $a['time']);
    foreach (array_slice($items, BACKUP_RETENTION) as $old) {
        rrmdir($old['path']);
    }
}

function backup_current(): string {
    // mkdir/copy 失败时 PHP 只会抛 Warning，不是 Exception——之前这里完全没检查
    // 返回值，一旦服务器上 data/backups/ 权限或磁盘空间有问题，会静默跳过整个备份
    // 步骤，但后面的更新流程完全不知情，照样往下走、照样提示"更新成功"，只是
    // 这次更新压根没留下可回滚的备份。这正是"点更新、提示成功，但备份数量
    // 一直不变"这个问题的真正原因——不是数量被清理掉了，是新的备份从来没建成功过。
    // 现在把每一步都校验一遍，建不出来就直接抛异常，让更新老实报错，而不是
    // 假装成功。
    if (!is_dir(BACKUP_DIR) && !mkdir(BACKUP_DIR, 0755, true) && !is_dir(BACKUP_DIR)) {
        throw new Exception('无法创建备份目录，请检查服务器写入权限：' . BACKUP_DIR);
    }
    $name = 'backup_' . date('Ymd_His') . '_' . substr(get_local_version() ?: 'unknown', 0, 8);
    $path = BACKUP_DIR . '/' . $name;
    if (!mkdir($path, 0755, true) && !is_dir($path)) {
        throw new Exception('无法创建本次备份目录，请检查服务器写入权限：' . $path);
    }
    foreach (DEPLOY_PATHS as $p) {
        $src = __DIR__ . '/../' . $p;
        if (file_exists($src)) rcopy($src, $path . '/' . $p);
    }
    // rcopy 内部同样不检查 copy() 的返回值，这里再校验一遍每个应该存在的路径
    // 是不是真的拷过去了，漏了就说明磁盘空间/权限出了问题，备份不完整不能算数。
    foreach (DEPLOY_PATHS as $p) {
        $src = __DIR__ . '/../' . $p;
        if (file_exists($src) && !file_exists($path . '/' . $p)) {
            rrmdir($path);
            throw new Exception("备份不完整，缺少 {$p}，可能是磁盘空间不足或写入权限问题");
        }
    }
    prune_old_backups();
    return $name;
}

function deploy_from(string $sourceRoot): void {
    foreach (DEPLOY_PATHS as $p) {
        $src = $sourceRoot . '/' . $p;
        $dst = __DIR__ . '/../' . $p;
        if (!file_exists($src)) continue;
        if (is_dir($dst)) rrmdir($dst);
        elseif (is_file($dst)) @unlink($dst);
        rcopy($src, $dst);
    }
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

if ($action === 'status') {
    try {
        $commit = github_api_get('https://api.github.com/repos/' . UPDATE_REPO_OWNER . '/' . UPDATE_REPO_NAME . '/commits/' . UPDATE_REPO_BRANCH);
        $latestSha = (string)($commit['sha'] ?? '');
        if ($latestSha === '') throw new Exception('获取最新版本号失败');
        $localSha = get_local_version();
        json_out([
            'ok' => true,
            'current' => $localSha,
            'latest' => $latestSha,
            'latest_message' => trim((string)($commit['commit']['message'] ?? '')),
            'latest_date' => (string)($commit['commit']['author']['date'] ?? ''),
            'has_update' => $localSha !== '' && $localSha !== $latestSha,
            'baseline_missing' => $localSha === '',
        ]);
    } catch (Exception $e) {
        json_out(['ok' => false, 'msg' => $e->getMessage()]);
    }
}

if ($action === 'set_baseline') {
    method_must('POST');
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $sha = trim((string)($body['sha'] ?? ''));
    if ($sha === '') json_out(['ok' => false, 'msg' => '缺少版本号']);
    set_local_version($sha);
    write_log($user, '更新', '系统更新', 0, '', "设置基线版本 {$sha}");
    json_out(['ok' => true]);
}

if ($action === 'backups') {
    $list = [];
    if (is_dir(BACKUP_DIR)) {
        foreach (scandir(BACKUP_DIR) as $item) {
            if ($item === '.' || $item === '..') continue;
            $path = BACKUP_DIR . '/' . $item;
            if (is_dir($path)) $list[] = ['name' => $item, 'time' => filemtime($path)];
        }
        usort($list, fn($a, $b) => $b['time'] <=> $a['time']);
    }
    json_out(['ok' => true, 'data' => $list]);
}

if ($action === 'update') {
    method_must('POST');
    // 下载+解压+覆盖对共享主机常见的默认执行时间（比如 30 秒）来说太紧，容易被引擎强制
    // 杀掉——杀掉的时机如果正好在"覆盖到一半"，就会出现有的目录更新了、有的没更新的
    // 半吊子状态。这里放宽执行时间，并且用 register_shutdown_function 兜底：
    // 不管是被强制杀掉还是中途抛异常，只要"已经开始覆盖但还没跑完"，就自动把刚才的
    // 备份恢复回去，保证结果只有两种：完全更新成功，或者完全恢复原状，不会是中间态。
    set_time_limit(300);
    // 执行超时是 PHP Fatal error，默认会把错误文本直接输出到响应里，混在下面
    // shutdown 函数吐出的 JSON 前面，导致前端 res.json() 解析失败——关掉直接输出，
    // 改记到服务器错误日志，保证这个接口任何时候返回的都是干净的 JSON。
    ini_set('display_errors', '0');
    ini_set('log_errors', '1');

    $backupName = null;
    $deployStarted = false;
    $handled = false;

    register_shutdown_function(function () use (&$backupName, &$deployStarted, &$handled) {
        if ($handled) return;
        if ($deployStarted && $backupName) {
            $backupPath = BACKUP_DIR . '/' . $backupName;
            if (is_dir($backupPath)) deploy_from($backupPath);
        }
        if (!headers_sent()) {
            http_response_code(200);
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode([
            'ok' => false,
            'msg' => $deployStarted
                ? '更新过程被中断（可能是服务器执行超时或网络问题），已自动回滚到更新前的版本，不会是部分更新的状态'
                : '更新过程被中断（可能是网络问题），还没有开始覆盖任何文件，可以重试',
        ], JSON_UNESCAPED_UNICODE);
    });

    try {
        $commit = github_api_get('https://api.github.com/repos/' . UPDATE_REPO_OWNER . '/' . UPDATE_REPO_NAME . '/commits/' . UPDATE_REPO_BRANCH);
        $latestSha = (string)($commit['sha'] ?? '');
        if ($latestSha === '') throw new Exception('获取最新版本号失败');

        $backupName = backup_current();

        $zipUrl = 'https://codeload.github.com/' . UPDATE_REPO_OWNER . '/' . UPDATE_REPO_NAME . '/zip/refs/heads/' . UPDATE_REPO_BRANCH;
        $tmpZip = sys_get_temp_dir() . '/gloexp_update_' . uniqid() . '.zip';
        download_to_file($zipUrl, $tmpZip);

        // 下载下来的包太小/不存在，说明网络中途断了，包是残缺的——这时候还没碰过
        // 线上任何文件，直接报错让用户重试就行，不用回滚。
        if (!file_exists($tmpZip) || filesize($tmpZip) < 1024) {
            @unlink($tmpZip);
            throw new Exception('更新包下载不完整，请检查服务器网络后重试');
        }

        if (!class_exists('ZipArchive')) {
            @unlink($tmpZip);
            throw new Exception('服务器 PHP 未启用 zip 扩展，无法解压更新包');
        }
        $zip = new ZipArchive();
        if ($zip->open($tmpZip) !== true) {
            @unlink($tmpZip);
            throw new Exception('更新包解压失败');
        }
        $extractDir = sys_get_temp_dir() . '/gloexp_extract_' . uniqid();
        $zip->extractTo($extractDir);
        $zip->close();
        @unlink($tmpZip);

        // GitHub 打的 zip 顶层会带一个 "仓库名-分支名/" 前缀目录
        $topDirs = array_values(array_filter(scandir($extractDir), fn($d) => $d !== '.' && $d !== '..'));
        if (count($topDirs) !== 1 || !is_dir($extractDir . '/' . $topDirs[0])) {
            rrmdir($extractDir);
            throw new Exception('更新包结构异常');
        }
        $sourceRoot = $extractDir . '/' . $topDirs[0];

        // 开始真正覆盖线上文件之前，先确认新代码包里白名单目录都齐全——
        // 避免"包本身就下载不全"这种情况下覆盖到一半才发现缺文件。
        foreach (DEPLOY_PATHS as $p) {
            if (!file_exists($sourceRoot . '/' . $p)) {
                rrmdir($extractDir);
                throw new Exception("更新包缺少 {$p}，可能下载不完整，请重试");
            }
        }

        $deployStarted = true;
        deploy_from($sourceRoot);
        rrmdir($extractDir);

        set_local_version($latestSha);
        write_log($user, '更新', '系统更新', 0, '', "更新到版本 {$latestSha}，备份：{$backupName}");

        $handled = true;
        json_out(['ok' => true, 'version' => $latestSha, 'backup' => $backupName]);
    } catch (Exception $e) {
        if ($deployStarted && $backupName) {
            $backupPath = BACKUP_DIR . '/' . $backupName;
            if (is_dir($backupPath)) deploy_from($backupPath);
            $handled = true;
            json_out(['ok' => false, 'msg' => $e->getMessage() . '（已自动回滚到更新前版本，不会是部分更新状态）']);
        }
        $handled = true;
        json_out(['ok' => false, 'msg' => $e->getMessage()]);
    }
}

if ($action === 'rollback') {
    method_must('POST');
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $name = basename((string)($body['name'] ?? '')); // basename 防目录穿越
    $backupPath = BACKUP_DIR . '/' . $name;
    if ($name === '' || !is_dir($backupPath)) {
        json_out(['ok' => false, 'msg' => '备份不存在']);
    }
    deploy_from($backupPath);
    $matches = [];
    preg_match('/backup_\d+_\d+_([0-9a-f]+)/', $name, $matches);
    if (!empty($matches[1]) && $matches[1] !== 'unknown') {
        set_local_version($matches[1]);
    }
    write_log($user, '更新', '系统更新', 0, '', "回滚到备份 {$name}");
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => '无效操作'], 400);
