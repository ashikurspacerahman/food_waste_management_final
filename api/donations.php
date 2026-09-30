<?php
// Donations
//   GET   /api/donations.php[?id=&status=&donorId=&categoryId=]
//   POST  /api/donations.php            donor: post (or save as draft) a donation
//   PATCH /api/donations.php?id=  { status: 'cancelled' | 'available' | 'wasted', reason? }
//         donor only: cancel, publish a draft, or report food as wasted
//   POST  /api/donations.php?id=&action=image   donor only: add / replace the food photo
//         (multipart/form-data, field "image"; JPEG/PNG/WebP, max 5 MB)
// Photos: POST /api/donations.php also accepts multipart/form-data with an optional
//   "image" file. The file is saved in uploads/food/ and only its relative path is
//   stored in DonationImage.image_url (see image-helpers.php).
// Tables: FoodDonation, Address, DonationImage, FoodCategory, WasteLog,
//         Request (pending requests are closed when a donation is withdrawn)
//
// Status shown to the frontend:  available | pending (a request is waiting) |
//   claimed (request accepted) | delivered | expired | wasted | draft | cancelled
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/image-helpers.php';

$me     = require_user($pdo);
$myId   = (int) $me['user_id'];
$method = request_method();

/* Close every pending request on a donation that is being withdrawn. */
function close_pending_requests(PDO $pdo, array $don, $message) {
    $stmt = $pdo->prepare("SELECT request_id, recipient_id FROM Request WHERE donation_id = ? AND status = 'pending'");
    $stmt->execute([$don['donation_id']]);
    foreach ($stmt->fetchAll() as $rq) {
        $pdo->prepare("UPDATE Request SET status = 'rejected' WHERE request_id = ?")->execute([$rq['request_id']]);
        notify_user($pdo, $rq['recipient_id'], $don['donation_id'], $message);
    }
}

/* ===================== GET ===================== */
if ($method === 'GET') {
    $where  = [];
    $params = [];

    // Who may see what
    if ($me['role'] === 'donor') {
        $where[]  = 'f.donor_id = ?';
        $params[] = $myId;
    } elseif ($me['role'] === 'recipient') {
        $where[]  = "(f.status = 'available' OR EXISTS (SELECT 1 FROM Request rr
                       WHERE rr.donation_id = f.donation_id AND rr.recipient_id = ?))";
        $params[] = $myId;
    } elseif ($me['role'] === 'volunteer') {
        $where[]  = "EXISTS (SELECT 1 FROM Request rr
                       LEFT JOIN PickupAssignment pp ON pp.request_id = rr.request_id AND pp.status <> 'cancelled'
                       WHERE rr.donation_id = f.donation_id
                         AND ((rr.status = 'approved' AND pp.assignment_id IS NULL) OR pp.volunteer_id = ?))";
        $params[] = $myId;
    }   // admin: everything

    $id = (int) query_str('id', '0');
    if ($id > 0) {
        $where[]  = 'f.donation_id = ?';
        $params[] = $id;
    }
    if (query_str('status') !== '') {
        $dbStatus = donation_status_in(query_str('status'));
        if ($dbStatus === null) {
            json_out([]);
        }
        $where[]  = 'f.status = ?';
        $params[] = $dbStatus;
    }
    if ((int) query_str('donorId', '0') > 0) {
        $where[]  = 'f.donor_id = ?';
        $params[] = (int) query_str('donorId');
    }
    if ((int) query_str('categoryId', '0') > 0) {
        $where[]  = 'f.category_id = ?';
        $params[] = (int) query_str('categoryId');
    }

    $sql = donation_select_sql();
    if ($where) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY f.created_at DESC, f.donation_id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    if ($id > 0) {
        if (!$rows) {
            throw new ApiException('Donation not found.', 404);
        }
        json_out(map_donation($rows[0]));
    }
    json_out(array_map('map_donation', $rows));
}

