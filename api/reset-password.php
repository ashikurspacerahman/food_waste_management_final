<?php
// GET  /api/reset-password.php?token=...            -> { valid: true } or 400
// POST /api/reset-password.php { token, password }  -> sets the new password
// Tables: AppUser (reset_token, reset_expires, password)
require_once __DIR__ . '/db.php';

$method = request_method();
$token  = $method === 'GET' ? query_str('token') : body_str('token');

if ($token === '' || strlen($token) > 64) {
    throw new ApiException('This reset link is invalid or has expired. Please request a new one.', 400);
}

$stmt = $pdo->prepare('SELECT user_id FROM AppUser WHERE reset_token = ? AND reset_expires > NOW()');
$stmt->execute([$token]);
$user = $stmt->fetch();

if (!$user) {
    throw new ApiException('This reset link is invalid or has expired. Please request a new one.', 400);
}

if ($method === 'GET') {
    json_out(['valid' => true]);
}
if ($method !== 'POST') {
    throw new ApiException('Method not allowed.', 405);
}

$body     = read_body();
$password = isset($body['password']) && is_scalar($body['password']) ? (string) $body['password'] : '';
if (strlen($password) < 6) {
    throw new ApiException('Password must be at least 6 characters.');
}

// Update the password AND clear the token so the link cannot be reused.
$pdo->prepare('UPDATE AppUser SET password = ?, reset_token = NULL, reset_expires = NULL WHERE user_id = ?')
    ->execute([password_hash($password, PASSWORD_DEFAULT), $user['user_id']]);
log_action($pdo, $user['user_id'], 'UPDATE', 'AppUser', $user['user_id'], 'Password was reset with a reset link.');

json_out(['message' => 'Password updated. You can now log in.']);
