<?php
// =====================================================================
// API/DB.PHP  -  database connection (PDO) for every endpoint.
// Uses the XAMPP defaults. Change the four values below if your MySQL
// root user has a password or the database has another name.
// =====================================================================
require_once __DIR__ . '/helpers.php';

$host     = 'localhost';
$dbname   = 'food_waste_management';
$username = 'root';
$password = '';            // XAMPP default MySQL root password is empty
$charset  = 'utf8mb4';

try {
    $pdo = new PDO(
        "mysql:host=$host;dbname=$dbname;charset=$charset",
        $username,
        $password,
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,  // throw exceptions on error
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,        // rows as associative arrays
            PDO::ATTR_EMULATE_PREPARES   => false,                   // real prepared statements
        ]
    );
} catch (PDOException $e) {
    json_error(
        'Cannot connect to the database. Make sure MySQL is running in XAMPP and that '
        . 'database/food_waste_management.sql has been imported.'
        . (APP_DEBUG ? ' (' . $e->getMessage() . ')' : ''),
        500
    );
}

// Auto-waste expired donations on every request (see helpers.php).
sweep_expired_donations($pdo);
