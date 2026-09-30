<?php
// GET /api/waste-logs.php   admin: every waste log;  donor: their own
// Table: WasteLog (joined with FoodDonation / Donor)
// Rows are created by the backend itself (auto-expiry in helpers.php, or a
// donor reporting waste in donations.php) - there is no create endpoint.
require_once __DIR__ . '/db.php';

$me = require_user($pdo, ['admin', 'donor']);
if (request_method() !== 'GET') {
    throw new ApiException('Method not allowed.', 405);
}

$sql = "
    SELECT w.waste_id, w.donation_id, w.quantity_wasted, w.reason, w.logged_at,
           f.category_id, f.unit, f.title, f.expiry_time, f.donor_id,
           COALESCE(NULLIF(d.org_name, ''), du.name) AS donor_name
    FROM WasteLog w
    JOIN FoodDonation f ON f.donation_id = w.donation_id
    JOIN Donor d        ON d.donor_id = f.donor_id
    JOIN AppUser du     ON du.user_id = f.donor_id
";
$params = [];
if ($me['role'] === 'donor') {
    $sql .= ' WHERE f.donor_id = ?';
    $params[] = (int) $me['user_id'];
}
$sql .= ' ORDER BY w.logged_at DESC, w.waste_id DESC';

$stmt = $pdo->prepare($sql);
$stmt->execute($params);

$out = [];
foreach ($stmt->fetchAll() as $r) {
    $out[] = [
        'wasteLogId'    => sid($r['waste_id']),
        'donationId'    => sid($r['donation_id']),
        'donationTitle' => $r['title'],
        'donorName'     => $r['donor_name'],
        'categoryId'    => sid($r['category_id']),
        'quantity'      => num($r['quantity_wasted']),
        'unit'          => $r['unit'],
        'reason'        => $r['reason'] ?? '',
        'expiresAt'     => iso($r['expiry_time']),
        'loggedAt'      => iso($r['logged_at']),
    ];
}
json_out($out);
