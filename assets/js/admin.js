/* =========================================================
   Sufra — admin.js
   Admin-facing logic for the dashboard, User Management,
   Donation Management, Waste Log, Audit Log, and Reports pages.
   Charts are plain divs sized by percentage — no chart library,
   per the project's "keep it vanilla" constraint.
   Uses categoryEmoji() / statusBadgeClass() / statusLabel()
   from donations.js — load that file first on these pages.
   ========================================================= */

function round2(n) {
  return Math.round(n * 100) / 100;
}

function barChartRow(label, value, max, variant = "") {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return `
    <div class="bar-chart-row">
      <div class="bar-chart-row__label">${esc(label)}</div>
      <div class="bar-chart-row__track"><div class="bar-chart-row__fill ${variant}" style="width:${pct}%;"></div></div>
      <div class="bar-chart-row__value">${value}</div>
    </div>`;
}

/* ---------- Dashboard ---------- */
async function initAdminDashboard() {
  const admin = await requireRole("admin");
  if (!admin) return;

  document.getElementById("welcome-heading").textContent = `Welcome back, ${admin.name.split(" ")[0]}`;

  let users, donations, wasteLogs, requests;
  try {
    [users, donations, wasteLogs, requests] = await Promise.all([getUsers(), getDonations(), getWasteLogs(), getRequests()]);
  } catch (err) {
    showError(err);
    return;
  }
  const donationsById = Object.fromEntries(donations.map((d) => [d.donationId, d]));
  const fulfilled = requests.filter((r) => r.fulfilled);   // requests whose food was actually delivered

  const totalUsers = users.length;
  const totalDonors = users.filter((u) => u.role === "donor").length;
  const totalRecipients = users.filter((u) => u.role === "recipient").length;
  const totalVolunteers = users.filter((u) => u.role === "volunteer").length;
  const activeDonations = donations.filter((d) => ["available", "pending", "claimed"].includes(d.status)).length;
  const completedDonations = fulfilled.length;
  const foodSavedUnits = round2(fulfilled.reduce((sum, r) => sum + r.requestedQuantity, 0));
  const foodWastedUnits = round2(wasteLogs.reduce((sum, w) => sum + w.quantity, 0));

  const stats = [
    { label: "Total users", value: totalUsers },
    { label: "Total donors", value: totalDonors },
    { label: "Total recipients", value: totalRecipients },
    { label: "Total volunteers", value: totalVolunteers },
    { label: "Active donations", value: activeDonations },
    { label: "Completed donations", value: completedDonations },
    { label: "Food saved (units)", value: foodSavedUnits },
    { label: "Food wasted (units)", value: foodWastedUnits },
  ];

  document.getElementById("stat-grid").innerHTML = stats
    .map(
      (s) => `
    <div class="stat-card">
      <div class="stat-card__label">${s.label}</div>
      <div class="stat-card__value">${s.value}</div>
    </div>`
    )
    .join("");

  // Donation status distribution — simple bar chart, mixed units
  // noted as counts of donations, not weight, to stay honest.
  const statuses = ["available", "pending", "claimed", "delivered", "expired", "wasted", "cancelled"];
  const statusCounts = statuses.map((s) => ({ status: s, count: donations.filter((d) => d.status === s).length }));
  const maxStatusCount = Math.max(...statusCounts.map((s) => s.count), 1);

  document.getElementById("status-distribution-chart").innerHTML = statusCounts
    .map((s) => barChartRow(statusLabel(s.status), s.count, maxStatusCount))
    .join("");

  document.getElementById("dashboard-data-note").textContent =
    "Live figures from the MySQL database. Food saved counts delivered quantities of fulfilled requests (mixed units).";
}

