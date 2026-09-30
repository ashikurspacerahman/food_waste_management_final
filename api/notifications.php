<?php
// Notifications (shared by all roles)
//   GET   /api/notifications.php              the logged-in user's notifications
//   PATCH /api/notifications.php?id=5         mark one as read
//   PATCH /api/notifications.php?all=1        mark all as read
// Table: Notification. Rows are created by the other endpoints as a side
// effect (request made, accepted, picked up, delivered, ...).
require_once __DIR__ . '/db.php';

$me     = require_user($pdo);
$myId   = (int) $me['user_id'];
$method = request_method();

if ($method === 'GET') {
    $stmt = $pdo->prepare('SELECT notification_id, user_id, donation_id, message, is_read, created_at
                           FROM Notification WHERE user_id = ?
                           ORDER BY created_at DESC, notification_id DESC LIMIT 200');
    $stmt->execute([$myId]);
    $out = [];
    foreach ($stmt->fetchAll() as $n) {
        $out[] = [
            'notificationId' => sid($n['notification_id']),
            'userId'         => sid($n['user_id']),
            'donationId'     => sid($n['donation_id']),
            'message'        => $n['message'],
            'isRead'         => (int) $n['is_read'] === 1,
            'createdAt'      => iso($n['created_at']),
        ];
    }
    json_out($out);
}

if ($method === 'PATCH') {
    if (query_str('all') === '1') {
        $pdo->prepare('UPDATE Notification SET is_read = 1 WHERE user_id = ? AND is_read = 0')->execute([$myId]);
        json_out(['ok' => true]);
    }
    $id = (int) query_str('id', '0');
    if ($id <= 0) {
        throw new ApiException('Missing notification id.');
    }
    $pdo->prepare('UPDATE Notification SET is_read = 1 WHERE notification_id = ? AND user_id = ?')->execute([$id, $myId]);
    json_out(['ok' => true]);
}

throw new ApiException('Method not allowed.', 405);
