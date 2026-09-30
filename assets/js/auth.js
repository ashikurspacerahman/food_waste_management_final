/* =========================================================
   Sufra — auth.js   (REAL BACKEND VERSION)

   Real login through PHP sessions (api/login.php, session.php,
   logout.php, register.php). Nothing about the user is kept in
   localStorage any more — the PHP session cookie is the login.

   Kept from the old demo version (same names, so pages barely change):
     getSession(), requireRole(role), logout(), basePath()
   Differences:
     - requireRole() is ASYNC (it asks the server who is logged in)
     - getSession() is synchronous and returns the user that
       requireRole() already loaded (null before that)
   ========================================================= */

let _sessionUser = null;

function getSession() {
  return _sessionUser;
}

function setSession(user) {
  _sessionUser = user;
}

// Works whether the page is at the project root (index/login/register) or one
// level down (donor/, recipient/, volunteer/, admin/).
function basePath() {
  const inRoleFolder = /\/(donor|recipient|volunteer|admin)\//.test(window.location.pathname);
  return inRoleFolder ? "../" : "";
}

async function logout() {
  try {
    await apiFetch("/logout.php", { method: "POST", body: {} });
  } catch (e) {
    /* even if the request fails, leave the page */
  }
  _sessionUser = null;
  window.location.href = basePath() + "login.html";
}

function dashboardPathForRole(role) {
  const paths = {
    donor: "donor/dashboard.html",
    recipient: "recipient/dashboard.html",
    volunteer: "volunteer/dashboard.html",
    admin: "admin/dashboard.html",
  };
  return basePath() + (paths[role] || "login.html");
}

/* ---------- Route guard for role-specific pages ----------
   Usage at the top of a page's init function:
     const donor = await requireRole("donor");
     if (!donor) return;
   Asks the server who is logged in. If nobody is (or the role is wrong)
   it redirects to the login page and returns null. On success it also
   loads the food categories and fills the round avatar in the top bar. */
async function requireRole(role) {
  let user = null;
  try {
    const res = await apiFetch("/session.php");
    user = res && res.user ? res.user : null;
  } catch (err) {
    showToast(err.message, "error");
    return null;
  }

  if (!user || user.role !== role) {
    sessionStorage.setItem(
      "fw_redirect_notice",
      user ? "That page belongs to a different account type." : "Please log in to view that page."
    );
    window.location.href = user ? dashboardPathForRole(user.role) : basePath() + "login.html";
    return null;
  }

  _sessionUser = user;
  try {
    await loadFoodCategories();
  } catch (err) {
    showToast(err.message, "error");
  }

  const avatar = document.getElementById("topbar-avatar");
  if (avatar) avatar.textContent = user.name.charAt(0).toUpperCase();
  return user;
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function validateField(input, isValid) {
  const field = input.closest(".field");
  if (!field) return isValid;
  field.classList.toggle("has-error", !isValid);
  return isValid;
}

function setFormBusy(form, busy) {
  form.querySelectorAll('button[type="submit"]').forEach((b) => {
    b.disabled = busy;
  });
}

/* ---------- Login ---------- */
async function loginWith(email, password) {
  const user = await apiFetch("/login.php", { method: "POST", body: { email, password } });
  setSession(user);
  showToast(`Welcome back, ${user.name}.`, "success");
  setTimeout(() => {
    window.location.href = dashboardPathForRole(user.role);
  }, 400);
}

// Password shared by all seeded demo accounts (see database/*.sql).
const DEMO_PASSWORD = "demo1234";
const DEMO_EMAILS = {
  donor: "donor@demo.com",
  recipient: "recipient@demo.com",
  volunteer: "volunteer@demo.com",
  admin: "admin@demo.com",
};

// The "Demo login" buttons perform a REAL login against the seeded accounts.
async function demoLoginAs(role) {
  try {
    await loginWith(DEMO_EMAILS[role], DEMO_PASSWORD);
  } catch (err) {
    showError(err);
  }
}

function initLoginForm() {
  const form = document.querySelector("[data-login-form]");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const password = form.password.value;

    let valid = true;
    valid = validateField(form.email, email.length > 0 && email.includes("@")) && valid;
    valid = validateField(form.password, password.length >= 1) && valid;
    if (!valid) return;

    setFormBusy(form, true);
    try {
      await loginWith(email, password);
    } catch (err) {
      showError(err);
      setFormBusy(form, false);
    }
  });
}