/* ===================== POST ?action=image : add / replace the photo ===================== */
if ($method === 'POST' && query_str('action') === 'image') {
    if ($me['role'] !== 'donor') {
        throw new ApiException('Only the donor can change a donation photo.', 403);
    }
    $id = (int) query_str('id', '0');
    if ($id <= 0) {
        throw new ApiException('Missing donation id.');
    }

    $image = validate_food_image($_FILES['image'] ?? null);
    if ($image === null) {
        throw new ApiException('Choose an image to upload.');
    }

    // Ownership check in SQL: someone else's donation looks exactly like a missing one.
    $chk = $pdo->prepare('SELECT donation_id, title, status FROM FoodDonation WHERE donation_id = ? AND donor_id = ?');
    $chk->execute([$id, $myId]);
    $don = $chk->fetch();
    if (!$don) {
        throw new ApiException('Donation not found.', 404);
    }
    if (!in_array($don['status'], ['draft', 'available', 'requested'], true)) {
        throw new ApiException('The photo of a donation that is already assigned, delivered or closed cannot be changed.', 409);
    }

    $stored = null;
    try {
        $stored = store_food_image($image);
        $oldPaths = with_transaction($pdo, function () use ($pdo, $myId, $id, $don, $stored) {
            $sel = $pdo->prepare('SELECT image_url FROM DonationImage WHERE donation_id = ? FOR UPDATE');
            $sel->execute([$id]);
            $old = $sel->fetchAll(PDO::FETCH_COLUMN);          // this donation's images only

            $pdo->prepare('DELETE FROM DonationImage WHERE donation_id = ?')->execute([$id]);
            $pdo->prepare('INSERT INTO DonationImage (donation_id, image_url) VALUES (?, ?)')
                ->execute([$id, $stored['path']]);

            log_action($pdo, $myId, 'UPDATE', 'DonationImage', $id,
                ($old ? 'Replaced' : 'Added') . ' the photo of "' . $don['title'] . '".');
            return $old;
        });
    } catch (Throwable $e) {
        if ($stored !== null) {
            discard_food_image_file($stored['abs']);
        }
        throw $e;
    }

    // The database now points at the new file: only now remove the old file(s).
    foreach ($oldPaths as $oldPath) {
        delete_food_image_by_path($oldPath);
    }

    json_out(map_donation(fetch_donation_row($pdo, $id)));
}

/* ===================== POST : create ===================== */
if ($method === 'POST') {
    if ($me['role'] !== 'donor') {
        throw new ApiException('Only donors can post donations.', 403);
    }

    $title       = body_str('title');
    $categoryId  = (int) body_str('categoryId', '0');
    $description = short_text(body_str('description'), 2000);
    $quantity    = body_str('quantity');
    $unit        = body_str('unit');
    $pickup      = body_str('pickupAddress');
    $contact     = short_text(body_str('contact'), 50);
    $notes       = short_text(body_str('notes'), 255);
    $asDraft     = body_str('status') === 'draft';

    $expires  = normalize_datetime(body_str('expiresAt'));
    $prepared = body_str('preparedAt') === '' ? null : normalize_datetime(body_str('preparedAt'));

    if (text_length($title) < 3 || text_length($title) > 150) {
        throw new ApiException('Enter a food title (3 to 150 characters).');
    }
    if (!is_numeric($quantity) || (float) $quantity <= 0 || (float) $quantity > 99999999) {
        throw new ApiException('Enter a valid quantity greater than zero.');
    }
    if ($unit === '' || text_length($unit) > 30) {
        throw new ApiException('Choose a unit.');
    }
    if ($expires === null) {
        throw new ApiException('Enter a valid expiry date and time.');
    }
    if (body_str('preparedAt') !== '' && $prepared === null) {
        throw new ApiException('Enter a valid preparation date and time.');
    }
    if ($prepared !== null && $expires <= $prepared) {
        throw new ApiException('Expiry must be later than the preparation time.');
    }
    if (!$asDraft && !is_future_datetime($pdo, $expires)) {
        throw new ApiException('Expiry must be in the future.');
    }
    if (text_length($pickup) < 5) {
        throw new ApiException('Enter the pickup address.');
    }
    if ($categoryId > 0) {
        $c = $pdo->prepare('SELECT category_id FROM FoodCategory WHERE category_id = ?');
        $c->execute([$categoryId]);
        if (!$c->fetch()) {
            throw new ApiException('That food category does not exist.');
        }
    }

    // Check the photo BEFORE anything is written (nothing is stored if it is bad).
    $image = validate_food_image($_FILES['image'] ?? null);

    $stored = null;      // the file we saved, so it can be removed if the database step fails
    try {
    if ($image !== null) {
        $stored = store_food_image($image);
    }

    $donationId = with_transaction($pdo, function () use (
        $pdo, $myId, $title, $categoryId, $description, $quantity, $unit, $pickup, $contact, $notes,
        $stored, $asDraft, $expires, $prepared
    ) {
        $addressId = save_address($pdo, $pickup);

        $pdo->prepare("
            INSERT INTO FoodDonation
                (donor_id, category_id, address_id, title, description, quantity, unit,
                 prepared_at, expiry_time, contact, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ")->execute([
            $myId,
            $categoryId > 0 ? $categoryId : null,
            $addressId,
            $title,
            $description === '' ? null : $description,
            $quantity,
            $unit,
            $prepared,
            $expires,
            $contact === '' ? null : $contact,
            $notes === '' ? null : $notes,
            $asDraft ? 'draft' : 'available',
        ]);
        $donationId = (int) $pdo->lastInsertId();

        if ($stored !== null) {
            $pdo->prepare('INSERT INTO DonationImage (donation_id, image_url) VALUES (?, ?)')
                ->execute([$donationId, $stored['path']]);
        }

        log_action($pdo, $myId, 'INSERT', 'FoodDonation', $donationId,
            ($asDraft ? 'Saved draft donation "' : 'Posted donation "') . $title . '" (' . $quantity . ' ' . $unit . ').');
        return $donationId;
    });
    } catch (Throwable $e) {
        if ($stored !== null) {
            discard_food_image_file($stored['abs']);     // no orphaned file
        }
        throw $e;
    }

    json_out(map_donation(fetch_donation_row($pdo, $donationId)), 201);
}

