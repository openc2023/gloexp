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

if (session_status() === PHP_SESSION_NONE) {
    session_start();
}
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
        'timeout' => 60,
        'follow_location' => 1,
    ]]);
    $data = @file_get_contents($url, false, $ctx);
    if ($data === false) {
        throw new Exception('下载更新包失败');
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

function backup_current(): string {
    if (!is_dir(BACKUP_DIR)) mkdir(BACKUP_DIR, 0755, true);
    $name = 'backup_' . date('Ymd_His') . '_' . substr(get_local_version() ?: 'unknown', 0, 8);
    $path = BACKUP_DIR . '/' . $name;
    mkdir($path, 0755, true);
    foreach (DEPLOY_PATHS as $p) {
        $src = __DIR__ . '/../' . $p;
        if (file_exists($src)) rcopy($src, $path . '/' . $p);
    }
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
    try {
        $commit = github_api_get('https://api.github.com/repos/' . UPDATE_REPO_OWNER . '/' . UPDATE_REPO_NAME . '/commits/' . UPDATE_REPO_BRANCH);
        $latestSha = (string)($commit['sha'] ?? '');
        if ($latestSha === '') throw new Exception('获取最新版本号失败');

        $backupName = backup_current();

        $zipUrl = 'https://codeload.github.com/' . UPDATE_REPO_OWNER . '/' . UPDATE_REPO_NAME . '/zip/refs/heads/' . UPDATE_REPO_BRANCH;
        $tmpZip = sys_get_temp_dir() . '/gloexp_update_' . uniqid() . '.zip';
        download_to_file($zipUrl, $tmpZip);

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
        deploy_from($extractDir . '/' . $topDirs[0]);
        rrmdir($extractDir);

        set_local_version($latestSha);
        write_log($user, '更新', '系统更新', 0, '', "更新到版本 {$latestSha}，备份：{$backupName}");
        json_out(['ok' => true, 'version' => $latestSha, 'backup' => $backupName]);
    } catch (Exception $e) {
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
