<?php
// POST /api/forgot-password.php   { email }
// Tables: AppUser (reset_token, reset_expires)
//
// The same message is returned whether or not the email exists. Because a
// classroom XAMPP has no mail server, the reset link is returned in the
// response so it can be shown on screen (a real system would email it).
require_once __DIR__ . '/db.php';

if (request_method() !== 'POST') {
    throw new ApiException('Method not allowed.', 405);
}

$email = body_str('email');
if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    throw new ApiException('Enter the email address you registered with.');
}

$response = ['message' => 'If this email is registered, a reset link has been generated below.'];

$stmt = $pdo->prepare('SELECT user_id FROM AppUser WHERE email = ?');
$stmt->execute([$email]);
$user = $stmt->fetch();

if ($user) {
    $token = bin2hex(random_bytes(32));     // 64-character random token
    // The 30-minute expiry is computed by MySQL itself (NOW()), not PHP, so a
    // PHP/MySQL timezone mismatch can never make the link look expired.
    $pdo->prepare('UPDATE AppUser SET reset_token = ?, reset_expires = NOW() + INTERVAL 30 MINUTE WHERE user_id = ?')
        ->execute([$token, $user['user_id']]);
    log_action($pdo, $user['user_id'], 'UPDATE', 'AppUser', $user['user_id'], 'Requested a password reset link.');
    $response['resetLink'] = 'reset-password.html?token=' . $token;
}

json_out($response);
