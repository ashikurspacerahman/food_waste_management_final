<?php
// GET /api/session.php  ->  { user: {...} }  or  { user: null } when logged out.
// Always reads the user fresh from the database, so profile edits and
// admin de-activation take effect immediately.
require_once __DIR__ . '/db.php';

if (empty($_SESSION['user_id'])) {
    json_out(['user' => null]);
}
try {
    $row = require_user($pdo);
} catch (ApiException $e) {
    json_out(['user' => null]);
}
json_out(['user' => map_user($row)]);
