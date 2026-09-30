<?php
// Users
//   GET   /api/users.php                    admin: every user
//   GET   /api/users.php?id=5               admin, or the user themself
//   PATCH /api/users.php?id=5  { status }   admin: activate / deactivate
//   PATCH /api/users.php?id=5  { name, email, phone, address, organizationName,
//                                donorType, recipientType, vehicleType, availability }
//                                           the user themself (profile page)
//   POST  /api/users.php?action=password { currentPassword, newPassword }
// Tables: AppUser, Donor (+Address), Recipient, Volunteer, AuditLog
require_once __DIR__ . '/db.php';

$me     = require_user($pdo);
$method = request_method();
$myId   = (int) $me['user_id'];

/* ---------- POST ?action=password : change my own password ---------- */
if ($method === 'POST' && query_str('action') === 'password') {
    $body    = read_body();
    $current = isset($body['currentPassword']) && is_scalar($body['currentPassword']) ? (string) $body['currentPassword'] : '';
    $new     = isset($body['newPassword']) && is_scalar($body['newPassword']) ? (string) $body['newPassword'] : '';

    $stmt = $pdo->prepare('SELECT password FROM AppUser WHERE user_id = ?');
    $stmt->execute([$myId]);
    $hash = $stmt->fetch()['password'];

    if (!password_verify($current, $hash)) {
        throw new ApiException('Your current password is incorrect.', 400);
    }
    if (strlen($new) < 6) {
        throw new ApiException('The new password must be at least 6 characters.');
    }
    $pdo->prepare('UPDATE AppUser SET password = ? WHERE user_id = ?')
        ->execute([password_hash($new, PASSWORD_DEFAULT), $myId]);
    log_action($pdo, $myId, 'UPDATE', 'AppUser', $myId, 'Changed their password.');
    json_out(['message' => 'Password updated.']);
}

/* ---------- GET ---------- */
if ($method === 'GET') {
    $id = (int) query_str('id', '0');
    if ($id > 0) {
        if ($me['role'] !== 'admin' && $id !== $myId) {
            throw new ApiException('You do not have permission to do that.', 403);
        }
        $row = fetch_user_row($pdo, $id);
        if (!$row) {
            throw new ApiException('User not found.', 404);
        }
        json_out(map_user($row));
    }

    if ($me['role'] !== 'admin') {
        // Non-admins only ever need their own record; return just that.
        json_out([map_user($me)]);
    }
    $rows = $pdo->query(user_select_sql() . ' ORDER BY u.created_at DESC, u.user_id DESC')->fetchAll();
    json_out(array_map('map_user', $rows));
}

/* ---------- PATCH ---------- */
if ($method === 'PATCH') {
    $id = (int) query_str('id', '0');
    if ($id <= 0) {
        throw new ApiException('Missing user id.');
    }
    $target = fetch_user_row($pdo, $id);
    if (!$target) {
        throw new ApiException('User not found.', 404);
    }

    // ---- Admin: activate / deactivate ----
    if (body_has('status')) {
        if ($me['role'] !== 'admin') {
            throw new ApiException('Only an administrator can change an account status.', 403);
        }
        $status = body_str('status');
        if (!in_array($status, ['active', 'inactive'], true)) {
            throw new ApiException('Invalid status.');
        }
        if ($id === $myId) {
            throw new ApiException('You cannot deactivate your own account.');
        }
        $pdo->prepare('UPDATE AppUser SET status = ? WHERE user_id = ?')->execute([$status, $id]);
        log_action($pdo, $myId, 'UPDATE', 'AppUser', $id,
            ($status === 'active' ? 'Activated' : 'Deactivated') . ' ' . $target['role'] . ' account for ' . $target['name'] . '.');
        json_out(map_user(fetch_user_row($pdo, $id)));
    }

    // ---- Profile edit (self only) ----
    if ($id !== $myId) {
        throw new ApiException('You can only edit your own profile.', 403);
    }

    $name    = body_str('name', $target['name']);
    $email   = body_str('email', $target['email']);
    $phone   = body_str('phone', (string) $target['phone']);
    $address = body_str('address', (string) $target['address']);

    if (text_length($name) < 2 || text_length($name) > 100) {
        throw new ApiException('Enter your full name.');
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) || text_length($email) > 150) {
        throw new ApiException('Enter a valid email address.');
    }
    if (text_length($phone) < 7 || text_length($phone) > 30) {
        throw new ApiException('Enter a valid phone number.');
    }
    if (text_length($address) < 5 || text_length($address) > 255) {
        throw new ApiException('Enter your address.');
    }

    $dup = $pdo->prepare('SELECT user_id FROM AppUser WHERE email = ? AND user_id <> ?');
    $dup->execute([$email, $myId]);
    if ($dup->fetch()) {
        throw new ApiException('Another account already uses that email.', 409);
    }

    with_transaction($pdo, function () use ($pdo, $me, $myId, $name, $email, $phone, $address) {
        $pdo->prepare('UPDATE AppUser SET name = ?, email = ?, phone = ?, address = ? WHERE user_id = ?')
            ->execute([$name, $email, $phone, $address, $myId]);

        if ($me['role'] === 'donor') {
            $org = body_has('organizationName') ? short_text(body_str('organizationName'), 150) : (string) $me['donor_org'];
            $type = body_has('donorType') ? donor_type_enum(body_str('donorType')) : $me['donor_type'];
            $cur = $pdo->prepare('SELECT address_id FROM Donor WHERE donor_id = ?');
            $cur->execute([$myId]);
            $addressId = save_address($pdo, $address, $cur->fetch()['address_id']);
            $pdo->prepare('UPDATE Donor SET donor_type = ?, org_name = ?, address_id = ? WHERE donor_id = ?')
                ->execute([$type, $org === '' ? null : $org, $addressId, $myId]);
        } elseif ($me['role'] === 'recipient') {
            $org = body_has('organizationName') ? short_text(body_str('organizationName'), 150) : (string) $me['recipient_org'];
            $type = body_has('recipientType') ? recipient_type_enum(body_str('recipientType')) : $me['recipient_type'];
            $pdo->prepare('UPDATE Recipient SET recipient_type = ?, org_name = ? WHERE recipient_id = ?')
                ->execute([$type, $org === '' ? null : $org, $myId]);
        } elseif ($me['role'] === 'volunteer') {
            $vehicle = body_has('vehicleType') ? short_text(body_str('vehicleType'), 50) : (string) $me['vehicle_type'];
            $note    = body_has('availability') ? short_text(body_str('availability'), 150) : (string) $me['availability_note'];
            $pdo->prepare('UPDATE Volunteer SET vehicle_type = ?, availability_note = ? WHERE volunteer_id = ?')
                ->execute([$vehicle === '' ? null : $vehicle, $note === '' ? null : $note, $myId]);
        }

        log_action($pdo, $myId, 'UPDATE', 'AppUser', $myId, 'Updated their profile.');
    });

    json_out(map_user(fetch_user_row($pdo, $myId)));
}

throw new ApiException('Method not allowed.', 405);
