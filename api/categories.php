<?php
// Food categories
//   GET    /api/categories.php               any logged-in user
//   POST   /api/categories.php   { name }    admin: add
//   PATCH  /api/categories.php?id=  { name } admin: rename
//   DELETE /api/categories.php?id=           admin: delete
// Table: FoodCategory (full CRUD, ported from admin/manage_categories.php)
require_once __DIR__ . '/db.php';

$method = request_method();

function map_category(array $r) {
    return ['categoryId' => sid($r['category_id']), 'name' => $r['category_name']];
}

if ($method === 'GET') {
    // Reference data only - safe to read without a role check.
    $rows = $pdo->query('SELECT category_id, category_name FROM FoodCategory ORDER BY category_id')->fetchAll();
    json_out(array_map('map_category', $rows));
}

$me = require_user($pdo, ['admin']);
$myId = (int) $me['user_id'];

if ($method === 'POST') {
    $name = short_text(body_str('name'), 80);
    if ($name === '') {
        throw new ApiException('Enter a category name.');
    }
    $dup = $pdo->prepare('SELECT category_id FROM FoodCategory WHERE category_name = ?');
    $dup->execute([$name]);
    if ($dup->fetch()) {
        throw new ApiException('That category already exists.', 409);
    }
    $pdo->prepare('INSERT INTO FoodCategory (category_name) VALUES (?)')->execute([$name]);
    $id = (int) $pdo->lastInsertId();
    log_action($pdo, $myId, 'INSERT', 'FoodCategory', $id, 'Added food category "' . $name . '".');
    json_out(['categoryId' => sid($id), 'name' => $name], 201);
}

$id = (int) query_str('id', '0');
if ($id <= 0) {
    throw new ApiException('Missing category id.');
}
$stmt = $pdo->prepare('SELECT category_id, category_name FROM FoodCategory WHERE category_id = ?');
$stmt->execute([$id]);
$cat = $stmt->fetch();
if (!$cat) {
    throw new ApiException('Category not found.', 404);
}

if ($method === 'PATCH') {
    $name = short_text(body_str('name'), 80);
    if ($name === '') {
        throw new ApiException('Enter a category name.');
    }
    $dup = $pdo->prepare('SELECT category_id FROM FoodCategory WHERE category_name = ? AND category_id <> ?');
    $dup->execute([$name, $id]);
    if ($dup->fetch()) {
        throw new ApiException('That category already exists.', 409);
    }
    $pdo->prepare('UPDATE FoodCategory SET category_name = ? WHERE category_id = ?')->execute([$name, $id]);
    log_action($pdo, $myId, 'UPDATE', 'FoodCategory', $id, 'Renamed food category "' . $cat['category_name'] . '" to "' . $name . '".');
    json_out(['categoryId' => sid($id), 'name' => $name]);
}

if ($method === 'DELETE') {
    // FoodDonation.category_id is ON DELETE SET NULL, so existing donations
    // simply become "Uncategorized".
    $pdo->prepare('DELETE FROM FoodCategory WHERE category_id = ?')->execute([$id]);
    log_action($pdo, $myId, 'DELETE', 'FoodCategory', $id, 'Deleted food category "' . $cat['category_name'] . '".');
    json_out(['ok' => true]);
}

throw new ApiException('Method not allowed.', 405);
