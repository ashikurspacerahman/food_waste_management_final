<?php
// GET /api/audit-logs.php   admin only - the most recent 300 audit entries.
// Table: AuditLog (joined with AppUser). Rows are written by log_action()
// whenever something significant happens.
require_once __DIR__ . '/db.php';

require_user($pdo, ['admin']);
if (request_method() !== 'GET') {
    throw new ApiException('Method not allowed.', 405);
}

$verbs = ['INSERT' => 'Created', 'UPDATE' => 'Updated', 'DELETE' => 'Deleted', 'LOGIN' => 'Signed in'];

$rows = $pdo->query("
    SELECT a.log_id, a.user_id, a.action_type, a.target_table, a.target_id, a.description, a.action_time,
           u.name AS user_name
    FROM AuditLog a
    JOIN AppUser u ON u.user_id = a.user_id
    ORDER BY a.action_time DESC, a.log_id DESC
    LIMIT 300
")->fetchAll();

$out = [];
foreach ($rows as $r) {
    $verb   = $verbs[$r['action_type']] ?? $r['action_type'];
    $entity = $r['target_table'] . ($r['target_id'] !== null ? ' #' . $r['target_id'] : '');
    $out[] = [
        'logId'       => sid($r['log_id']),
        'timestamp'   => iso($r['action_time']),
        'userName'    => $r['user_name'],
        'action'      => $verb,
        'entity'      => $entity,
        'description' => $r['description'] !== null && $r['description'] !== '' ? $r['description'] : ($verb . ' ' . $entity),
    ];
}
json_out($out);
