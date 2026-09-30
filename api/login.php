<?php
// POST /api/login.php   { email, password }   ->  user object
// Tables: AppUser (+ Donor / Recipient / Volunteer for the profile fields), AuditLog
require_once __DIR__ . '/db.php';

if (request_method() !== 'POST') {
    throw new ApiException('Method not allowed.', 405);
}

$email    = body_str('email');
$body     = read_body();
$password = isset($body['password']) && is_scalar($body['password']) ? (string) $body['password'] : '';

if ($email === '' || $password === '') {
    throw new ApiException('Enter your email and password.', 400);
}

$stmt = $pdo->prepare('SELECT user_id, password, status FROM AppUser WHERE email = ?');
$stmt->execute([$email]);
$row = $stmt->fetch();

if (!$row || !password_verify($password, $row['password'])) {
    throw new ApiException('Invalid email or password.', 401);
}
if ($row['status'] !== 'active') {
    throw new ApiException('This account has been deactivated. Please contact an administrator.', 403);
}

session_regenerate_id(true);
$_SESSION['user_id'] = (int) $row['user_id'];

log_action($pdo, $row['user_id'], 'LOGIN', 'AppUser', $row['user_id'], 'Signed in.');

json_out(map_user(fetch_user_row($pdo, $row['user_id'])));
