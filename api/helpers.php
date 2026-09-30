<?php
// =====================================================================
// API/HELPERS.PHP
// Shared plumbing for every JSON endpoint in /api:
//   - session start + JSON headers + error handling
//   - request helpers (method override, JSON body, CSRF header check)
//   - auth helpers (require_user)
//   - audit log + notification helpers (from the backend's functions.php)
//   - row -> JSON mappers that translate DB values into the exact shapes
//     the Sufra frontend already expects (donationId, expiresAt, ...).
// Included automatically by db.php - endpoints only need db.php.
// =====================================================================

// Set to false before a real deployment to hide internal error text.
const APP_DEBUG = true;

error_reporting(E_ALL);
ini_set('display_errors', '0');   // never print PHP warnings into the JSON

if (session_status() === PHP_SESSION_NONE) {
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('X-Content-Type-Options: nosniff');

/* ---------------------------------------------------------------------
   Errors
   --------------------------------------------------------------------- */
class ApiException extends Exception {
    public $status;
    public function __construct($message, $status = 400) {
        parent::__construct($message);
        $this->status = $status;
    }
}

function json_out($data, $status = 200) {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

function json_error($message, $status = 400) {
    json_out(['message' => $message], $status);
}

set_exception_handler(function ($e) {
    if ($e instanceof ApiException) {
        json_error($e->getMessage(), $e->status);
    }
    error_log('[food_waste_management] ' . $e->getMessage());
    json_error(APP_DEBUG ? ('Server error: ' . $e->getMessage()) : 'Something went wrong on the server.', 500);
});

/* ---------------------------------------------------------------------
   Request helpers
   --------------------------------------------------------------------- */
// The frontend sends PATCH/DELETE as POST + X-HTTP-Method-Override so it
// works on every Apache setup.
function request_method() {
    $m = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    if ($m === 'POST' && !empty($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'])) {
        $o = strtoupper($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE']);
        if (in_array($o, ['PATCH', 'PUT', 'DELETE'], true)) {
            return $o;
        }
    }
    return $m;
}

// Basic CSRF protection: every state-changing call must carry this header,
// which a cross-site HTML form cannot add.
function require_xhr() {
    $real = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    if ($real !== 'GET' && $real !== 'HEAD' && $real !== 'OPTIONS') {
        if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'XMLHttpRequest') {
            throw new ApiException('Invalid request.', 400);
        }
    }
}
require_xhr();

function read_body() {
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    // FormData submissions (e.g. a donation with a photo) arrive in $_POST;
    // everything else is JSON.
    $type = strtolower($_SERVER['CONTENT_TYPE'] ?? '');
    if (strpos($type, 'multipart/form-data') === 0 || strpos($type, 'application/x-www-form-urlencoded') === 0) {
        $cache = $_POST;
        return $cache;
    }
    $raw  = file_get_contents('php://input');
    $data = json_decode($raw === false ? '' : $raw, true);
    $cache = is_array($data) ? $data : [];
    return $cache;
}

function body_str($key, $default = '') {
    $b = read_body();
    if (!isset($b[$key]) || !is_scalar($b[$key])) {
        return $default;
    }
    return trim((string) $b[$key]);
}

function body_has($key) {
    $b = read_body();
    return array_key_exists($key, $b);
}

function query_str($key, $default = '') {
    if (!isset($_GET[$key]) || !is_scalar($_GET[$key])) {
        return $default;
    }
    return trim((string) $_GET[$key]);
}

function short_text($s, $max) {
    $s = (string) $s;
    return function_exists('mb_substr') ? mb_substr($s, 0, $max) : substr($s, 0, $max);
}

function text_length($s) {
    return function_exists('mb_strlen') ? mb_strlen((string) $s) : strlen((string) $s);
}

/* ---------------------------------------------------------------------
   Transactions
   --------------------------------------------------------------------- */
function with_transaction(PDO $pdo, callable $fn) {
    $pdo->beginTransaction();
    try {
        $result = $fn();
        $pdo->commit();
        return $result;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}

/* ---------------------------------------------------------------------
   Auth
   --------------------------------------------------------------------- */
function user_select_sql() {
    return "
        SELECT u.user_id, u.name, u.email, u.role, u.phone, u.address, u.status, u.created_at,
               d.donor_type, d.org_name AS donor_org,
               rc.recipient_type, rc.org_name AS recipient_org,
               v.vehicle_type, v.availability AS availability_enum, v.availability_note
        FROM AppUser u
        LEFT JOIN Donor d      ON d.donor_id = u.user_id
        LEFT JOIN Recipient rc ON rc.recipient_id = u.user_id
        LEFT JOIN Volunteer v  ON v.volunteer_id = u.user_id
    ";
}

function fetch_user_row(PDO $pdo, $userId) {
    $stmt = $pdo->prepare(user_select_sql() . ' WHERE u.user_id = ?');
    $stmt->execute([(int) $userId]);
    return $stmt->fetch();
}

// Returns the logged-in user's raw DB row. Stops with 401/403 otherwise.
// $roles = [] means any role.
function require_user(PDO $pdo, array $roles = []) {
    if (empty($_SESSION['user_id'])) {
        throw new ApiException('Please log in to continue.', 401);
    }
    $row = fetch_user_row($pdo, $_SESSION['user_id']);
    if (!$row) {
        $_SESSION = [];
        throw new ApiException('Please log in to continue.', 401);
    }
    if ($row['status'] !== 'active') {
        $_SESSION = [];
        throw new ApiException('This account has been deactivated. Please contact an administrator.', 403);
    }
    if ($roles && !in_array($row['role'], $roles, true)) {
        throw new ApiException('You do not have permission to do that.', 403);
    }
    return $row;
}

/* ---------------------------------------------------------------------
   Audit log + notifications (ported from includes/functions.php)
   --------------------------------------------------------------------- */
function log_action(PDO $pdo, $userId, $actionType, $targetTable, $targetId, $description = null) {
    $stmt = $pdo->prepare(
        "INSERT INTO AuditLog (user_id, action_type, target_table, target_id, description) VALUES (?, ?, ?, ?, ?)"
    );
    $stmt->execute([(int) $userId, $actionType, $targetTable, $targetId === null ? null : (int) $targetId,
                    $description === null ? null : short_text($description, 255)]);
}

function notify_user(PDO $pdo, $userId, $donationId, $message) {
    $stmt = $pdo->prepare(
        "INSERT INTO Notification (user_id, donation_id, message, is_read) VALUES (?, ?, ?, 0)"
    );
    $stmt->execute([(int) $userId, $donationId === null ? null : (int) $donationId, short_text($message, 255)]);
}

/* ---------------------------------------------------------------------
   Small value helpers
   --------------------------------------------------------------------- */
function iso($v) {
    return $v ? str_replace(' ', 'T', (string) $v) : null;
}

function num($v) {
    return $v === null ? null : round((float) $v, 2);
}

function sid($v) {               // ids go to the frontend as strings
    return $v === null ? null : (string) $v;
}

// "2026-09-29T14:30" or "2026-09-29 14:30:00" -> "2026-09-29 14:30:00", or null if invalid.
function normalize_datetime($s) {
    $s = trim((string) $s);
    if (!preg_match('/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/', $s, $m)) {
        return null;
    }
    $sec = isset($m[3]) && $m[3] !== '' ? $m[3] : ':00';
    return $m[1] . ' ' . $m[2] . $sec;
}

function is_future_datetime(PDO $pdo, $mysqlDateTime) {
    $stmt = $pdo->prepare('SELECT (CAST(? AS DATETIME) > NOW()) AS ok');
    $stmt->execute([$mysqlDateTime]);
    return (int) $stmt->fetch()['ok'] === 1;
}

/* ---------------------------------------------------------------------
   Address helpers - the frontend uses one free-text address; the schema
   splits it into street + city. "House 12, Road 5, Dhanmondi, Dhaka"
   -> street "House 12, Road 5, Dhanmondi", city "Dhaka" (and back).
   --------------------------------------------------------------------- */
function split_address($text) {
    $text = trim((string) $text);
    $pos  = strrpos($text, ',');
    if ($pos === false) {
        return [short_text($text, 150), short_text($text, 80)];
    }
    $street = trim(substr($text, 0, $pos));
    $city   = trim(substr($text, $pos + 1));
    if ($street === '') { $street = $text; }
    if ($city === '')   { $city = $street; }
    return [short_text($street, 150), short_text($city, 80)];
}

function join_address($street, $city) {
    $street = (string) $street;
    $city   = (string) $city;
    if ($street === '') { return $city; }
    if ($city === '' || $city === $street) { return $street; }
    return $street . ', ' . $city;
}

function save_address(PDO $pdo, $text, $existingId = null) {
    list($street, $city) = split_address($text);
    if ($existingId) {
        $stmt = $pdo->prepare('UPDATE Address SET street = ?, city = ? WHERE address_id = ?');
        $stmt->execute([$street, $city, (int) $existingId]);
        return (int) $existingId;
    }
    $stmt = $pdo->prepare('INSERT INTO Address (street, city) VALUES (?, ?)');
    $stmt->execute([$street, $city]);
    return (int) $pdo->lastInsertId();
}

/* ---------------------------------------------------------------------
   Vocabulary translation: database ENUMs  <->  frontend labels
   --------------------------------------------------------------------- */
function donor_type_label($enum) {
    $map = ['individual' => 'Individual', 'restaurant' => 'Restaurant', 'grocery' => 'Grocery Store',
            'event' => 'Event Organizer', 'other' => 'Other'];
    return $map[$enum] ?? 'Individual';
}
function donor_type_enum($label) {
    $l = strtolower(trim((string) $label));
    $map = ['individual' => 'individual', 'restaurant' => 'restaurant', 'grocery store' => 'grocery',
            'grocery' => 'grocery', 'event organizer' => 'event', 'event' => 'event', 'other' => 'other'];
    return $map[$l] ?? 'individual';
}
function recipient_type_label($enum) {
    $map = ['individual' => 'Individual', 'ngo' => 'NGO', 'shelter' => 'Shelter',
            'orphanage' => 'Orphanage', 'other' => 'Other'];
    return $map[$enum] ?? 'Individual';
}
function recipient_type_enum($label) {
    $l = strtolower(trim((string) $label));
    $map = ['individual' => 'individual', 'ngo' => 'ngo', 'shelter' => 'shelter',
            'orphanage' => 'orphanage', 'other' => 'other'];
    return $map[$l] ?? 'individual';
}

// Donation: DB status -> frontend status
function donation_status_out($dbStatus) {
    $map = ['available' => 'available', 'requested' => 'pending', 'assigned' => 'claimed',
            'delivered' => 'delivered', 'wasted' => 'wasted', 'expired' => 'expired',
            'draft' => 'draft', 'cancelled' => 'cancelled'];
    return $map[$dbStatus] ?? $dbStatus;
}
// Donation: frontend status -> DB status (for filters)
function donation_status_in($status) {
    $map = ['available' => 'available', 'pending' => 'requested', 'claimed' => 'assigned',
            'delivered' => 'delivered', 'wasted' => 'wasted', 'expired' => 'expired',
            'draft' => 'draft', 'cancelled' => 'cancelled'];
    return $map[$status] ?? null;
}

function request_status_out($dbStatus) {
    $map = ['pending' => 'pending', 'approved' => 'accepted', 'fulfilled' => 'accepted', 'rejected' => 'rejected'];
    return $map[$dbStatus] ?? $dbStatus;
}

function pickup_status_out($dbStatus) {
    return str_replace('_', '-', (string) $dbStatus);      // picked_up -> picked-up
}
function pickup_status_in($status) {
    $s = str_replace('-', '_', (string) $status);
    return in_array($s, ['assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled'], true) ? $s : null;
}

/* ---------------------------------------------------------------------
   Row mappers (DB row -> frontend JSON)
   --------------------------------------------------------------------- */
function map_user(array $r) {
    $u = [
        'userId'       => sid($r['user_id']),
        'role'         => $r['role'],
        'name'         => $r['name'],
        'email'        => $r['email'],
        'phone'        => $r['phone'] ?? '',
        'address'      => $r['address'] ?? '',
        'status'       => $r['status'],
        'registeredAt' => iso($r['created_at']),
    ];
    if ($r['role'] === 'donor') {
        $u['donorType']        = donor_type_label($r['donor_type']);
        $u['organizationName'] = $r['donor_org'] ?? '';
    } elseif ($r['role'] === 'recipient') {
        $u['recipientType']    = recipient_type_label($r['recipient_type']);
        $u['organizationName'] = $r['recipient_org'] ?? '';
    } elseif ($r['role'] === 'volunteer') {
        $u['vehicleType']  = $r['vehicle_type'] ?? '';
        $note = $r['availability_note'] ?? '';
        $u['availability'] = $note !== '' ? $note : ucfirst((string) $r['availability_enum']);
    }
    return $u;
}

function donation_select_sql() {
    return "
        SELECT f.donation_id, f.donor_id, f.category_id, f.title, f.description, f.quantity, f.unit,
               f.prepared_at, f.expiry_time, f.contact, f.notes, f.status, f.created_at,
               COALESCE(NULLIF(d.org_name, ''), du.name) AS donor_name,
               a.street, a.city,
               (SELECT COUNT(*) FROM Request rq WHERE rq.donation_id = f.donation_id) AS request_count,
               (SELECT di.image_url FROM DonationImage di WHERE di.donation_id = f.donation_id
                 ORDER BY di.image_id LIMIT 1) AS image_url
        FROM FoodDonation f
        JOIN Donor d     ON d.donor_id = f.donor_id
        JOIN AppUser du  ON du.user_id = f.donor_id
        LEFT JOIN Address a ON a.address_id = f.address_id
    ";
}

function map_donation(array $r) {
    return [
        'donationId'    => sid($r['donation_id']),
        'donorId'       => sid($r['donor_id']),
        'donorName'     => $r['donor_name'],
        'title'         => $r['title'],
        'categoryId'    => sid($r['category_id']),
        'description'   => $r['description'] ?? '',
        'quantity'      => num($r['quantity']),
        'unit'          => $r['unit'],
        'preparedAt'    => iso($r['prepared_at']),
        'expiresAt'     => iso($r['expiry_time']),
        'pickupAddress' => join_address($r['street'] ?? '', $r['city'] ?? ''),
        'contact'       => $r['contact'] ?? '',
        'notes'         => $r['notes'] ?? '',
        'status'        => donation_status_out($r['status']),
        'createdAt'     => iso($r['created_at']),
        'requestCount'  => (int) $r['request_count'],
        'imageUrl'      => $r['image_url'] ?? null,
    ];
}

function fetch_donation_row(PDO $pdo, $donationId) {
    $stmt = $pdo->prepare(donation_select_sql() . ' WHERE f.donation_id = ?');
    $stmt->execute([(int) $donationId]);
    return $stmt->fetch();
}

function request_select_sql() {
    return "
        SELECT r.request_id, r.donation_id, r.recipient_id, r.requested_qty, r.people_to_serve,
               r.notes, r.preferred_pickup, r.status, r.created_at,
               COALESCE(NULLIF(rc.org_name, ''), ru.name) AS recipient_name,
               f.donor_id,
               pa.assignment_id, pa.volunteer_id, pa.status AS assignment_status,
               vu.name AS volunteer_name
        FROM Request r
        JOIN Recipient rc   ON rc.recipient_id = r.recipient_id
        JOIN AppUser ru     ON ru.user_id = r.recipient_id
        JOIN FoodDonation f ON f.donation_id = r.donation_id
        LEFT JOIN PickupAssignment pa ON pa.request_id = r.request_id AND pa.status <> 'cancelled'
        LEFT JOIN AppUser vu ON vu.user_id = pa.volunteer_id
    ";
}

function map_request(array $r) {
    return [
        'requestId'         => sid($r['request_id']),
        'donationId'        => sid($r['donation_id']),
        'recipientId'       => sid($r['recipient_id']),
        'recipientName'     => $r['recipient_name'],
        'requestedQuantity' => num($r['requested_qty']),
        'peopleToServe'     => $r['people_to_serve'] === null ? null : (int) $r['people_to_serve'],
        'notes'             => $r['notes'] ?? '',
        'preferredPickup'   => $r['preferred_pickup'] ?? '',
        'status'            => request_status_out($r['status']),
        'fulfilled'         => $r['status'] === 'fulfilled',
        'createdAt'         => iso($r['created_at']),
        'assignmentId'      => sid($r['assignment_id']),
        'volunteerId'       => sid($r['volunteer_id']),
        'volunteerName'     => $r['volunteer_name'],
    ];
}

function fetch_request_row(PDO $pdo, $requestId) {
    $stmt = $pdo->prepare(request_select_sql() . ' WHERE r.request_id = ?');
    $stmt->execute([(int) $requestId]);
    return $stmt->fetch();
}

function pickup_select_sql() {
    return "
        SELECT pa.assignment_id, pa.request_id, pa.volunteer_id, pa.pickup_time, pa.delivery_time, pa.status,
               r.donation_id, r.recipient_id, r.requested_qty,
               vu.name AS volunteer_name,
               COALESCE(NULLIF(rc.org_name, ''), ru.name) AS recipient_name,
               ru.address AS recipient_address,
               f.donor_id, f.title,
               COALESCE(NULLIF(d.org_name, ''), du.name) AS donor_name,
               a.street, a.city
        FROM PickupAssignment pa
        JOIN Request r      ON r.request_id = pa.request_id
        JOIN FoodDonation f ON f.donation_id = r.donation_id
        JOIN Donor d        ON d.donor_id = f.donor_id
        JOIN AppUser du     ON du.user_id = f.donor_id
        JOIN Recipient rc   ON rc.recipient_id = r.recipient_id
        JOIN AppUser ru     ON ru.user_id = r.recipient_id
        JOIN AppUser vu     ON vu.user_id = pa.volunteer_id
        LEFT JOIN Address a ON a.address_id = f.address_id
    ";
}

function map_pickup(array $r) {
    $deliveryAddress = trim((string) ($r['recipient_address'] ?? ''));
    return [
        'assignmentId'    => sid($r['assignment_id']),
        'requestId'       => sid($r['request_id']),
        'donationId'      => sid($r['donation_id']),
        'volunteerId'     => sid($r['volunteer_id']),
        'volunteerName'   => $r['volunteer_name'],
        'donorName'       => $r['donor_name'],
        'recipientName'   => $r['recipient_name'],
        'pickupAddress'   => join_address($r['street'] ?? '', $r['city'] ?? ''),
        'deliveryAddress' => $deliveryAddress !== '' ? $deliveryAddress : 'Recipient address on file',
        'pickupTime'      => iso($r['pickup_time']),
        'deliveryTime'    => iso($r['delivery_time']),
        'status'          => pickup_status_out($r['status']),
    ];
}

function fetch_pickup_row(PDO $pdo, $assignmentId) {
    $stmt = $pdo->prepare(pickup_select_sql() . ' WHERE pa.assignment_id = ?');
    $stmt->execute([(int) $assignmentId]);
    return $stmt->fetch();
}

/* ---------------------------------------------------------------------
   Auto-waste for expired donations (moved here from the backend's db.php)
   XAMPP has no cron, so every API call sweeps: any donation still
   'available' or 'requested' whose expiry_time has passed becomes
   'expired', is written to WasteLog, and the donor is notified.
   --------------------------------------------------------------------- */
function sweep_expired_donations(PDO $pdo) {
    try {
        $rows = $pdo->query("
            SELECT donation_id, donor_id, title, quantity
            FROM FoodDonation
            WHERE status IN ('available', 'requested') AND expiry_time < NOW()
        ")->fetchAll();

        foreach ($rows as $d) {
            try {
                $pdo->beginTransaction();

                $upd = $pdo->prepare("UPDATE FoodDonation SET status = 'expired'
                                      WHERE donation_id = ? AND status IN ('available', 'requested')");
                $upd->execute([$d['donation_id']]);
                if ($upd->rowCount() === 0) {          // another request got there first
                    $pdo->rollBack();
                    continue;
                }

                // A request still waiting for approval can no longer be honoured.
                $pen = $pdo->prepare("SELECT request_id, recipient_id FROM Request
                                      WHERE donation_id = ? AND status = 'pending'");
                $pen->execute([$d['donation_id']]);
                foreach ($pen->fetchAll() as $rq) {
                    $pdo->prepare("UPDATE Request SET status = 'rejected' WHERE request_id = ?")
                        ->execute([$rq['request_id']]);
                    notify_user($pdo, $rq['recipient_id'], $d['donation_id'],
                        'Your request for "' . $d['title'] . '" was closed because the food expired.');
                }

                $pdo->prepare("INSERT INTO WasteLog (donation_id, quantity_wasted, reason) VALUES (?, ?, ?)")
                    ->execute([$d['donation_id'], $d['quantity'], 'Expired before pickup/request']);
                $wasteId = (int) $pdo->lastInsertId();

                notify_user($pdo, $d['donor_id'], $d['donation_id'],
                    '"' . $d['title'] . '" expired without being claimed.');
                log_action($pdo, $d['donor_id'], 'INSERT', 'WasteLog', $wasteId,
                    'System: "' . $d['title'] . '" expired unclaimed and was logged as waste.');

                $pdo->commit();
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
            }
        }
    } catch (Throwable $e) {
        // Background convenience check - it must never break the actual request.
    }
}
