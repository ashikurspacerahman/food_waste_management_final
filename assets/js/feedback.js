/* =========================================================
   Sufra — feedback.js
   - Recipient: leave feedback on completed (delivered) requests,
     and see feedback already given.
   - Donor: see feedback received from recipients.
   - Admin: see all feedback platform-wide.
   Uses categoryEmoji() from donations.js on some pages.
   ========================================================= */

function starRatingWidget(inputName, initialValue = 0) {
  return `
    <div class="star-rating" data-star-rating data-input-name="${inputName}">
      ${[1, 2, 3, 4, 5]
        .map(
          (n) => `<button type="button" class="star-rating__star" data-value="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`
        )
        .join("")}
      <input type="hidden" name="${inputName}" value="${initialValue}" required />
    </div>`;
}

function initStarRatingWidgets(root = document) {
  root.querySelectorAll("[data-star-rating]").forEach((widget) => {
    const hiddenInput = widget.querySelector('input[type="hidden"]');
    const stars = [...widget.querySelectorAll(".star-rating__star")];

    function paint(value) {
      stars.forEach((s) => s.classList.toggle("is-filled", Number(s.dataset.value) <= value));
    }
    paint(Number(hiddenInput.value) || 0);

    stars.forEach((star) => {
      star.addEventListener("click", () => {
        hiddenInput.value = star.dataset.value;
        paint(Number(star.dataset.value));
      });
    });
  });
}

/* ---------- helpers ---------- */
function starText(rating) {
  const r = Number(rating) || 0;
  return "★".repeat(r) + "☆".repeat(5 - r);
}

/* ---------- Recipient: leave + view feedback ---------- */
async function renderRecipientFeedbackPage() {
  const recipient = getSession();
  if (!recipient) return;

  let donations, given, myRequests;
  try {
    [donations, given, myRequests] = await Promise.all([
      getDonations(),
      getFeedback(),
      getRequests({ recipientId: recipient.userId }),
    ]);
  } catch (err) {
    showError(err);
    return;
  }
  const donationsById = Object.fromEntries(donations.map((d) => [d.donationId, d]));
  const givenRequestIds = new Set(given.map((f) => f.requestId));

  // A delivery can be reviewed once per request (fulfilled = the food was delivered).
  const eligible = myRequests.filter((r) => r.fulfilled && !givenRequestIds.has(r.requestId) && donationsById[r.donationId]);

  const pendingWrap = document.getElementById("feedback-pending-list");
  const pendingEmpty = document.getElementById("feedback-pending-empty");

  if (eligible.length === 0) {
    pendingWrap.hidden = true;
    pendingEmpty.hidden = false;
  } else {
    pendingEmpty.hidden = true;
    pendingWrap.hidden = false;
    pendingWrap.innerHTML = eligible
      .map((r) => {
        const d = donationsById[r.donationId];
        return `
        <div class="card">
          <div class="table-cell-with-thumb" style="margin-bottom: var(--space-3);">
            <div class="food-thumb">${categoryEmoji(d.categoryId)}</div>
            <div>
              <div class="table-cell-with-thumb__name">${esc(d.title)}</div>
              <div class="table-cell-with-thumb__meta">from ${esc(d.donorName)} · ${r.requestedQuantity} ${esc(d.unit)}</div>
            </div>
          </div>
          <form data-feedback-form data-request-id="${r.requestId}" data-has-volunteer="${r.volunteerId ? "1" : ""}" novalidate>
            <div class="field">
              <label class="field__label">Rating for the food &amp; donor</label>
              ${starRatingWidget("rating")}
            </div>
            <div class="field">
              <label class="field__label" for="review-${r.requestId}">Review</label>
              <textarea id="review-${r.requestId}" name="review" placeholder="How was the donation and pickup experience?"></textarea>
            </div>
            ${
              r.volunteerId
                ? `<div class="field">
                    <label class="field__label">Rating for the delivery volunteer (${esc(r.volunteerName || "volunteer")}) — optional</label>
                    ${starRatingWidget("volunteerRating")}
                  </div>
                  <div class="field">
                    <label class="field__label" for="vreview-${r.requestId}">Comment about the delivery — optional</label>
                    <textarea id="vreview-${r.requestId}" name="volunteerReview" placeholder="Was the delivery on time and careful?"></textarea>
                  </div>`
                : ""
            }
            <button type="submit" class="btn btn--primary btn--sm">Submit Feedback</button>
          </form>
        </div>`;
      })
      .join("");
    initStarRatingWidgets(pendingWrap);

    pendingWrap.querySelectorAll("[data-feedback-form]").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const rating = Number(form.rating.value);
        if (!rating) {
          showToast("Please select a star rating.", "error");
          return;
        }
        const payload = {
          requestId: form.dataset.requestId,
          rating,
          review: form.review.value.trim(),
        };
        if (form.dataset.hasVolunteer && form.volunteerRating && Number(form.volunteerRating.value) > 0) {
          payload.volunteerRating = Number(form.volunteerRating.value);
          payload.volunteerReview = form.volunteerReview.value.trim();
        }
        setFormBusy(form, true);
        try {
          await createFeedback(payload);
          showToast("Thanks — feedback submitted.", "success");
          await renderRecipientFeedbackPage();
        } catch (err) {
          showError(err);
          setFormBusy(form, false);
        }
      });
    });
  }

  const givenWrap = document.getElementById("feedback-given-list");
  const givenEmpty = document.getElementById("feedback-given-empty");
  if (given.length === 0) {
    givenWrap.hidden = true;
    givenEmpty.hidden = false;
  } else {
    givenEmpty.hidden = true;
    givenWrap.hidden = false;
    givenWrap.innerHTML = given
      .map(
        (f) => `
        <div class="activity-item">
          <span class="activity-item__dot"></span>
          <div>
            <div>${starText(f.rating)} — ${esc(f.donationTitle)}</div>
            <div class="activity-item__meta">${esc(f.review) || "No written review."} · ${formatDateTime(f.createdAt)}</div>
            ${f.volunteerRating ? `<div class="activity-item__meta">Delivery: ${starText(f.volunteerRating)} ${esc(f.volunteerReview)}</div>` : ""}
          </div>
        </div>`
      )
      .join("");
  }
}

async function initRecipientFeedbackPage() {
  const recipient = await requireRole("recipient");
  if (!recipient) return;
  await renderRecipientFeedbackPage();
}

/* ---------- Donor: feedback received ---------- */
async function initDonorFeedbackPage() {
  const donor = await requireRole("donor");
  if (!donor) return;

  let received;
  try {
    received = await getFeedback();      // the server returns only reviews of this donor's food
  } catch (err) {
    showError(err);
    return;
  }

  const wrap = document.getElementById("feedback-received-list");
  const empty = document.getElementById("feedback-received-empty");
  const average = document.getElementById("feedback-average");

  if (received.length === 0) {
    wrap.hidden = true;
    empty.hidden = false;
    if (average) average.textContent = "No reviews yet";
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;

  const avgRating = (received.reduce((sum, f) => sum + f.rating, 0) / received.length).toFixed(1);
  average.textContent = `${avgRating} ★ average across ${received.length} review${received.length === 1 ? "" : "s"}`;

  wrap.innerHTML = received
    .map(
      (f) => `
      <div class="activity-item">
        <span class="activity-item__dot"></span>
        <div>
          <div>${starText(f.rating)} — ${esc(f.donationTitle)}</div>
          <div class="activity-item__meta">${esc(f.review) || "No written review."} · ${esc(f.fromName)} · ${formatDateTime(f.createdAt)}</div>
        </div>
      </div>`
    )
    .join("");
}

/* ---------- Admin: all feedback ---------- */
async function initAdminFeedbackPage() {
  const admin = await requireRole("admin");
  if (!admin) return;

  let feedback, users;
  try {
    [feedback, users] = await Promise.all([getFeedback(), getUsers()]);
  } catch (err) {
    showError(err);
    return;
  }
  const usersById = Object.fromEntries(users.map((u) => [u.userId, u]));

  const wrap = document.getElementById("admin-feedback-table-wrap");
  const empty = document.getElementById("admin-feedback-empty");

  if (feedback.length === 0) {
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
          <th>From</th>
          <th>To</th>
          <th>Rating</th>
          <th>Review</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        ${feedback
          .map((f) => {
            const to = usersById[f.toUserId];
            return `
          <tr>
            <td>${esc(f.donationTitle)}</td>
            <td>${esc(f.fromName)}</td>
            <td>${to ? esc(to.organizationName || to.name) : "—"}</td>
            <td>${starText(f.rating)}</td>
            <td style="white-space:normal; max-width: 280px;">${esc(f.review) || "—"}</td>
            <td>${formatDateTime(f.createdAt)}</td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}
