<?php
// Feedback
//   GET  /api/feedback.php[?toUserId=&fromUserId=&volunteerId=]
//   POST /api/feedback.php  { requestId, rating, review, volunteerRating?, volunteerReview? }
// Table: Feedback (two ratings in one submission: the food AND the delivery)
require_once __DIR__ . '/db.php';

$me     = require_user($pdo);
$myId   = (int) $me['user_id'];
$method = request_method();

function feedback_select_sql() {
    return "
        SELECT fb.feedback_id, fb.user_id, fb.donation_id, fb.request_id, fb.rating, fb.comments,
               fb.volunteer_id, fb.volunteer_rating, fb.volunteer_comments, fb.created_at,
               f.donor_id, f.title,
               COALESCE(NULLIF(rc.org_name, ''), fu.name) AS from_name
        FROM Feedback fb
        JOIN FoodDonation f ON f.donation_id = fb.donation_id
        JOIN AppUser fu     ON fu.user_id = fb.user_id
        LEFT JOIN Recipient rc ON rc.recipient_id = fb.user_id
    ";
}

function map_feedback(array $r) {
    return [
        'feedbackId'      => sid($r['feedback_id']),
        'donationId'      => sid($r['donation_id']),
        'donationTitle'   => $r['title'],
        'requestId'       => sid($r['request_id']),
        'fromUserId'      => sid($r['user_id']),
        'fromName'        => $r['from_name'],
        'toUserId'        => sid($r['donor_id']),
        'rating'          => $r['rating'] === null ? null : (int) $r['rating'],
        'review'          => $r['comments'] ?? '',
        'volunteerId'     => sid($r['volunteer_id']),
        'volunteerRating' => $r['volunteer_rating'] === null ? null : (int) $r['volunteer_rating'],
        'volunteerReview' => $r['volunteer_comments'] ?? '',
        'createdAt'       => iso($r['created_at']),
    ];
}

/* ===================== GET ===================== */
if ($method === 'GET') {
    $where  = [];
    $params = [];

    if ($me['role'] === 'recipient') {
        $where[]  = 'fb.user_id = ?';
        $params[] = $myId;
    } elseif ($me['role'] === 'donor') {
        $where[]  = 'f.donor_id = ?';
        $params[] = $myId;
    } elseif ($me['role'] === 'volunteer') {
        $where[]  = 'fb.volunteer_id = ?';
        $params[] = $myId;
    }   // admin: everything

    if ((int) query_str('toUserId', '0') > 0) {
        $where[]  = 'f.donor_id = ?';
        $params[] = (int) query_str('toUserId');
    }
    if ((int) query_str('fromUserId', '0') > 0) {
        $where[]  = 'fb.user_id = ?';
        $params[] = (int) query_str('fromUserId');
    }
    if ((int) query_str('volunteerId', '0') > 0) {
        $where[]  = 'fb.volunteer_id = ?';
        $params[] = (int) query_str('volunteerId');
    }

    $sql = feedback_select_sql();
    if ($where) {
        $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY fb.created_at DESC, fb.feedback_id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    json_out(array_map('map_feedback', $stmt->fetchAll()));
}

/* ===================== POST : recipient leaves feedback ===================== */
if ($method === 'POST') {
    if ($me['role'] !== 'recipient') {
        throw new ApiException('Only recipients can leave feedback.', 403);
    }
    $requestId = (int) body_str('requestId', '0');
    $rating    = body_str('rating');
    $review    = short_text(body_str('review'), 500);
    $vRating   = body_str('volunteerRating');
    $vReview   = short_text(body_str('volunteerReview'), 500);

    if ($requestId <= 0) {
        throw new ApiException('Choose a delivered request to review.');
    }
    if (!ctype_digit($rating) || (int) $rating < 1 || (int) $rating > 5) {
        throw new ApiException('Please select a star rating from 1 to 5.');
    }
    if ($vRating !== '' && (!ctype_digit($vRating) || (int) $vRating < 1 || (int) $vRating > 5)) {
        throw new ApiException('The volunteer rating must be from 1 to 5.');
    }

    $feedbackId = with_transaction($pdo, function () use ($pdo, $myId, $requestId, $rating, $review, $vRating, $vReview) {
        $stmt = $pdo->prepare("
            SELECT r.request_id, r.donation_id, r.recipient_id, r.status,
                   f.donor_id, f.title, pa.volunteer_id
            FROM Request r
            JOIN FoodDonation f ON f.donation_id = r.donation_id
            LEFT JOIN PickupAssignment pa ON pa.request_id = r.request_id AND pa.status = 'delivered'
            WHERE r.request_id = ?
            FOR UPDATE
        ");
        $stmt->execute([$requestId]);
        $req = $stmt->fetch();

        if (!$req || (int) $req['recipient_id'] !== $myId) {
            throw new ApiException('Request not found.', 404);
        }
        if ($req['status'] !== 'fulfilled') {
            throw new ApiException('You can leave feedback once the food has been delivered.', 409);
        }
        $dup = $pdo->prepare('SELECT feedback_id FROM Feedback WHERE request_id = ?');
        $dup->execute([$requestId]);
        if ($dup->fetch()) {
            throw new ApiException('You already left feedback for this delivery.', 409);
        }

        $volunteerId = $req['volunteer_id'];
        $ratesVolunteer = $vRating !== '' && $volunteerId !== null;

        $pdo->prepare("
            INSERT INTO Feedback (user_id, donation_id, request_id, rating, comments,
                                  volunteer_id, volunteer_rating, volunteer_comments)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ")->execute([
            $myId, $req['donation_id'], $requestId, (int) $rating, $review === '' ? null : $review,
            $volunteerId,
            $ratesVolunteer ? (int) $vRating : null,
            ($ratesVolunteer && $vReview !== '') ? $vReview : null,
        ]);
        $feedbackId = (int) $pdo->lastInsertId();

        notify_user($pdo, $req['donor_id'], $req['donation_id'],
            'You received a ' . (int) $rating . '-star review for "' . $req['title'] . '".');
        if ($ratesVolunteer) {
            notify_user($pdo, $volunteerId, $req['donation_id'],
                'You received a ' . (int) $vRating . '-star delivery rating for "' . $req['title'] . '".');
        }
        log_action($pdo, $myId, 'INSERT', 'Feedback', $feedbackId, 'Left feedback for "' . $req['title'] . '".');
        return $feedbackId;
    });

    $stmt = $pdo->prepare(feedback_select_sql() . ' WHERE fb.feedback_id = ?');
    $stmt->execute([$feedbackId]);
    json_out(map_feedback($stmt->fetch()), 201);
}

throw new ApiException('Method not allowed.', 405);