/* ---------- User Management ---------- */
async function renderUsersTable() {
  const search = (document.getElementById("filter-user-search")?.value || "").toLowerCase().trim();
  const role = document.getElementById("filter-user-role")?.value || "";
  const status = document.getElementById("filter-user-status")?.value || "";

  let users;
  try {
    users = await getUsers();
  } catch (err) {
    showError(err);
    return;
  }
  if (search) users = users.filter((u) => u.name.toLowerCase().includes(search) || u.email.toLowerCase().includes(search));
  if (role) users = users.filter((u) => u.role === role);
  if (status) users = users.filter((u) => u.status === status);

  users = [...users].sort((a, b) => new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0));

  const wrap = document.getElementById("users-table-wrap");
  const empty = document.getElementById("users-empty");

  if (users.length === 0) {
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
          <th>User ID</th>
          <th>Name</th>
          <th>Email</th>
          <th>Role</th>
          <th>Status</th>
          <th>Registered</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${users
          .map(
            (u) => `
          <tr>
            <td>${u.userId}</td>
            <td>${esc(u.name)}</td>
            <td>${esc(u.email)}</td>
            <td style="text-transform:capitalize;">${u.role}</td>
            <td><span class="badge ${u.status === "active" ? "badge--available" : "badge--cancelled"}">${u.status === "active" ? "Active" : "Inactive"}</span></td>
            <td>${u.registeredAt ? formatDateTime(u.registeredAt) : "—"}</td>
            <td>
              <div style="display:flex; gap:6px;">
                <button type="button" class="btn btn--outline btn--sm" onclick="showToast(${esc(JSON.stringify(u.name + ": " + u.role + ", " + u.status + "."))})">View</button>
                ${
                  u.status === "active"
                    ? `<button type="button" class="btn btn--ghost btn--sm" onclick="handleUserStatusToggle('${u.userId}', 'inactive')">Deactivate</button>`
                    : `<button type="button" class="btn btn--outline btn--sm" onclick="handleUserStatusToggle('${u.userId}', 'active')">Activate</button>`
                }
              </div>
            </td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

async function handleUserStatusToggle(userId, newStatus) {
  const label = newStatus === "active" ? "activate" : "deactivate";
  if (!confirm(`Are you sure you want to ${label} this user?`)) return;
  try {
    await updateUserStatus(userId, newStatus);
    showToast(`User ${newStatus === "active" ? "activated" : "deactivated"}.`, "success");
  } catch (err) {
    showError(err);
  }
  await renderUsersTable();
}

async function initUsersPage() {
  const admin = await requireRole("admin");
  if (!admin) return;

  ["filter-user-search", "filter-user-role", "filter-user-status"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderUsersTable);
  });

  await renderUsersTable();
}

/* ---------- Donation Management ---------- */
async function renderAdminDonationsTable() {
  const search = (document.getElementById("filter-admin-donation-search")?.value || "").toLowerCase().trim();
  const status = document.getElementById("filter-admin-donation-status")?.value || "";
  const category = document.getElementById("filter-admin-donation-category")?.value || "";

  let donations;
  try {
    donations = await getDonations();
  } catch (err) {
    showError(err);
    return;
  }
  if (search) donations = donations.filter((d) => d.title.toLowerCase().includes(search) || d.donorName.toLowerCase().includes(search));
  if (status) donations = donations.filter((d) => d.status === status);
  if (category) donations = donations.filter((d) => d.categoryId === category);

  donations = [...donations].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const wrap = document.getElementById("admin-donations-table-wrap");
  const empty = document.getElementById("admin-donations-empty");

  if (donations.length === 0) {
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
          <th>Donation ID</th>
          <th>Donor</th>
          <th>Food</th>
          <th>Category</th>
          <th>Quantity</th>
          <th>Expiry</th>
          <th>Status</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        ${donations
          .map(
            (d) => `
          <tr>
            <td>${d.donationId}</td>
            <td>${esc(d.donorName)}</td>
            <td>
              <div class="table-cell-with-thumb">
                <div class="food-thumb">${categoryEmoji(d.categoryId)}</div>
                <div class="table-cell-with-thumb__name">${esc(d.title)}</div>
              </div>
            </td>
            <td>${getCategoryName(d.categoryId)}</td>
            <td>${d.quantity} ${d.unit}</td>
            <td>${formatDateTime(d.expiresAt)}</td>
            <td><span class="badge ${statusBadgeClass(d.status)}">${statusLabel(d.status)}</span></td>
            <td>${formatDateTime(d.createdAt)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

async function initAdminDonationsPage() {
  const admin = await requireRole("admin");
  if (!admin) return;

  const categorySelect = document.getElementById("filter-admin-donation-category");
  if (categorySelect) {
    getFoodCategoriesSync().forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.categoryId;
      opt.textContent = c.name;
      categorySelect.appendChild(opt);
    });
  }

  ["filter-admin-donation-search", "filter-admin-donation-status", "filter-admin-donation-category"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderAdminDonationsTable);
  });

  await renderAdminDonationsTable();
}

