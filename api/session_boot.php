<?php
/**
 * session_boot.php — 统一的 session 启动入口，替代每个 api/*.php 里各自的
 * session_start()。
 *
 * Redis 可用就把 session 存进 Redis（内存），减少大量 session 小文件在磁盘上的
 * 读写——这是并发用户数一多时最实在的一块磁盘压力，因为几乎每个已登录用户的
 * 每次请求都会碰一下 session（哪怕只是刷新 last_seen_at）。
 * Redis 不可用（没装 redis 扩展、连不上、超时）就什么都不做，PHP 照常用它
 * 配置好的默认 handler（通常是文件），行为跟现在完全一样——这层尝试失败了
 * 也不会导致请求出错，最坏结果就是"没有加速"，不会比现在更差。
 *
 * 不碰 SQLite：这里只管 session 存哪，跟业务数据库完全无关。
 */

function _try_enable_redis_session(): void {
    if (!class_exists('Redis')) return; // 服务器没装 phpredis 扩展

    try {
        $probe = new Redis();
        // 200ms 超时——Redis 真的挂了的话，别让每个请求都在这里卡半天。
        $ok = @$probe->connect('127.0.0.1', 6379, 0.2);
        $probe->close();
        if (!$ok) return;
    } catch (\Throwable $e) {
        return;
    }

    // 连通了才切换 handler，避免 session_start() 因为连不上直接报错。
    ini_set('session.save_handler', 'redis');
    ini_set('session.save_path', 'tcp://127.0.0.1:6379?timeout=0.2');
}

if (session_status() === PHP_SESSION_NONE) {
    _try_enable_redis_session();
    session_start();
}
