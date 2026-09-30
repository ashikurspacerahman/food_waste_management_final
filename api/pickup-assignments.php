<?php
// Pickup assignments
//   GET   /api/pickup-assignments.php[?id=&volunteerId=&status=]
//   GET   /api/pickup-assignments.php?available=1   accepted requests with no volunteer yet
//   POST  /api/pickup-assignments.php   { requestId }   volunteer claims a pickup
//   PATCH /api/pickup-assignments.php?id=  { status: 'picked-up' | 'in-transit' | 'delivered' }
// Tables: PickupAssignment, Request, FoodDonation, Notification, AuditLog
//
// On delivery (ported from volunteer/my_tasks.php): the request becomes
// 'fulfilled', the delivered quantity is subtracted from the donation, and if
// food is left over the donation re-opens as 'available' for someone else.
require_once __DIR__ . '/db.php';

$me     = require_user($pdo);
$myId   = (int) $me['user_id'];
$method = request_method();

/* ===================== GET ===================== */
if ($method === 'GET') {

    // ---- open pickups a volunteer can claim ----
    if (query_str('available') === '1') {
        if (!in_array($me['role'], ['volunteer', 'admin'], true)) {
            throw new ApiException('You do not have permission to do that.', 403);
        }
        $ids = $pdo->query("
            SELECT r.request_id
            FROM Request r
            LEFT JOIN PickupAssignment pa ON pa.request_id = r.request_id AND pa.status <> 'cancelled'
            WHERE r.status = 'approved' AND pa.assignment_id IS NULL
            ORDER BY r.created_at ASC, r.request_id ASC
        ")->fetchAll();

        $out = [];
        foreach ($ids as $row) {
            $req = fetch_request_row($pdo, $row['request_id']);
            $don = $req ? fetch_donation_row($pdo, $req['donation_id']) : null;
            if ($req && $don) {
                $out[] = ['request' => map_request($req), 'donation' => map_donation($don)];
            }
        }
        json_out($out);
    }

    $where  = [];
    $params = [];
    if ($me['role'] === 'volunteer') {
        $where[]  = 'pa.volunteer_id = ?';
        $params[] = $myId;
    } elseif ($me['role'] === 'donor') {
        $where[]  = 'f.donor_id = ?';
        $params[] = $myId;
    } elseif ($me['role'] === 'recipient') {
        $where[]  = 'r.recipient_id = ?';
        $params[] = $myId;
    }   // admin: everything

    $id = (int) query_str('id', '0');
    if ($id > 0) {
        $where[]  = 'pa.assignment_id = ?';
        $params[] = $id;
    }
    if ((int) query_str('volunteerId', '0') > 0) {
        $where[]  = 'pa.volunteer_id = ?';
        $params[] = (int) query_str('volunteerId');
    }
    if (query_str('status') !== '') {
        $st = pickup_status_in(query_str('status'));
        if ($st === null) {
            json_out([]);
        }
        $where[]  = 'pa.status = ?';
        $params[] = $st;
    }

    $sql = pickup_select_sql();
    if ($where) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY pa.assignment_id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    if ($id > 0) {
        if (!$rows) {
            throw new ApiException('Assignment not found.', 404);
        }
        json_out(map_pickup($rows[0]));
    }
    json_out(array_map('map_pickup', $rows));
}

/* ===================== POST : volunteer claims a pickup ===================== */
if ($method === 'POST') {
    if ($me['role'] !== 'volunteer') {
        throw new ApiException('Only volunteers can accept pickups.', 403);
    }
    $requestId = (int) body_str('requestId', '0');
    if ($requestId <= 0) {
        throw new ApiException('Choose a pickup to accept.');
    }

    $assignmentId = with_transaction($pdo, function () use ($pdo, $me, $myId, $requestId) {
        $stmt = $pdo->prepare("
            SELECT r.request_id, r.recipient_id, r.donation_id, r.status, f.donor_id, f.title
            FROM Request r
            JOIN FoodDonation f ON f.donation_id = r.donation_id
            WHERE r.request_id = ?
            FOR UPDATE
        ");
        $stmt->execute([$requestId]);
        $req = $stmt->fetch();

        if (!$req) {
            throw new ApiException('Pickup not found.', 404);
        }
        if ($req['status'] !== 'approved') {
            throw new ApiException('This pickup is no longer available.', 409);
        }
        $taken = $pdo->prepare("SELECT assignment_id FROM PickupAssignment WHERE request_id = ? AND status <> 'cancelled'");
        $taken->execute([$requestId]);
        if ($taken->fetch()) {
            throw new ApiException('Another volunteer has already accepted this pickup.', 409);
        }

        $pdo->prepare("INSERT INTO PickupAssignment (volunteer_id, request_id, status) VALUES (?, ?, 'assigned')")
            ->execute([$myId, $requestId]);
        $assignmentId = (int) $pdo->lastInsertId();

        $vName = $me['name'];
        notify_user($pdo, $req['donor_id'], $req['donation_id'],
            $vName . ' will pick up "' . $req['title'] . '".');
        notify_user($pdo, $req['recipient_id'], $req['donation_id'],
            'A volunteer (' . $vName . ') has been assigned to deliver "' . $req['title'] . '".');
        log_action($pdo, $myId, 'INSERT', 'PickupAssignment', $assignmentId,
            'Claimed the pickup for "' . $req['title'] . '".');
        return $assignmentId;
    });

    json_out(map_pickup(fetch_pickup_row($pdo, $assignmentId)), 201);
}

/* ===================== PATCH : advance the pickup ===================== */
if ($method === 'PATCH') {
    if ($me['role'] !== 'volunteer') {
        throw new ApiException('Only the assigned volunteer can update a pickup.', 403);
    }
    $id   = (int) query_str('id', '0');
    $next = pickup_status_in(body_str('status'));
    if ($id <= 0) {
        throw new ApiException('Missing assignment id.');
    }
    if ($next === null) {
        throw new ApiException('Invalid pickup status.');
    }

    with_transaction($pdo, function () use ($pdo, $myId, $id, $next) {
        $stmt = $pdo->prepare("
            SELECT pa.assignment_id, pa.volunteer_id, pa.status,
                   r.request_id, r.donation_id, r.recipient_id, r.requested_qty,
                   f.donor_id, f.title, f.unit, f.quantity AS donation_quantity
            FROM PickupAssignment pa
            JOIN Request r      ON r.request_id = pa.request_id
            JOIN FoodDonation f ON f.donation_id = r.donation_id
            WHERE pa.assignment_id = ?
            FOR UPDATE
        ");
        $stmt->execute([$id]);
        $task = $stmt->fetch();

        if (!$task || (int) $task['volunteer_id'] !== $myId) {
            throw new ApiException('Assignment not found.', 404);
        }

        // Only the next step in order is allowed.
        $flow = ['assigned' => 'picked_up', 'picked_up' => 'in_transit', 'in_transit' => 'delivered'];
        if (!isset($flow[$task['status']]) || $flow[$task['status']] !== $next) {
            throw new ApiException('That step is not allowed from the current status.', 409);
        }

        $title = $task['title'];

        if ($next === 'picked_up') {
            $pdo->prepare("UPDATE PickupAssignment SET status = 'picked_up', pickup_time = NOW() WHERE assignment_id = ?")
                ->execute([$id]);
            notify_user($pdo, $task['donor_id'], $task['donation_id'], 'Your donation "' . $title . '" has been picked up.');
            notify_user($pdo, $task['recipient_id'], $task['donation_id'], '"' . $title . '" has been picked up and will be on its way soon.');
            log_action($pdo, $myId, 'UPDATE', 'PickupAssignment', $id, 'Picked up "' . $title . '".');

        } elseif ($next === 'in_transit') {
            $pdo->prepare("UPDATE PickupAssignment SET status = 'in_transit' WHERE assignment_id = ?")->execute([$id]);
            notify_user($pdo, $task['recipient_id'], $task['donation_id'], '"' . $title . '" is on its way to you.');
            log_action($pdo, $myId, 'UPDATE', 'PickupAssignment', $id, 'Started delivery of "' . $title . '".');

        } else {                                                  // delivered
            $pdo->prepare("UPDATE PickupAssignment SET status = 'delivered', delivery_time = NOW() WHERE assignment_id = ?")
                ->execute([$id]);
            $pdo->prepare("UPDATE Request SET status = 'fulfilled' WHERE request_id = ?")->execute([$task['request_id']]);

            // Subtract what was delivered from the donation's remaining stock.
            $remaining = round((float) $task['donation_quantity'] - (float) $task['requested_qty'], 2);
            if ($remaining < 0) {
                $remaining = 0;
            }
            if ($remaining > 0) {
                // Leftover food still exists - re-open the donation for other recipients.
                $pdo->prepare("UPDATE FoodDonation SET quantity = ?, status = 'available' WHERE donation_id = ?")
                    ->execute([$remaining, $task['donation_id']]);
            } else {
                $pdo->prepare("UPDATE FoodDonation SET quantity = 0, status = 'delivered' WHERE donation_id = ?")
                    ->execute([$task['donation_id']]);
            }

            notify_user($pdo, $task['recipient_id'], $task['donation_id'],
                'Your food "' . $title . '" has been delivered. You can now leave feedback.');
            notify_user($pdo, $task['donor_id'], $task['donation_id'],
                'Your donation "' . $title . '" has been delivered successfully.'
                . ($remaining > 0 ? ' ' . $remaining . ' ' . $task['unit'] . ' remains available for others.'
                                  : ' The full quantity has been given away.'));
            log_action($pdo, $myId, 'UPDATE', 'PickupAssignment', $id, 'Delivered "' . $title . '".');
        }
    });

    json_out(map_pickup(fetch_pickup_row($pdo, $id)));
}

throw new ApiException('Method not allowed.', 405);
