/* =========================================================
   Sufra — pickups.js
   Volunteer-facing logic:
     - Available Assignments: accepted requests with no
       volunteer yet, claimable with one click
     - My Pickups: this volunteer's active assignments
     - Delivery History: this volunteer's completed/cancelled
       assignments
     - Pickup Details: full info + timeline + status-advance
       action buttons
   Uses categoryEmoji() / statusBadgeClass() / statusLabel()
   from donations.js — load that file first on these pages.
   ========================================================= */

/* ---------- Available Assignments ---------- */
async function renderAvailableAssignments() {
  const list = document.getElementById("available-assignments-list");
  const empty = document.getElementById("available-assignments-empty");
  if (!list) return;

  let entries;
  try {
    entries = await getAvailableAssignments();
  } catch (err) {
    showError(err);
    return;
  }

  if (entries.length === 0) {
    list.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.hidden = false;

  list.innerHTML = `<div style="display:flex; flex-direction:column; gap: var(--space-3);">
    ${entries
      .map(
        ({ request, donation }) => `
    <div class="card" style="display:flex; flex-wrap:wrap; gap: var(--space-4); align-items:center; justify-content: space-between;">
      <div class="table-cell-with-thumb">
        <div class="food-thumb">${categoryEmoji(donation.categoryId)}</div>
        <div>
          <div class="table-cell-with-thumb__name">${esc(donation.title)}</div>
          <div class="table-cell-with-thumb__meta">${esc(donation.donorName)} → ${esc(request.recipientName)}</div>
          <div class="table-cell-with-thumb__meta">📍 Pickup: ${esc(donation.pickupAddress)}</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap: var(--space-3);">
        <span class="badge badge--pickup-pending">Pickup pending</span>
        <button type="button" class="btn btn--primary btn--sm" onclick="handleAcceptAssignment('${request.requestId}')">Accept Assignment</button>
      </div>
    </div>`
      )
      .join("")}
  </div>`;
}

async function handleAcceptAssignment(requestId) {
  if (!getSession()) return;
  if (!confirm("Accept this pickup assignment?")) return;

  try {
    // The server assigns it to the logged-in volunteer and notifies the donor + recipient.
    await acceptPickup(requestId);
    showToast("Assignment accepted. It's now in My Pickups.", "success");
  } catch (err) {
    showError(err);   // e.g. another volunteer got there first
  }
  await renderAvailableAssignments();
  await renderMyPickupsTable();
}

/* ---------- My Pickups table (also reused, filtered, for history) ---------- */
function renderPickupsTable(assignments, targetId, donationsById = {}) {
  const wrap = document.getElementById(targetId);
  if (!wrap) return;

  if (assignments.length === 0) {
    wrap.innerHTML = "";
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Food donation</th>
          <th>Donor</th>
          <th>Recipient</th>
          <th>Pickup location</th>
          <th>Delivery location</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${assignments
          .map((a) => {
            const donation = donationsById[a.donationId] || null;
            return `
          <tr>
            <td>
              <div class="table-cell-with-thumb">
                <div class="food-thumb">${donation ? categoryEmoji(donation.categoryId) : "🍽️"}</div>
                <div class="table-cell-with-thumb__name">${donation ? esc(donation.title) : "Donation removed"}</div>
              </div>
            </td>
            <td>${esc(a.donorName)}</td>
            <td>${esc(a.recipientName)}</td>
            <td>${esc(a.pickupAddress)}</td>
            <td>${esc(a.deliveryAddress)}</td>
            <td><span class="badge ${statusBadgeClass(a.status)}">${statusLabel(a.status)}</span></td>
            <td><a href="pickup-details.html?id=${a.assignmentId}" class="btn btn--outline btn--sm">View</a></td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

async function renderMyPickupsTable() {
  const volunteer = getSession();
  if (!volunteer) return;
  const wrap = document.getElementById("my-pickups-table-wrap");
  const empty = document.getElementById("my-pickups-empty");
  if (!wrap) return;

  let active, donations;
  try {
    [active, donations] = await Promise.all([getPickupAssignments({ volunteerId: volunteer.userId }), getDonations()]);
  } catch (err) {
    showError(err);
    return;
  }
  active = active.filter((a) => !["delivered", "cancelled"].includes(a.status));

  if (active.length === 0) {
    wrap.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  wrap.hidden = false;
  renderPickupsTable(active, "my-pickups-table-wrap", Object.fromEntries(donations.map((d) => [d.donationId, d])));
}

async function initAssignmentsPage() {
  const volunteer = await requireRole("volunteer");
  if (!volunteer) return;
  await renderAvailableAssignments();
  await renderMyPickupsTable();
}

/* ---------- Delivery History ---------- */
async function renderDeliveryHistory() {
  const volunteer = getSession();
  if (!volunteer) return;
  const wrap = document.getElementById("history-table-wrap");
  const empty = document.getElementById("history-empty");

  const filterValue = document.getElementById("filter-history-status")?.value || "";
  let history, donations;
  try {
    [history, donations] = await Promise.all([getPickupAssignments({ volunteerId: volunteer.userId }), getDonations()]);
  } catch (err) {
    showError(err);
    return;
  }
  history = history.filter((a) => ["delivered", "cancelled"].includes(a.status));
  if (filterValue) history = history.filter((a) => a.status === filterValue);

  if (history.length === 0) {
    wrap.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;
  renderPickupsTable(history, "history-table-wrap", Object.fromEntries(donations.map((d) => [d.donationId, d])));
}

async function initHistoryPage() {
  const volunteer = await requireRole("volunteer");
  if (!volunteer) return;

  const select = document.getElementById("filter-history-status");
  if (select) select.addEventListener("change", renderDeliveryHistory);

  await renderDeliveryHistory();
}

/* ---------- Pickup Details ---------- */
const PICKUP_STAGES = ["assigned", "picked-up", "in-transit", "delivered"];

async function initPickupDetailsPage() {
  const volunteer = await requireRole("volunteer");
  if (!volunteer) return;

  const params = new URLSearchParams(window.location.search);
  const assignmentId = params.get("id");
  let assignment = null;
  try {
    assignment = assignmentId ? await getPickupAssignmentById(assignmentId) : null;
  } catch (err) {
    showError(err);
  }
  const container = document.getElementById("pickup-details-container");
  const headingEl = document.getElementById("pickup-details-heading");

  if (!assignment) {
    container.innerHTML = `<div class="empty-state"><h3>Assignment not found</h3><p>It may have been removed. <a href="assignments.html">Back to Assignments</a></p></div>`;
    if (headingEl) headingEl.textContent = "Assignment not found";
    return;
  }

  let donation = null;
  let request = null;
  try {
    donation = await getDonationById(assignment.donationId);
    request = (await getRequests()).find((r) => r.requestId === assignment.requestId) || null;
  } catch (err) {
    showError(err);
  }

  if (headingEl) headingEl.textContent = donation ? donation.title : "Pickup #" + assignment.assignmentId;
  document.title = `${donation ? donation.title : "Pickup"} — Sufra`;

  const stageIndex = PICKUP_STAGES.indexOf(assignment.status);
  const isCancelled = assignment.status === "cancelled";

  const timelineSteps = [
    { key: "assigned", label: "Assigned", meta: "Volunteer accepted the assignment" },
    { key: "picked-up", label: "Picked up", meta: assignment.status === "picked-up" || stageIndex > 1 ? "Confirmed at pickup location" : "Not yet" },
    { key: "in-transit", label: "In transit", meta: stageIndex > 2 ? "On the way to recipient" : "Not yet" },
    { key: "delivered", label: "Delivered", meta: assignment.status === "delivered" ? formatDateTime(assignment.deliveryTime) : "Not yet" },
  ];

  const actionButton = (() => {
    if (isCancelled) return "";
    if (assignment.status === "assigned") return `<button class="btn btn--primary btn--block" onclick="advancePickup('picked-up')">Confirm Pickup</button>`;
    if (assignment.status === "picked-up") return `<button class="btn btn--primary btn--block" onclick="advancePickup('in-transit')">Mark In Transit</button>`;
    if (assignment.status === "in-transit") return `<button class="btn btn--primary btn--block" onclick="advancePickup('delivered')">Mark Delivered</button>`;
    return `<p class="text-muted" style="margin-bottom:0; text-align:center;">This delivery is complete.</p>`;
  })();

  container.innerHTML = `
    <div class="details-grid">
      <div class="stack" style="gap: var(--space-5);">
        <div class="card">
          <div class="section-head"><h3>Food</h3><span class="badge ${statusBadgeClass(assignment.status)}">${statusLabel(assignment.status)}</span></div>
          <div class="details-list">
            <div class="details-list__row"><span class="details-list__label">Food name</span><span class="details-list__value">${donation ? esc(donation.title) : "—"}</span></div>
            <div class="details-list__row"><span class="details-list__label">Quantity</span><span class="details-list__value">${donation ? `${donation.quantity} ${donation.unit}` : "—"}</span></div>
            <div class="details-list__row"><span class="details-list__label">Expiry</span><span class="details-list__value">${donation ? formatDateTime(donation.expiresAt) : "—"}</span></div>
          </div>
        </div>

        <div class="card">
          <h3>Assignment timeline</h3>
          <ul class="timeline">
            ${timelineSteps
              .map(
                (s, i) => `
              <li class="${isCancelled ? "" : i <= Math.max(stageIndex, 0) ? "is-complete" : ""}">
                <strong>${s.label}</strong>
                <span>${s.meta}</span>
              </li>`
              )
              .join("")}
          </ul>
        </div>
      </div>

      <div class="stack" style="gap: var(--space-5);">
        <div class="card">
          <h3>Donor</h3>
          <div class="details-list">
            <div class="details-list__row"><span class="details-list__label">Name</span><span class="details-list__value">${esc(assignment.donorName)}</span></div>
            <div class="details-list__row"><span class="details-list__label">Pickup address</span><span class="details-list__value">${esc(assignment.pickupAddress)}</span></div>
          </div>
        </div>

        <div class="card">
          <h3>Recipient</h3>
          <div class="details-list">
            <div class="details-list__row"><span class="details-list__label">Name</span><span class="details-list__value">${esc(assignment.recipientName)}</span></div>
            <div class="details-list__row"><span class="details-list__label">Delivery address</span><span class="details-list__value">${esc(assignment.deliveryAddress)}</span></div>
            ${request ? `<div class="details-list__row"><span class="details-list__label">Serving</span><span class="details-list__value">${request.peopleToServe ?? "—"} people</span></div>` : ""}
          </div>
        </div>

        <div class="card">${actionButton}</div>
        <a href="assignments.html" class="btn btn--outline btn--block">Back to Assignments</a>
      </div>
    </div>
  `;
}

async function advancePickup(nextStatus) {
  const params = new URLSearchParams(window.location.search);
  const assignmentId = params.get("id");
  if (!assignmentId) return;

  const labels = { "picked-up": "picked up", "in-transit": "in transit", delivered: "delivered" };
  if (!confirm(`Mark this pickup as ${labels[nextStatus]}?`)) return;

  try {
    // On "delivered" the server also fulfils the request, subtracts the delivered
    // quantity from the donation and notifies the donor and recipient.
    await updatePickupStatus(assignmentId, nextStatus);
    showToast(`Marked as ${labels[nextStatus]}.`, "success");
  } catch (err) {
    showError(err);
  }
  await initPickupDetailsPage();
}

/* ---------- Donor: Pickup Status (read-only) ---------- */
async function renderDonorPickupStatus() {
  const donor = getSession();
  if (!donor) return;

  let donations, assignments, acceptedRequests;
  try {
    // The server only returns this donor's own records.
    [donations, assignments, acceptedRequests] = await Promise.all([
      getDonations(),
      getPickupAssignments(),
      getRequests({ status: "accepted" }),
    ]);
  } catch (err) {
    showError(err);
    return;
  }
  const donationsById = Object.fromEntries(donations.map((d) => [d.donationId, d]));
  const assignmentByRequest = Object.fromEntries(assignments.map((a) => [a.requestId, a]));

  // One row per accepted request (a donation can be delivered in several portions).
  const rows = acceptedRequests
    .map((request) => ({
      request,
      donation: donationsById[request.donationId] || null,
      assignment: assignmentByRequest[request.requestId] || null,
    }))
    .filter((row) => row.donation)
    .sort((a, b) => new Date(b.request.createdAt) - new Date(a.request.createdAt));

  const wrap = document.getElementById("pickup-status-table-wrap");
  const empty = document.getElementById("pickup-status-empty");

  if (rows.length === 0) {
    wrap.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Food donation</th>
          <th>Recipient</th>
          <th>Volunteer</th>
          <th>Pickup location</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(({ donation, assignment, request }) => {
            const status = assignment ? assignment.status : "pickup-pending";
            return `
          <tr>
            <td>
              <div class="table-cell-with-thumb">
                <div class="food-thumb">${categoryEmoji(donation.categoryId)}</div>
                <div>
                  <div class="table-cell-with-thumb__name">${esc(donation.title)}</div>
                  <div class="table-cell-with-thumb__meta">${request.requestedQuantity} ${esc(donation.unit)} · request ${request.requestId}</div>
                </div>
              </div>
            </td>
            <td>${esc(request.recipientName)}</td>
            <td>${assignment ? esc(assignment.volunteerName) : "Awaiting a volunteer"}</td>
            <td>${esc(donation.pickupAddress)}</td>
            <td><span class="badge ${statusBadgeClass(status)}">${statusLabel(status)}</span></td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

async function initDonorPickupStatusPage() {
  const donor = await requireRole("donor");
  if (!donor) return;
  await renderDonorPickupStatus();
}
