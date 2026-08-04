<?php
/**
 * upload.php - image upload and deletion.
 */

session_start();
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

$user = require_auth();
if (!can($user, 'parcels', 'edit') && !can($user, 'inbound', 'edit')) {
    json_out(['ok' => false, 'msg' => 'No upload permission'], 403);
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    if (empty($_FILES['file'])) {
        json_out(['ok' => false, 'msg' => 'No file uploaded']);
    }

    $file = $_FILES['file'];
    $maxSize = 50 * 1024 * 1024;

    if ($file['error'] !== UPLOAD_ERR_OK) {
        json_out(['ok' => false, 'msg' => 'Upload failed: ' . $file['error']]);
    }
    if ($file['size'] > $maxSize) {
        json_out(['ok' => false, 'msg' => 'File size cannot exceed 50MB']);
    }

    $allowedMime = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    $info = @getimagesize($file['tmp_name']);
    $mime = $info && isset($info[2])
        ? image_type_to_mime_type($info[2])
        : (function_exists('mime_content_type') ? mime_content_type($file['tmp_name']) : '');

    if (!in_array($mime, $allowedMime, true)) {
        json_out(['ok' => false, 'msg' => 'Only JPG/PNG/WebP/HEIC images are supported']);
    }

    $mimeExt = [
        'image/jpeg' => 'jpg',
        'image/png'  => 'png',
        'image/webp' => 'webp',
        'image/heic' => 'heic',
        'image/heif' => 'heic',
    ];
    $ext = $mimeExt[$mime] ?? 'jpg';

    $dir = __DIR__ . '/../uploads/' . date('Y') . '/' . date('m') . '/';
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }

    $filename = uniqid('img_', true) . '.' . $ext;
    $dest = $dir . $filename;

    if (!move_uploaded_file($file['tmp_name'], $dest)) {
        json_out(['ok' => false, 'msg' => 'Failed to save uploaded file']);
    }

    $path = 'uploads/' . date('Y') . '/' . date('m') . '/' . $filename;
    json_out(['ok' => true, 'path' => $path]);
}

if ($method === 'DELETE') {
    $path = preg_replace('/\.\./', '', $_GET['path'] ?? '');
    if (!preg_match('#^uploads/#', $path)) {
        json_out(['ok' => false, 'msg' => 'Invalid file path']);
    }

    $full = __DIR__ . '/../' . $path;
    if (file_exists($full)) {
        @unlink($full);
    }
    json_out(['ok' => true]);
}

json_out(['ok' => false, 'msg' => 'Method not allowed'], 405);