/* ---------- Waste Log ---------- */
async function initWasteLogPage() {
  const admin = await requireRole("admin");
  if (!admin) return;

  let wasteLogs;
  try {
    wasteLogs = await getWasteLogs();
  } catch (err) {
    showError(err);
    return;
  }

  const byCategory = {};
  wasteLogs.forEach((w) => {
    const name = getCategoryName(w.categoryId);
    byCategory[name] = (byCategory[name] || 0) + w.quantity;
  });
  const mostWastedCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];

  const now = new Date();
  const expiredThisMonth = wasteLogs.filter((w) => {
    const d = new Date(w.loggedAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  const totalWastedNote = wasteLogs.length > 0
    ? wasteLogs.slice(0, 6).map((w) => `${w.quantity} ${w.unit}`).join(" + ") + (wasteLogs.length > 6 ? " + …" : "")
    : "0";

  document.getElementById("waste-summary-grid").innerHTML = `
    <div class="stat-card">
      <div class="stat-card__label">Total wasted food logs</div>
      <div class="stat-card__value">${wasteLogs.length}</div>
      <div class="stat-card__delta">${totalWastedNote} across units</div>
    </div>
    <div class="stat-card">
      <div class="stat-card__label">Most wasted category</div>
      <div class="stat-card__value" style="font-size:1.3rem;">${mostWastedCategory ? esc(mostWastedCategory[0]) : "—"}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card__label">Donations expired this month</div>
      <div class="stat-card__value">${expiredThisMonth}</div>
    </div>`;

  const wrap = document.getElementById("waste-log-table-wrap");
  const empty = document.getElementById("waste-log-empty");

  if (wasteLogs.length === 0) {
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
          <th>Donation</th>
          <th>Category</th>
          <th>Quantity</th>
          <th>Expiry date</th>
          <th>Reason</th>
          <th>Logged date</th>
        </tr>
      </thead>
      <tbody>
        ${wasteLogs
          .map((w) => {
            return `
          <tr>
            <td>
              <div class="table-cell-with-thumb">
                <div class="food-thumb">${categoryEmoji(w.categoryId)}</div>
                <div class="table-cell-with-thumb__name">${esc(w.donationTitle)}</div>
              </div>
            </td>
            <td>${getCategoryName(w.categoryId)}</td>
            <td>${w.quantity} ${w.unit}</td>
            <td>${formatDateTime(w.expiresAt)}</td>
            <td>${esc(w.reason)}</td>
            <td>${formatDateTime(w.loggedAt)}</td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

/* ---------- Audit Log ---------- */
async function initAuditLogPage() {
  const admin = await requireRole("admin");
  if (!admin) return;

  let logs;
  try {
    logs = await getAuditLogs();
  } catch (err) {
    showError(err);
    return;
  }
  const wrap = document.getElementById("audit-log-table-wrap");
  const empty = document.getElementById("audit-log-empty");

  if (logs.length === 0) {
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
          <th>Timestamp</th>
          <th>User</th>
          <th>Action</th>
          <th>Entity</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        ${logs
          .map(
            (l) => `
          <tr>
            <td>${formatDateTime(l.timestamp)}</td>
            <td>${esc(l.userName)}</td>
            <td>${esc(l.action)}</td>
            <td>${esc(l.entity)}</td>
            <td style="white-space:normal; max-width: 360px;">${esc(l.description)}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

/* ---------- Admin: all Requests (view-only) ---------- */
async function initAdminRequestsPage() {
  const admin = await requireRole("admin");
  if (!admin) return;

  let donations, allRequests;
  try {
    [donations, allRequests] = await Promise.all([getDonations(), getRequests()]);
  } catch (err) {
    showError(err);
    return;
  }
  const donationsById = Object.fromEntries(donations.map((d) => [d.donationId, d]));
  const requests = [...allRequests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const wrap = document.getElementById("admin-requests-table-wrap");
  const empty = document.getElementById("admin-requests-empty");

  if (requests.length === 0) {
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
          <th>Donation</th>
          <th>Donor</th>
          <th>Recipient</th>
          <th>Requested qty</th>
          <th>Status</th>
          <th>Submitted</th>
        </tr>
      </thead>
      <tbody>
        ${requests
          .map((r) => {
            const d = donationsById[r.donationId];
            return `
          <tr>
            <td>
              <div class="table-cell-with-thumb">
                <div class="food-thumb">${d ? categoryEmoji(d.categoryId) : "🍽️"}</div>
                <div class="table-cell-with-thumb__name">${d ? esc(d.title) : r.donationId}</div>
              </div>
            </td>
            <td>${d ? esc(d.donorName) : "—"}</td>
            <td>${esc(r.recipientName)}</td>
            <td>${r.requestedQuantity}${d ? " " + d.unit : ""}</td>
            <td><span class="badge ${statusBadgeClass(r.status)}">${statusLabel(r.status)}</span></td>
            <td>${formatDateTime(r.createdAt)}</td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

/* ---------- Admin: all Pickup Assignments (view-only) ---------- */
async function initAdminPickupAssignmentsPage() {
  const admin = await requireRole("admin");
  if (!admin) return;

  let donations, assignments;
  try {
    [donations, assignments] = await Promise.all([getDonations(), getPickupAssignments()]);
  } catch (err) {
    showError(err);
    return;
  }
  const donationsById = Object.fromEntries(donations.map((d) => [d.donationId, d]));

  const wrap = document.getElementById("admin-pickups-table-wrap");
  const empty = document.getElementById("admin-pickups-empty");

  if (assignments.length === 0) {
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
          <th>Donor</th>
          <th>Recipient</th>
          <th>Volunteer</th>
          <th>Pickup location</th>
          <th>Delivery location</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${assignments
          .map((a) => {
            const donation = donationsById[a.donationId];
            return `
          <tr>
            <td>
              <div class="table-cell-with-thumb">
                <div class="food-thumb">${donation ? categoryEmoji(donation.categoryId) : "🍽️"}</div>
                <div class="table-cell-with-thumb__name">${donation ? esc(donation.title) : "—"}</div>
              </div>
            </td>
            <td>${esc(a.donorName)}</td>
            <td>${esc(a.recipientName)}</td>
            <td>${esc(a.volunteerName)}</td>
            <td>${esc(a.pickupAddress)}</td>
            <td>${esc(a.deliveryAddress)}</td>
            <td><span class="badge ${statusBadgeClass(a.status)}">${statusLabel(a.status)}</span></td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}
async function initReportsPage() {
  const admin = await requireRole("admin");
  if (!admin) return;

  let donations, wasteLogs, assignments, users, requests;
  try {
    [donations, wasteLogs, assignments, users, requests] = await Promise.all([
      getDonations(), getWasteLogs(), getPickupAssignments(), getUsers(), getRequests(),
    ]);
  } catch (err) {
    showError(err);
    return;
  }
  const donationsById = Object.fromEntries(donations.map((d) => [d.donationId, d]));
  const fulfilled = requests.filter((r) => r.fulfilled);

  // Food saved by donor (delivered quantity of every fulfilled request)
  const savedByDonor = {};
  fulfilled.forEach((r) => {
    const d = donationsById[r.donationId];
    if (!d) return;
    savedByDonor[d.donorName] = round2((savedByDonor[d.donorName] || 0) + r.requestedQuantity);
  });
  const savedByDonorEntries = Object.entries(savedByDonor);
  const maxSaved = Math.max(...savedByDonorEntries.map(([, v]) => v), 1);
  document.getElementById("report-saved-by-donor").innerHTML =
    savedByDonorEntries.length > 0
      ? savedByDonorEntries.map(([name, v]) => barChartRow(name, v, maxSaved)).join("")
      : `<p class="text-muted">No completed donations yet.</p>`;

  // Food wasted by category
  const wastedByCategory = {};
  wasteLogs.forEach((w) => {
    const name = getCategoryName(w.categoryId);
    wastedByCategory[name] = (wastedByCategory[name] || 0) + w.quantity;
  });
  const wastedEntries = Object.entries(wastedByCategory);
  const maxWasted = Math.max(...wastedEntries.map(([, v]) => v), 1);
  document.getElementById("report-wasted-by-category").innerHTML =
    wastedEntries.length > 0
      ? wastedEntries.map(([name, v]) => barChartRow(name, v, maxWasted, "bar-chart-row__fill--danger")).join("")
      : `<p class="text-muted">No waste logged yet.</p>`;

  // Donation status distribution
  const statuses = ["available", "pending", "claimed", "delivered", "expired", "wasted", "cancelled"];
  const statusCounts = statuses.map((s) => ({ status: s, count: donations.filter((d) => d.status === s).length }));
  const maxStatus = Math.max(...statusCounts.map((s) => s.count), 1);
  document.getElementById("report-status-distribution").innerHTML = statusCounts
    .map((s) => barChartRow(statusLabel(s.status), s.count, maxStatus, "bar-chart-row__fill--info"))
    .join("");

  // Volunteer performance (deliveries completed per volunteer)
  const volunteers = users.filter((u) => u.role === "volunteer");
  const perVolunteer = volunteers.map((v) => ({
    name: v.name,
    count: assignments.filter((a) => a.volunteerId === v.userId && a.status === "delivered").length,
  }));
  const maxVolunteer = Math.max(...perVolunteer.map((v) => v.count), 1);
  document.getElementById("report-volunteer-performance").innerHTML =
    perVolunteer.length > 0
      ? perVolunteer.map((v) => barChartRow(v.name, v.count, maxVolunteer, "bar-chart-row__fill--accent")).join("")
      : `<p class="text-muted">No volunteers yet.</p>`;

  // Monthly donation trend (by month posted)
  const byMonth = {};
  donations.forEach((d) => {
    const date = new Date(d.createdAt);
    const key = date.toLocaleString(undefined, { month: "short", year: "numeric" });
    byMonth[key] = (byMonth[key] || 0) + 1;
  });
  const monthEntries = Object.entries(byMonth).sort((a, b) => new Date(a[0]) - new Date(b[0]));
  const maxMonth = Math.max(...monthEntries.map(([, v]) => v), 1);
  document.getElementById("report-monthly-trend").innerHTML = monthEntries
    .map(([label, v]) => barChartRow(label, v, maxMonth))
    .join("");

  // Completed vs expired donations
  const completed = fulfilled.length;
  const expired = donations.filter((d) => d.status === "expired").length;
  const maxCompletedExpired = Math.max(completed, expired, 1);
  document.getElementById("report-completed-vs-expired").innerHTML =
    barChartRow("Completed", completed, maxCompletedExpired) +
    barChartRow("Expired", expired, maxCompletedExpired, "bar-chart-row__fill--danger");
}


/* ---------- Food Categories (full CRUD, from the backend's manage_categories.php) ---------- */
async function renderCategoriesTable() {
  const wrap = document.getElementById("categories-table-wrap");
  let categories;
  try {
    categories = await loadFoodCategories();
  } catch (err) {
    showError(err);
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead><tr><th>ID</th><th>Name</th><th>Actions</th></tr></thead>
      <tbody>
        ${categories
          .map(
            (c) => `
          <tr>
            <td>${esc(c.categoryId)}</td>
            <td>${esc(c.name)}</td>
            <td>
              <div style="display:flex; gap:6px;">
                <button type="button" class="btn btn--outline btn--sm" data-rename="${esc(c.categoryId)}">Rename</button>
                <button type="button" class="btn btn--ghost btn--sm" data-delete="${esc(c.categoryId)}">Delete</button>
              </div>
            </td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;

  wrap.querySelectorAll("[data-rename]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const current = categories.find((c) => c.categoryId === btn.dataset.rename);
      const name = prompt("New name for this category:", current ? current.name : "");
      if (name === null || name.trim() === "") return;
      try {
        await renameCategory(btn.dataset.rename, name.trim());
        showToast("Category renamed.", "success");
      } catch (err) {
        showError(err);
      }
      await renderCategoriesTable();
    })
  );

  wrap.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this category? Existing donations will become uncategorized.")) return;
      try {
        await deleteCategory(btn.dataset.delete);
        showToast("Category deleted.", "success");
      } catch (err) {
        showError(err);
      }
      await renderCategoriesTable();
    })
  );
}

async function initCategoriesPage() {
  const admin = await requireRole("admin");
  if (!admin) return;

  const form = document.querySelector("[data-category-form]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!validateField(form.name, name.length > 0)) return;
    try {
      await createCategory(name);
      form.reset();
      showToast("Category added.", "success");
    } catch (err) {
      showError(err);
    }
    await renderCategoriesTable();
  });

  await renderCategoriesTable();
}
