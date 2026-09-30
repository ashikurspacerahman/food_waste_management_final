/* =========================================================
   Sufra — app.js
   Shared, page-agnostic UI behaviour:
     - mobile navbar toggle
     - toast notifications
     - simple modal open/close helpers
     - small formatting helpers reused across pages

   Every page loads this file. Page-specific logic (login,
   register, donations, etc.) lives in its own JS file and
   calls the helpers defined here.
   ========================================================= */

/* ---------- Mobile navbar toggle ---------- */
function initNavbarToggle() {
  const toggle = document.querySelector("[data-navbar-toggle]");
  const links = document.querySelector("[data-navbar-links]");
  if (!toggle || !links) return;

  toggle.addEventListener("click", () => {
    const isOpen = links.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });

  // Close the menu when a link is tapped (mobile UX nicety)
  links.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      links.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
}

/* ---------- Toast notifications ----------
   Usage: showToast("Donation published.", "success")
   type: "default" | "success" | "error"                     */
function ensureToastRegion() {
  let region = document.querySelector(".toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "toast-region";
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  return region;
}

function showToast(message, type = "default", duration = 3200) {
  const region = ensureToastRegion();
  const toast = document.createElement("div");
  toast.className = `toast${type !== "default" ? ` toast--${type}` : ""}`;
  toast.textContent = message;
  region.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = "opacity 200ms ease";
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

/* ---------- Modal helpers ----------
   Markup expected:
   <div class="modal-overlay" id="myModal" data-modal>
     <div class="modal" role="dialog" aria-modal="true"> ... </div>
   </div>
   Open with openModal('myModal'), close with closeModal('myModal').
*/
function openModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.add("is-open");
  document.body.style.overflow = "hidden";
}

function closeModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove("is-open");
  document.body.style.overflow = "";
}

function initModalDismissBehaviour() {
  document.querySelectorAll("[data-modal]").forEach((overlay) => {
    // click outside the modal box closes it
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
    // any element inside marked data-modal-close closes it
    overlay.querySelectorAll("[data-modal-close]").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(overlay.id));
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-overlay.is-open").forEach((overlay) => {
        closeModal(overlay.id);
      });
    }
  });
}

/* ---------- Small formatting helpers ---------- */

// "2026-09-05T14:00" -> "Sep 5, 2:00 PM"
function formatDateTime(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  if (isNaN(d)) return isoString;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Returns a human "expires in 3h" / "expired" style string
function formatTimeUntil(isoString) {
  if (!isoString) return "—";
  const target = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = target - now;

  if (isNaN(target)) return "—";
  if (diffMs <= 0) return "Expired";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs / (1000 * 60)) % 60);

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `Expires in ${days}d`;
  }
  if (hours >= 1) return `Expires in ${hours}h ${minutes}m`;
  return `Expires in ${minutes}m`;
}

function isExpiringSoon(isoString, thresholdHours = 3) {
  const target = new Date(isoString).getTime();
  const diffMs = target - Date.now();
  return diffMs > 0 && diffMs <= thresholdHours * 60 * 60 * 1000;
}

/* ---------- Dashboard sidebar toggle (mobile off-canvas) ---------- */
function initSidebarToggle() {
  const toggle = document.querySelector("[data-sidebar-toggle]");
  const sidebar = document.querySelector("[data-dashboard-sidebar]");
  const overlay = document.querySelector("[data-sidebar-overlay]");
  if (!toggle || !sidebar) return;

  const open = () => {
    sidebar.classList.add("is-open");
    overlay?.classList.add("is-open");
  };
  const close = () => {
    sidebar.classList.remove("is-open");
    overlay?.classList.remove("is-open");
  };

  toggle.addEventListener("click", () => {
    sidebar.classList.contains("is-open") ? close() : open();
  });
  overlay?.addEventListener("click", close);

  // Close the drawer automatically once the viewport is wide
  // enough to show the sidebar permanently.
  window.addEventListener("resize", () => {
    if (window.innerWidth > 1024) close();
  });
}

/* ---------- Boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initNavbarToggle();
  initModalDismissBehaviour();
  initSidebarToggle();
});
