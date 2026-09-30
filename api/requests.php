<?php
// Requests
//   GET   /api/requests.php[?id=&donationId=&recipientId=&status=]
//   POST  /api/requests.php   recipient: request food from an available donation
//   PATCH /api/requests.php?id=  { status: 'accepted' | 'rejected' }   donor decides
// Tables: Request, FoodDonation, Notification, AuditLog
//
// Rules (from the team's schema notes):
//  * a donation is locked (status 'requested') as soon as one request is made;
//  * rejecting a request re-opens the donation;
//  * accepting sets the donation to 'assigned' and tells volunteers a pickup is open.
require_once __DIR__ . '/db.php';

$me     = require_user($pdo);
$myId   = (int) $me['user_id'];
$method = request_method();

/* ===================== GET ===================== */
if ($method === 'GET') {
    $where  = [];
    $params = [];

    if ($me['role'] === 'donor') {
        $where[]  = 'f.donor_id = ?';
        $params[] = $myId;
    } elseif ($me['role'] === 'recipient') {
        $where[]  = 'r.recipient_id = ?';
        $params[] = $myId;
    } elseif ($me['role'] === 'volunteer') {
        $where[]  = "((r.status = 'approved' AND pa.assignment_id IS NULL) OR pa.volunteer_id = ?)";
        $params[] = $myId;
    }   // admin: everything

    $id = (int) query_str('id', '0');
    if ($id > 0) {
        $where[]  = 'r.request_id = ?';
        $params[] = $id;
    }
    if ((int) query_str('donationId', '0') > 0) {
        $where[]  = 'r.donation_id = ?';
        $params[] = (int) query_str('donationId');
    }
    if ((int) query_str('recipientId', '0') > 0) {
        $where[]  = 'r.recipient_id = ?';
        $params[] = (int) query_str('recipientId');
    }
    $status = query_str('status');
    if ($status === 'accepted') {
        $where[] = "r.status IN ('approved', 'fulfilled')";
    } elseif (in_array($status, ['pending', 'rejected'], true)) {
        $where[]  = 'r.status = ?';
        $params[] = $status;
    } elseif ($status !== '') {
        json_out([]);
    }

    $sql = request_select_sql();
    if ($where) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY r.created_at DESC, r.request_id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    if ($id > 0) {
        if (!$rows) {
            throw new ApiException('Request not found.', 404);
        }
        json_out(map_request($rows[0]));
    }
    json_out(array_map('map_request', $rows));
}

