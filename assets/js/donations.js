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

/* ---------- Food photo helpers (used by donor, recipient and admin views) ---------- */
const FOOD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const FOOD_IMAGE_MAX_MB = 5;

// Returns an error message, or "" when the file looks acceptable.
// (The server re-checks everything; this just gives instant feedback.)
function validateFoodImageFile(file) {
  if (!file) return "";
  if (!FOOD_IMAGE_TYPES.includes(file.type)) return "Please upload a JPG, PNG, or WEBP image.";
  if (file.size > FOOD_IMAGE_MAX_MB * 1024 * 1024) return `Image must be under ${FOOD_IMAGE_MAX_MB}MB.`;
  return "";
}

// If a photo fails to load, fall back to the category emoji placeholder.
function foodImageFailed(img) {
  const parent = img.parentElement;
  if (parent) parent.classList.remove("food-thumb--photo");
  img.replaceWith(document.createTextNode(img.dataset.emoji || "🍽️"));
}

// Small square (or large, when `large`) thumbnail: the uploaded photo, or the emoji placeholder.
function foodThumbHtml(donation, large = false) {
  const emoji = categoryEmoji(donation ? donation.categoryId : null);
  const cls = "food-thumb" + (large ? " food-thumb--lg" : "");
  const src = donation ? foodImageSrc(donation.imageUrl) : null;
  if (!src) return `<div class="${cls}">${emoji}</div>`;
  return `<div class="${cls} food-thumb--photo"><img src="${esc(src)}" alt="${esc(donation.title)}" loading="lazy" data-emoji="${esc(emoji)}" onerror="foodImageFailed(this)" /></div>`;
}

// Cover for the recipient's donation cards: the photo, or the emoji placeholder.
function foodCoverHtml(donation) {
  const emoji = categoryEmoji(donation.categoryId);
  const src = foodImageSrc(donation.imageUrl);
  if (!src) return emoji;
  return `<img class="donation-card__img" src="${esc(src)}" alt="${esc(donation.title)}" loading="lazy" data-emoji="${esc(emoji)}" onerror="foodImageFailed(this)" />`;
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
                ${foodThumbHtml(d)}
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
  const previewBox = form.querySelector("[data-image-preview]");
  const previewImg = previewBox ? previewBox.querySelector("img") : null;
  let previewUrl = null;

  function clearImagePreview() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    if (previewImg) previewImg.removeAttribute("src");
    if (previewBox) previewBox.hidden = true;
  }

  if (imageInput) {
    const imageField = imageInput.closest(".field");

    imageInput.addEventListener("change", () => {
      clearImagePreview();
      const file = imageInput.files[0];
      if (!file) {
        imageField.classList.remove("has-error");
        return;
      }
      const problem = validateFoodImageFile(file);
      if (problem) {
        imageField.querySelector(".field__error").textContent = problem;
        imageField.classList.add("has-error");
        imageInput.value = "";          // don't keep a file the server would reject
        return;
      }
      imageField.classList.remove("has-error");
      if (previewImg && previewBox) {
        previewUrl = URL.createObjectURL(file);
        previewImg.src = previewUrl;
        previewBox.hidden = false;
      }
    });

    const clearBtn = form.querySelector("[data-image-clear]");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        imageInput.value = "";
        imageField.classList.remove("has-error");
        clearImagePreview();
      });
    }
  }

  let submitting = false;

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

    const imageFile = imageInput ? imageInput.files[0] : null;
    const imageProblem = validateFoodImageFile(imageFile);
    if (imageProblem) {
      const imageField = imageInput.closest(".field");
      imageField.querySelector(".field__error").textContent = imageProblem;
      imageField.classList.add("has-error");
      valid = false;
    }

    if (!valid) {
      showToast("Please fix the highlighted fields.", "error");
      return;
    }
    if (submitting) return;
    submitting = true;

    // multipart/form-data so the photo can travel with the other fields
    const data = new FormData();
    data.append("title", title);
    data.append("categoryId", categoryId);
    data.append("description", description);
    data.append("quantity", quantity);
    data.append("unit", unit);
    data.append("preparedAt", preparedAt);
    data.append("expiresAt", expiresAt);
    data.append("pickupAddress", pickupAddress);
    data.append("contact", contact);
    data.append("notes", form.notes.value.trim());
    data.append("status", status === "draft" ? "draft" : "available");
    if (imageFile) data.append("image", imageFile);

    try {
      await createDonation(data);

      showToast(status === "draft" ? "Draft saved." : "Donation published.", "success");
      setTimeout(() => {
        window.location.href = "donations.html";
      }, 700);
    } catch (err) {
      showError(err);
      submitting = false;
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
        ${foodThumbHtml(donation, true)}
        ${
          ["draft", "available", "pending"].includes(donation.status)
            ? `<div class="image-actions">
                <input type="file" id="replace-image-input" accept="image/jpeg,image/png,image/webp" hidden />
                <button type="button" class="btn btn--outline btn--sm" id="replace-image-btn">${donation.imageUrl ? "Replace photo" : "Add photo"}</button>
                <span class="field__hint">JPG, PNG, or WEBP — up to 5MB.</span>
              </div>`
            : ""
        }
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

  const replaceBtn = document.getElementById("replace-image-btn");
  const replaceInput = document.getElementById("replace-image-input");
  if (replaceBtn && replaceInput) {
    replaceBtn.addEventListener("click", () => replaceInput.click());
    replaceInput.addEventListener("change", async () => {
      const file = replaceInput.files[0];
      if (!file) return;
      const problem = validateFoodImageFile(file);
      if (problem) {
        showToast(problem, "error");
        replaceInput.value = "";
        return;
      }
      replaceBtn.disabled = true;
      try {
        await replaceDonationImage(donation.donationId, file);
        showToast("Photo updated.", "success");
        await initDonationDetailsPage();      // re-render with the new photo
      } catch (err) {
        showError(err);
        replaceBtn.disabled = false;
        replaceInput.value = "";
      }
    });
  }
}
