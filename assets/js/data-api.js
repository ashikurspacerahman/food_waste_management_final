/* =========================================================
   Sufra — data-api.js   (REAL BACKEND VERSION)

   This file replaces the old mock-data.js. Every function keeps
   the SAME NAME the pages already call (getDonations(),
   createRequest(), ...) but now talks to the PHP + MySQL API in
   /api instead of localStorage.

   The one difference: these functions are ASYNC, so call sites
   use `await`. Field names in the JSON (donationId, expiresAt,
   requestedQuantity ...) are unchanged from the mock version.

   The API folder is found automatically relative to this
   script, so the project works in any XAMPP folder name.
   ========================================================= */

/* ---------- Where is /api? ---------- */
const API_BASE = (() => {
  const script = document.currentScript || document.querySelector('script[src*="data-api.js"]');
  if (script && script.src) {
    // .../assets/js/data-api.js  ->  .../api
    return script.src.replace(/\/assets\/js\/[^/?#]*(\?.*)?$/, "/api");
  }
  return "/food_waste_management/api";
})();

/* ---------- Fetch wrapper ----------
   - sends the PHP session cookie
   - sends X-Requested-With (the API uses it as CSRF protection)
   - PATCH/DELETE go out as POST + X-HTTP-Method-Override, which works
     on every Apache/XAMPP setup
   - throws Error(message) with the server's message on any failure  */
async function apiFetch(path, { method = "GET", body } = {}) {
  const headers = { "X-Requested-With": "XMLHttpRequest" };
  const init = { credentials: "same-origin", headers };

  if (method === "PATCH" || method === "DELETE" || method === "PUT") {
    init.method = "POST";
    headers["X-HTTP-Method-Override"] = method;
  } else {
    init.method = method;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (err) {
    throw new Error("Can't reach the server. Is Apache running in XAMPP?");
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error("The server sent an unexpected response. Check that PHP and MySQL are running in XAMPP.");
    }
  }

  if (!response.ok) {
    const error = new Error((data && data.message) || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function qs(params = {}) {
  const clean = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  });
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : "";
}

/* ---------- Categories (cached: they are reference data) ---------- */
let _categories = [];

async function loadFoodCategories() {
  _categories = await apiFetch("/categories.php");
  return _categories;
}

// Synchronous: valid once the page has booted (requireRole loads them).
function getFoodCategoriesSync() {
  return _categories;
}

async function getFoodCategories() {
  if (_categories.length === 0) await loadFoodCategories();
  return _categories;
}

function getCategoryName(categoryId) {
  const c = _categories.find((x) => String(x.categoryId) === String(categoryId));
  return c ? c.name : "Uncategorized";
}

async function createCategory(name) {
  const c = await apiFetch("/categories.php", { method: "POST", body: { name } });
  await loadFoodCategories();
  return c;
}
async function renameCategory(categoryId, name) {
  const c = await apiFetch(`/categories.php${qs({ id: categoryId })}`, { method: "PATCH", body: { name } });
  await loadFoodCategories();
  return c;
}
async function deleteCategory(categoryId) {
  await apiFetch(`/categories.php${qs({ id: categoryId })}`, { method: "DELETE" });
  await loadFoodCategories();
}

/* ---------- Donations ---------- */
function getDonations(filters = {}) {
  return apiFetch(`/donations.php${qs(filters)}`);
}
function getDonationById(donationId) {
  return apiFetch(`/donations.php${qs({ id: donationId })}`).catch((e) => {
    if (e.status === 404) return null;
    throw e;
  });
}
function createDonation(donation) {
  return apiFetch("/donations.php", { method: "POST", body: donation });
}
// status: "cancelled" | "available" (publish a draft) | "wasted"
function updateDonationStatus(donationId, status, extra = {}) {
  return apiFetch(`/donations.php${qs({ id: donationId })}`, { method: "PATCH", body: { status, ...extra } });
}

/* ---------- Requests ---------- */
function getRequests(filters = {}) {
  return apiFetch(`/requests.php${qs(filters)}`);
}
function createRequest(request) {
  return apiFetch("/requests.php", { method: "POST", body: request });
}
// status: "accepted" | "rejected"  (the server also updates the donation + notifications)
function updateRequestStatus(requestId, status) {
  return apiFetch(`/requests.php${qs({ id: requestId })}`, { method: "PATCH", body: { status } });
}

/* ---------- Pickup assignments ---------- */
function getPickupAssignments(filters = {}) {
  return apiFetch(`/pickup-assignments.php${qs(filters)}`);
}
function getPickupAssignmentById(assignmentId) {
  return apiFetch(`/pickup-assignments.php${qs({ id: assignmentId })}`).catch((e) => {
    if (e.status === 404) return null;
    throw e;
  });
}
// [{ request, donation }] — accepted requests no volunteer has claimed yet
function getAvailableAssignments() {
  return apiFetch("/pickup-assignments.php?available=1");
}
// The volunteer is taken from the login session on the server.
function acceptPickup(requestId) {
  return apiFetch("/pickup-assignments.php", { method: "POST", body: { requestId } });
}
// status: "picked-up" | "in-transit" | "delivered"
function updatePickupStatus(assignmentId, status) {
  return apiFetch(`/pickup-assignments.php${qs({ id: assignmentId })}`, { method: "PATCH", body: { status } });
}

/* ---------- Notifications ---------- */
function getNotifications() {
  return apiFetch("/notifications.php");
}
function markNotificationRead(notificationId) {
  return apiFetch(`/notifications.php${qs({ id: notificationId })}`, { method: "PATCH", body: {} });
}
function markAllNotificationsRead() {
  return apiFetch("/notifications.php?all=1", { method: "PATCH", body: {} });
}

/* ---------- Feedback ---------- */
function getFeedback(filters = {}) {
  return apiFetch(`/feedback.php${qs(filters)}`);
}
function createFeedback(feedback) {
  return apiFetch("/feedback.php", { method: "POST", body: feedback });
}

/* ---------- Waste log / users / audit log ---------- */
function getWasteLogs() {
  return apiFetch("/waste-logs.php");
}
function getUsers() {
  return apiFetch("/users.php");
}
function updateUserStatus(userId, status) {
  return apiFetch(`/users.php${qs({ id: userId })}`, { method: "PATCH", body: { status } });
}
function updateUserProfile(userId, updates) {
  return apiFetch(`/users.php${qs({ id: userId })}`, { method: "PATCH", body: updates });
}
function changePassword(currentPassword, newPassword) {
  return apiFetch("/users.php?action=password", { method: "POST", body: { currentPassword, newPassword } });
}
function getAuditLogs() {
  return apiFetch("/audit-logs.php");
}

/* ---------- Small shared helper ----------
   Pages show server errors (validation, conflicts) as toasts. */
function showError(err) {
  showToast(err && err.message ? err.message : "Something went wrong.", "error");
}

// Escape text that came from the database before it is put into innerHTML.
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