/* ===================== POST : recipient submits a request ===================== */
if ($method === 'POST') {
    if ($me['role'] !== 'recipient') {
        throw new ApiException('Only recipients can request food.', 403);
    }
    $donationId = (int) body_str('donationId', '0');
    $qty        = body_str('requestedQuantity');
    $people     = body_str('peopleToServe');
    $notes      = short_text(body_str('notes'), 255);
    $pickupPref = short_text(body_str('preferredPickup'), 255);

    if ($donationId <= 0) {
        throw new ApiException('Choose a donation to request.');
    }
    if (!is_numeric($qty) || (float) $qty <= 0) {
        throw new ApiException('Enter a valid quantity.');
    }
    if ($people !== '' && (!ctype_digit($people) || (int) $people < 1)) {
        throw new ApiException('Enter how many people this will serve.');
    }
    $recipientName = ($me['recipient_org'] !== null && $me['recipient_org'] !== '') ? $me['recipient_org'] : $me['name'];

    $requestId = with_transaction($pdo, function () use ($pdo, $myId, $donationId, $qty, $people, $notes, $pickupPref, $recipientName) {
        $stmt = $pdo->prepare("SELECT donation_id, donor_id, title, quantity, unit, status, (expiry_time > NOW()) AS live
                               FROM FoodDonation WHERE donation_id = ? FOR UPDATE");
        $stmt->execute([$donationId]);
        $don = $stmt->fetch();

        if (!$don) {
            throw new ApiException('Donation not found.', 404);
        }
        if ($don['status'] !== 'available' || (int) $don['live'] !== 1) {
            throw new ApiException('This donation is no longer available to request.', 409);
        }
        if ((float) $qty > (float) $don['quantity']) {
            throw new ApiException('Requested quantity exceeds the available amount (' . (float) $don['quantity'] . ' ' . $don['unit'] . ').');
        }

        $pdo->prepare("INSERT INTO Request (recipient_id, donation_id, requested_qty, people_to_serve, notes, preferred_pickup, status)
                       VALUES (?, ?, ?, ?, ?, ?, 'pending')")
            ->execute([$myId, $donationId, $qty, $people === '' ? null : (int) $people,
                       $notes === '' ? null : $notes, $pickupPref === '' ? null : $pickupPref]);
        $requestId = (int) $pdo->lastInsertId();

        $pdo->prepare("UPDATE FoodDonation SET status = 'requested' WHERE donation_id = ?")->execute([$donationId]);

        notify_user($pdo, $don['donor_id'], $donationId,
            $recipientName . ' requested ' . (float) $qty . ' ' . $don['unit'] . ' of "' . $don['title'] . '".');
        log_action($pdo, $myId, 'INSERT', 'Request', $requestId,
            'Requested ' . (float) $qty . ' ' . $don['unit'] . ' from "' . $don['title'] . '".');
        return $requestId;
    });

    json_out(map_request(fetch_request_row($pdo, $requestId)), 201);
}

/* ===================== PATCH : donor accepts / rejects ===================== */
if ($method === 'PATCH') {
    if ($me['role'] !== 'donor') {
        throw new ApiException('Only the donor can accept or reject a request.', 403);
    }
    $id       = (int) query_str('id', '0');
    $decision = body_str('status');
    if ($id <= 0) {
        throw new ApiException('Missing request id.');
    }
    if (!in_array($decision, ['accepted', 'rejected'], true)) {
        throw new ApiException('Status must be accepted or rejected.');
    }

    with_transaction($pdo, function () use ($pdo, $myId, $id, $decision) {
        $stmt = $pdo->prepare("
            SELECT r.request_id, r.recipient_id, r.donation_id, r.status,
                   f.donor_id, f.title, f.status AS donation_status
            FROM Request r
            JOIN FoodDonation f ON f.donation_id = r.donation_id
            WHERE r.request_id = ?
            FOR UPDATE
        ");
        $stmt->execute([$id]);
        $req = $stmt->fetch();

        if (!$req || (int) $req['donor_id'] !== $myId) {
            throw new ApiException('Request not found.', 404);
        }
        if ($req['status'] !== 'pending') {
            throw new ApiException('This request has already been decided.', 409);
        }

        if ($decision === 'accepted') {
            if ($req['donation_status'] !== 'requested') {
                throw new ApiException('This donation is no longer available.', 409);
            }
            $pdo->prepare("UPDATE Request SET status = 'approved' WHERE request_id = ?")->execute([$id]);
            $pdo->prepare("UPDATE FoodDonation SET status = 'assigned' WHERE donation_id = ?")->execute([$req['donation_id']]);

            notify_user($pdo, $req['recipient_id'], $req['donation_id'],
                'Your request for "' . $req['title'] . '" was accepted. A volunteer will be assigned next.');

            // Tell every active volunteer that a pickup is open to claim.
            $vols = $pdo->query("SELECT v.volunteer_id FROM Volunteer v
                                 JOIN AppUser u ON u.user_id = v.volunteer_id
                                 WHERE u.status = 'active'")->fetchAll();
            foreach ($vols as $v) {
                notify_user($pdo, $v['volunteer_id'], $req['donation_id'],
                    'A new pickup is waiting for a volunteer: "' . $req['title'] . '".');
            }
            log_action($pdo, $myId, 'UPDATE', 'Request', $id, 'Accepted a request for "' . $req['title'] . '".');

        } else {
            $pdo->prepare("UPDATE Request SET status = 'rejected' WHERE request_id = ?")->execute([$id]);
            // Re-open the donation so somebody else can request it.
            $pdo->prepare("UPDATE FoodDonation SET status = 'available'
                           WHERE donation_id = ? AND status = 'requested'")->execute([$req['donation_id']]);

            notify_user($pdo, $req['recipient_id'], $req['donation_id'],
                'Your request for "' . $req['title'] . '" was declined by the donor.');
            log_action($pdo, $myId, 'UPDATE', 'Request', $id, 'Rejected a request for "' . $req['title'] . '".');
        }
    });

    json_out(map_request(fetch_request_row($pdo, $id)));
}

throw new ApiException('Method not allowed.', 405);