/* ===================== PATCH : cancel / publish / mark wasted ===================== */
if ($method === 'PATCH') {
    if ($me['role'] !== 'donor') {
        throw new ApiException('Only the donor can change a donation.', 403);
    }
    $id = (int) query_str('id', '0');
    if ($id <= 0) {
        throw new ApiException('Missing donation id.');
    }
    $newStatus = donation_status_in(body_str('status'));

    with_transaction($pdo, function () use ($pdo, $myId, $id, $newStatus) {
        $stmt = $pdo->prepare('SELECT * FROM FoodDonation WHERE donation_id = ? FOR UPDATE');
        $stmt->execute([$id]);
        $don = $stmt->fetch();
        if (!$don || (int) $don['donor_id'] !== $myId) {
            throw new ApiException('Donation not found.', 404);
        }

        if ($newStatus === 'cancelled') {
            if (!in_array($don['status'], ['available', 'requested', 'draft'], true)) {
                throw new ApiException('This donation can no longer be cancelled.', 409);
            }
            close_pending_requests($pdo, $don, 'Your request for "' . $don['title'] . '" was closed because the donor cancelled it.');
            $pdo->prepare("UPDATE FoodDonation SET status = 'cancelled' WHERE donation_id = ?")->execute([$id]);
            log_action($pdo, $myId, 'UPDATE', 'FoodDonation', $id, 'Cancelled donation "' . $don['title'] . '".');

        } elseif ($newStatus === 'available') {                  // publish a draft
            if ($don['status'] !== 'draft') {
                throw new ApiException('Only a draft can be published.', 409);
            }
            if (!is_future_datetime($pdo, $don['expiry_time'])) {
                throw new ApiException('This draft has already passed its expiry time. Create a new donation instead.', 409);
            }
            $pdo->prepare("UPDATE FoodDonation SET status = 'available' WHERE donation_id = ?")->execute([$id]);
            log_action($pdo, $myId, 'UPDATE', 'FoodDonation', $id, 'Published draft donation "' . $don['title'] . '".');

        } elseif ($newStatus === 'wasted') {                     // donor reports it as wasted
            if (!in_array($don['status'], ['available', 'requested'], true)) {
                throw new ApiException('Only food that is still waiting for pickup can be marked as wasted.', 409);
            }
            $qty = body_str('quantityWasted');
            $qty = (is_numeric($qty) && (float) $qty > 0 && (float) $qty <= (float) $don['quantity']) ? $qty : $don['quantity'];
            $reason = short_text(body_str('reason'), 255);
            if ($reason === '') {
                $reason = 'Marked as wasted by the donor';
            }
            close_pending_requests($pdo, $don, 'Your request for "' . $don['title'] . '" was closed because the food could not be given out.');
            $pdo->prepare("INSERT INTO WasteLog (donation_id, quantity_wasted, reason) VALUES (?, ?, ?)")
                ->execute([$id, $qty, $reason]);
            $wasteId = (int) $pdo->lastInsertId();
            $pdo->prepare("UPDATE FoodDonation SET status = 'wasted' WHERE donation_id = ?")->execute([$id]);
            log_action($pdo, $myId, 'INSERT', 'WasteLog', $wasteId, 'Reported "' . $don['title'] . '" as wasted: ' . $reason);

        } else {
            throw new ApiException('That status change is not allowed. Statuses such as claimed and delivered are set automatically.', 400);
        }
    });

    json_out(map_donation(fetch_donation_row($pdo, $id)));
}

throw new ApiException('Method not allowed.', 405);
