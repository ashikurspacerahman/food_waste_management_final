/* =========================================================
   Sufra — requests.js
   Donor-facing "Requests" page: shows requests submitted
   against the signed-in donor's donations, with accept/reject
   actions (saved to MySQL through api/requests.php).
   ========================================================= */

async function renderDonorRequests() {
  const donor = getSession();
  if (!donor) return;

  let myDonations, allRequests;
  try {
    // The server only returns this donor's own donations / requests.
    [myDonations, allRequests] = await Promise.all([getDonations(), getRequests()]);
  } catch (err) {
    showError(err);
    return;
  }
  const myDonationsById = Object.fromEntries(myDonations.map((d) => [d.donationId, d]));

  const filterStatus = document.getElementById("filter-request-status")?.value || "";
  let requests = allRequests;
  if (filterStatus) requests = requests.filter((r) => r.status === filterStatus);
  requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const wrap = document.getElementById("requests-table-wrap");
  const empty = document.getElementById("requests-empty");

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
          <th>Recipient</th>
          <th>Requested qty</th>
          <th>People to serve</th>
          <th>Notes</th>
          <th>Status</th>
          <th>Submitted</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${requests
          .map((r) => {
            const donation = myDonationsById[r.donationId];
            return `
          <tr>
            <td>
              <div class="table-cell-with-thumb">
                ${foodThumbHtml(donation)}
                <div>
                  <div class="table-cell-with-thumb__name">${donation ? esc(donation.title) : "Donation removed"}</div>
                  <div class="table-cell-with-thumb__meta">${r.donationId}</div>
                </div>
              </div>
            </td>
            <td>${esc(r.recipientName)}</td>
            <td>${r.requestedQuantity}${donation ? " " + donation.unit : ""}</td>
            <td>${r.peopleToServe ?? "—"}</td>
            <td style="white-space: normal; max-width: 220px;">${esc(r.notes) || "—"}</td>
            <td><span class="badge ${statusBadgeClass(r.status)}">${statusLabel(r.status)}</span></td>
            <td>${formatDateTime(r.createdAt)}</td>
            <td>
              ${
                r.status === "pending"
                  ? `<div style="display:flex; gap:6px;">
                      <button type="button" class="btn btn--primary btn--sm" onclick="handleRequestDecision('${r.requestId}', 'accepted')">Accept</button>
                      <button type="button" class="btn btn--outline btn--sm" onclick="handleRequestDecision('${r.requestId}', 'rejected')">Reject</button>
                    </div>`
                  : `<span class="text-muted" style="font-size: var(--fs-xsmall);">No action needed</span>`
              }
            </td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

async function handleRequestDecision(requestId, decision) {
  const label = decision === "accepted" ? "accept" : "reject";
  if (!confirm(`Are you sure you want to ${label} this request?`)) return;

  try {
    // The server also updates the donation status and notifies everyone involved.
    await updateRequestStatus(requestId, decision);
    if (decision === "accepted") {
      showToast("Request accepted. A volunteer will be assigned next.", "success");
    } else {
      showToast("Request rejected. The donation is open again.");
    }
  } catch (err) {
    showError(err);
  }

  await renderDonorRequests();
}

async function initRequestsPage() {
  const donor = await requireRole("donor");
  if (!donor) return;

  const statusFilter = document.getElementById("filter-request-status");
  if (statusFilter) statusFilter.addEventListener("change", renderDonorRequests);

  await renderDonorRequests();
}