/* ---------- Registration ---------- */
function initRegisterForm() {
  const form = document.querySelector("[data-register-form]");
  if (!form) return;

  const roleInputs = form.querySelectorAll('input[name="role"]');
  const roleSections = document.querySelectorAll("[data-role-fields]");

  function syncRoleFields() {
    const selected = form.querySelector('input[name="role"]:checked')?.value;
    roleSections.forEach((section) => {
      const show = section.dataset.roleFields === selected;
      section.hidden = !show;
      section.querySelectorAll("input, select").forEach((el) => {
        el.disabled = !show;
      });
    });
  }

  roleInputs.forEach((input) => input.addEventListener("change", syncRoleFields));
  syncRoleFields();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = form.fullName.value.trim();
    const email = form.email.value.trim();
    const phone = form.phone.value.trim();
    const password = form.password.value;
    const confirmPassword = form.confirmPassword.value;
    const address = form.address.value.trim();
    const role = form.querySelector('input[name="role"]:checked')?.value;

    let valid = true;
    valid = validateField(form.fullName, name.length > 1) && valid;
    valid = validateField(form.email, email.includes("@")) && valid;
    valid = validateField(form.phone, phone.length >= 7) && valid;
    valid = validateField(form.password, password.length >= 6) && valid;
    valid = validateField(form.confirmPassword, confirmPassword === password && confirmPassword.length > 0) && valid;
    valid = validateField(form.address, address.length > 4) && valid;

    if (!role) {
      showToast("Please choose a role.", "error");
      return;
    }
    if (!valid) {
      showToast("Please fix the highlighted fields.", "error");
      return;
    }

    const payload = { role, name, email, phone, password, address };
    if (role === "donor") {
      payload.donorType = form.donorType.value;
      payload.organizationName = form.donorOrg.value.trim();
    }
    if (role === "recipient") {
      payload.recipientType = form.recipientType.value;
      payload.organizationName = form.recipientOrg.value.trim();
    }
    if (role === "volunteer") {
      payload.vehicleType = form.vehicleType.value;
      payload.availability = form.availability.value.trim();
    }

    setFormBusy(form, true);
    try {
      await apiFetch("/register.php", { method: "POST", body: payload });
      showToast("Account created. Redirecting to login…", "success");
      setTimeout(() => {
        window.location.href = basePath() + "login.html";
      }, 900);
    } catch (err) {
      showError(err);
      setFormBusy(form, false);
    }
  });
}

/* ---------- Forgot / reset password ---------- */
function initForgotPasswordForm() {
  const form = document.querySelector("[data-forgot-form]");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!validateField(form.email, email.includes("@"))) return;

    setFormBusy(form, true);
    try {
      const res = await apiFetch("/forgot-password.php", { method: "POST", body: { email } });
      const box = document.getElementById("forgot-result");
      let html = `<p>${esc(res.message)}</p>`;
      if (res.resetLink) {
        html += `<p><strong>Demo reset link</strong> (a real system would email this):</p>
                 <p><a href="${esc(res.resetLink)}">Open the reset page</a></p>`;
      }
      box.innerHTML = html;
      box.hidden = false;
    } catch (err) {
      showError(err);
    }
    setFormBusy(form, false);
  });
}

async function initResetPasswordForm() {
  const form = document.querySelector("[data-reset-form]");
  if (!form) return;

  const token = new URLSearchParams(window.location.search).get("token") || "";
  const invalid = document.getElementById("reset-invalid");

  try {
    await apiFetch(`/reset-password.php${qs({ token })}`);
  } catch (err) {
    form.hidden = true;
    invalid.hidden = false;
    return;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = form.password.value;
    const confirm = form.confirmPassword.value;

    let valid = true;
    valid = validateField(form.password, password.length >= 6) && valid;
    valid = validateField(form.confirmPassword, confirm === password && confirm.length > 0) && valid;
    if (!valid) return;

    setFormBusy(form, true);
    try {
      await apiFetch("/reset-password.php", { method: "POST", body: { token, password } });
      showToast("Password updated. Redirecting to login…", "success");
      setTimeout(() => {
        window.location.href = "login.html";
      }, 1000);
    } catch (err) {
      showError(err);
      setFormBusy(form, false);
    }
  });
}

/* ---------- Boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initLoginForm();
  initRegisterForm();
  initForgotPasswordForm();
  initResetPasswordForm();

  const notice = sessionStorage.getItem("fw_redirect_notice");
  if (notice) {
    sessionStorage.removeItem("fw_redirect_notice");
    showToast(notice, "error");
  }
});
