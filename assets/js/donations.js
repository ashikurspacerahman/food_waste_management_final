/* =========================================================
   Sufra — donations.js
   Donor-facing donation rendering + form logic.
   Loaded on: donor/donations.html, donor/create-donation.html,
              donor/donation-details.html
   ========================================================= */

const CATEGORY_EMOJI = {
  "Cooked Meal": "🍛",
  "Packaged Food": "📦",
  "Produce": "🥦",
  "Bakery": "🍞",
};

function categoryEmoji(categoryId) {
  return CATEGORY_EMOJI[getCategoryName(categoryId)] || "🍽️";
}

function statusBadgeClass(status) {
  return `badge--${status.replace(/\s+/g, "-")}`;
}

function statusLabel(status) {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/-/g, " ");
}

/* ---------- My Donations table ---------- */
function renderDonationsTable(donations) {
  const wrap = document.getElementById("donations-table-wrap");
  const empty = document.getElementById("donations-empty");
  if (!wrap) return;

  if (donations.length === 0) {
    wrap.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  wrap.hidden = false;

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Food</th>
          <th>Category</th>
          <th>Quantity</th>
          <th>Expiry</th>
          <th>Status</th>
          <th>Requests</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${donations
          .map(
            (d) => `
          <tr>
            <td>
              <div class="table-cell-with-thumb">
                <div class="food-thumb">${categoryEmoji(d.categoryId)}</div>
                <div>
                  <div class="table-cell-with-thumb__name">${esc(d.title)}</div>
                  <div class="table-cell-with-thumb__meta">${d.donationId}</div>
                </div>
              </div>
            </td>
            <td>${getCategoryName(d.categoryId)}</td>
            <td>${d.quantity} ${d.unit}</td>
            <td>
              ${formatDateTime(d.expiresAt)}
              ${isExpiringSoon(d.expiresAt) ? '<div><span class="badge badge--pending" style="margin-top:4px;">Expiring soon</span></div>' : ""}
            </td>
            <td><span class="badge ${statusBadgeClass(d.status)}">${statusLabel(d.status)}</span></td>
            <td>${d.requestCount ?? 0}</td>
            <td>${formatDateTime(d.createdAt)}</td>
            <td>
              <div style="display:flex; gap:6px;">
                <a href="donation-details.html?id=${d.donationId}" class="btn btn--outline btn--sm">View</a>
                ${
                  d.status === "draft"
                    ? `<button type="button" class="btn btn--primary btn--sm" onclick="handlePublishDraft('${d.donationId}')">Publish</button>`
                    : ""
                }
                ${
                  d.status === "available" || d.status === "pending" || d.status === "draft"
                    ? `<button type="button" class="btn btn--ghost btn--sm" onclick="handleCancelDonation('${d.donationId}')">Cancel</button>`
                    : ""
                }
                ${
                  d.status === "available" || d.status === "pending"
                    ? `<button type="button" class="btn btn--ghost btn--sm" onclick="handleMarkWasted('${d.donationId}')">Mark wasted</button>`
                    : ""
                }
              </div>
            </td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

async function handleCancelDonation(donationId) {
  if (!confirm("Cancel this donation? Recipients will no longer be able to request it.")) return;
  try {
    await updateDonationStatus(donationId, "cancelled");
    showToast("Donation cancelled.", "success");
    await applyDonationFilters();
  } catch (err) {
    showError(err);
  }
}

async function handlePublishDraft(donationId) {
  try {
    await updateDonationStatus(donationId, "available");
    showToast("Donation published.", "success");
    await applyDonationFilters();
  } catch (err) {
    showError(err);
  }
}

async function handleMarkWasted(donationId) {
  const reason = prompt("Why could this food not be given out? (optional)", "");
  if (reason === null) return;
  try {
    await updateDonationStatus(donationId, "wasted", { reason });
    showToast("Marked as wasted and added to the waste log.", "success");
    await applyDonationFilters();
  } catch (err) {
    showError(err);
  }
}

async function applyDonationFilters() {
  const donor = getSession();
  if (!donor) return;

  const search = (document.getElementById("filter-search")?.value || "").toLowerCase().trim();
  const category = document.getElementById("filter-category")?.value || "";
  const status = document.getElementById("filter-status")?.value || "";
  const sort = document.getElementById("filter-sort")?.value || "newest";

  let donations;
  try {
    donations = await getDonations({ donorId: donor.userId });
  } catch (err) {
    showError(err);
    return;
  }

  if (search) donations = donations.filter((d) => d.title.toLowerCase().includes(search));
  if (category) donations = donations.filter((d) => d.categoryId === category);
  if (status) donations = donations.filter((d) => d.status === status);

  donations = [...donations].sort((a, b) => {
    if (sort === "newest") return new Date(b.createdAt) - new Date(a.createdAt);
    if (sort === "oldest") return new Date(a.createdAt) - new Date(b.createdAt);
    if (sort === "expiry") return new Date(a.expiresAt) - new Date(b.expiresAt);
    return 0;
  });

  renderDonationsTable(donations);
}

async function initDonationsPage() {
  const donor = await requireRole("donor");
  if (!donor) return;

  const categorySelect = document.getElementById("filter-category");
  if (categorySelect) {
    getFoodCategoriesSync().forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.categoryId;
      opt.textContent = c.name;
      categorySelect.appendChild(opt);
    });
  }

  ["filter-search", "filter-category", "filter-status", "filter-sort"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", applyDonationFilters);
  });

  applyDonationFilters();
}

/* ---------- Create Donation form ---------- */
async function initCreateDonationForm() {
  const donor = await requireRole("donor");
  if (!donor) return;

  const categorySelect = document.getElementById("categoryId");
  if (categorySelect) {
    getFoodCategoriesSync().forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.categoryId;
      opt.textContent = c.name;
      categorySelect.appendChild(opt);
    });
  }

  const form = document.querySelector("[data-donation-form]");
  if (!form) return;

  const imageInput = form.querySelector('input[name="image"]');
  if (imageInput) {
    imageInput.addEventListener("change", () => {
      const file = imageInput.files[0];
      const field = imageInput.closest(".field");
      if (!file) return;

      const validTypes = ["image/jpeg", "image/png", "image/webp"];
      const maxSizeMb = 5;
      let ok = true;
      if (!validTypes.includes(file.type)) {
        field.querySelector(".field__error").textContent = "Please upload a JPG, PNG, or WEBP image.";
        ok = false;
      } else if (file.size > maxSizeMb * 1024 * 1024) {
        field.querySelector(".field__error").textContent = `Image must be under ${maxSizeMb}MB.`;
        ok = false;
      }
      field.classList.toggle("has-error", !ok);
      if (ok) showToast(`"${file.name}" selected.`);
    });
  }

  async function submitDonation(status) {
    const title = form.title.value.trim();
    const categoryId = form.categoryId.value;
    const description = form.description.value.trim();
    const quantity = form.quantity.value;
    const unit = form.unit.value;
    const preparedAt = form.preparedAt.value;
    const expiresAt = form.expiresAt.value;
    const pickupAddress = form.pickupAddress.value.trim();
    const contact = form.contact.value.trim();

    let valid = true;
    valid = validateField(form.title, title.length > 2) && valid;
    valid = validateField(form.categoryId, categoryId !== "") && valid;
    valid = validateField(form.quantity, Number(quantity) > 0) && valid;
    valid = validateField(form.expiresAt, expiresAt !== "") && valid;
    valid = validateField(form.pickupAddress, pickupAddress.length > 4) && valid;
    valid = validateField(form.contact, contact.length > 4) && valid;

    if (preparedAt && expiresAt && new Date(expiresAt) <= new Date(preparedAt)) {
      valid = validateField(form.expiresAt, false);
      form.expiresAt.closest(".field").querySelector(".field__error").textContent =
        "Expiry must be later than the preparation time.";
    }

    if (!valid) {
      showToast("Please fix the highlighted fields.", "error");
      return;
    }

    try {
      await createDonation({
      title,
      categoryId,
      description,
      quantity: Number(quantity),
      unit,
      preparedAt,
      expiresAt,
      pickupAddress,
      contact,
      notes: form.notes.value.trim(),
      status: status === "draft" ? "draft" : "available",
      });

      showToast(status === "draft" ? "Draft saved." : "Donation published.", "success");
      setTimeout(() => {
        window.location.href = "donations.html";
      }, 700);
    } catch (err) {
      showError(err);
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitDonation("publish");
  });

  const draftBtn = document.querySelector("[data-save-draft]");
  if (draftBtn) {
    draftBtn.addEventListener("click", () => submitDonation("draft"));
  }
}

/* ---------- Donation details page ---------- */
async function initDonationDetailsPage() {
  const donor = await requireRole("donor");
  if (!donor) return;

  const params = new URLSearchParams(window.location.search);
  const donationId = params.get("id");
  let donation = null;
  try {
    donation = donationId ? await getDonationById(donationId) : null;
  } catch (err) {
    showError(err);
  }
  const container = document.getElementById("details-container");

  if (!donation) {
    container.innerHTML = `<div class="empty-state"><h3>Donation not found</h3><p>It may have been removed. <a href="donations.html">Back to My Donations</a></p></div>`;
    const headingEl = document.getElementById("donation-heading");
    if (headingEl) headingEl.textContent = "Donation not found";
    return;
  }

  document.getElementById("donation-title").textContent = donation.title;
  document.title = `${donation.title} — Sufra`;
  const headingEl = document.getElementById("donation-heading");
  if (headingEl) headingEl.textContent = donation.title;

  document.getElementById("details-container").innerHTML = `
    <div class="details-grid">
      <div class="stack" style="gap: var(--space-5);">
        <div class="food-thumb food-thumb--lg">${categoryEmoji(donation.categoryId)}</div>
        <div class="card">
          <h3>Description</h3>
          <p>${esc(donation.description) || "No additional description provided."}</p>
        </div>
        <div class="card">
          <h3>Activity timeline</h3>
          <ul class="timeline">
            <li class="is-complete"><strong>Posted</strong><span>${formatDateTime(donation.createdAt)}</span></li>
            <li class="${["pending","claimed","picked-up","delivered"].includes(donation.status) ? "is-complete" : ""}"><strong>Request received</strong><span>${donation.requestCount > 0 ? `${donation.requestCount} request(s)` : "No requests yet"}</span></li>
            <li class="${donation.status === "delivered" ? "is-complete" : ""}"><strong>Delivered</strong><span>${donation.status === "delivered" ? "Completed" : "Not yet"}</span></li>
          </ul>
        </div>
      </div>

      <div class="stack" style="gap: var(--space-5);">
        <div class="card">
          <div class="section-head"><h3>Details</h3><span class="badge ${statusBadgeClass(donation.status)}">${statusLabel(donation.status)}</span></div>
          <div class="details-list">
            <div class="details-list__row"><span class="details-list__label">Category</span><span class="details-list__value">${getCategoryName(donation.categoryId)}</span></div>
            <div class="details-list__row"><span class="details-list__label">Quantity</span><span class="details-list__value">${donation.quantity} ${donation.unit}</span></div>
            <div class="details-list__row"><span class="details-list__label">Prepared</span><span class="details-list__value">${formatDateTime(donation.preparedAt)}</span></div>
            <div class="details-list__row"><span class="details-list__label">Expires</span><span class="details-list__value">${formatDateTime(donation.expiresAt)}</span></div>
            <div class="details-list__row"><span class="details-list__label">Pickup address</span><span class="details-list__value">${esc(donation.pickupAddress)}</span></div>
            <div class="details-list__row"><span class="details-list__label">Requests</span><span class="details-list__value">${donation.requestCount ?? 0}</span></div>
          </div>
        </div>

        <a href="donations.html" class="btn btn--outline btn--block">Back to My Donations</a>
      </div>
    </div>
  `;
}
