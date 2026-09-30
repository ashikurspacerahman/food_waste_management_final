<?php
// POST /api/register.php
// Creates the AppUser row AND the role-specific subclass row (Donor /
// Recipient / Volunteer) in ONE transaction - both must succeed together
// (ISA design). Admin accounts are intentionally not creatable here.
// Tables: AppUser, Donor (+Address), Recipient, Volunteer
require_once __DIR__ . '/db.php';

if (request_method() !== 'POST') {
    throw new ApiException('Method not allowed.', 405);
}

$role     = body_str('role');
$name     = body_str('name');
$email    = body_str('email');
$phone    = body_str('phone');
$address  = body_str('address');
$body     = read_body();
$password = isset($body['password']) && is_scalar($body['password']) ? (string) $body['password'] : '';

if (text_length($name) < 2 || text_length($name) > 100) {
    throw new ApiException('Enter your full name.');
}
if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || text_length($email) > 150) {
    throw new ApiException('Enter a valid email address.');
}
if (text_length($phone) < 7 || text_length($phone) > 30) {
    throw new ApiException('Enter a valid phone number.');
}
if (strlen($password) < 6) {
    throw new ApiException('Password must be at least 6 characters.');
}
if (text_length($address) < 5 || text_length($address) > 255) {
    throw new ApiException('Enter your address.');
}
if (!in_array($role, ['donor', 'recipient', 'volunteer'], true)) {
    throw new ApiException('Please choose a valid role.');
}

$check = $pdo->prepare('SELECT user_id FROM AppUser WHERE email = ?');
$check->execute([$email]);
if ($check->fetch()) {
    throw new ApiException('An account with that email already exists.', 409);
}

$organization = short_text(body_str('organizationName'), 150);
$organization = $organization === '' ? null : $organization;

try {
    $userId = with_transaction($pdo, function () use ($pdo, $role, $name, $email, $phone, $address, $password, $organization) {
        $stmt = $pdo->prepare(
            "INSERT INTO AppUser (name, email, password, role, phone, address) VALUES (?, ?, ?, ?, ?, ?)"
        );
        $stmt->execute([$name, $email, password_hash($password, PASSWORD_DEFAULT), $role, $phone, $address]);
        $userId = (int) $pdo->lastInsertId();

        if ($role === 'donor') {
            $addressId = save_address($pdo, $address);
            $pdo->prepare("INSERT INTO Donor (donor_id, donor_type, org_name, address_id) VALUES (?, ?, ?, ?)")
                ->execute([$userId, donor_type_enum(body_str('donorType')), $organization, $addressId]);
        } elseif ($role === 'recipient') {
            $pdo->prepare("INSERT INTO Recipient (recipient_id, recipient_type, org_name) VALUES (?, ?, ?)")
                ->execute([$userId, recipient_type_enum(body_str('recipientType')), $organization]);
        } else {
            $vehicle = short_text(body_str('vehicleType'), 50);
            $note    = short_text(body_str('availability'), 150);
            $pdo->prepare("INSERT INTO Volunteer (volunteer_id, vehicle_type, availability, availability_note)
                           VALUES (?, ?, 'available', ?)")
                ->execute([$userId, $vehicle === '' ? null : $vehicle, $note === '' ? null : $note]);
        }

        log_action($pdo, $userId, 'INSERT', 'AppUser', $userId, 'New ' . $role . ' account registered: ' . $name . '.');
        return $userId;
    });
} catch (PDOException $e) {
    if ($e->getCode() === '23000') {          // duplicate email (race with the check above)
        throw new ApiException('An account with that email already exists.', 409);
    }
    throw $e;
}

json_out(map_user(fetch_user_row($pdo, $userId)), 201);
