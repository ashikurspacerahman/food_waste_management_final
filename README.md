# Sufra — Food Waste Management System (final merged project)

Frontend (Sufra UI) + PHP backend + MySQL schema, merged into one project that runs on **XAMPP**.

Group Members: 1. Md.Ashikur Rahman
               2. Md Ibrahim Hossain Nion
               3.Nazif Faisal

               4.Sumaiya Yasmin
## Run it (5 steps)

1. Install/open **XAMPP** and start **Apache** and **MySQL**.
2. Copy the whole `food_waste_management` folder into `C:\xampp\htdocs\` (Mac/Linux: `/opt/lampp/htdocs/`).
3. Open **http://localhost/phpmyadmin** → *Import* → choose `database/food_waste_management.sql` → *Go*.
   (This creates the `food_waste_management` database, all 15 tables and demo data.)
4. Open **http://localhost/food_waste_management/**
5. Log in with a demo account (password for all: `demo1234`):

| Role      | Email                |
|-----------|----------------------|
| Donor     | donor@demo.com       |
| Recipient | recipient@demo.com   |
| Volunteer | volunteer@demo.com   |
| Admin     | admin@demo.com       |

The "Demo login" buttons on the login page do the same thing with one click.

If your MySQL root user has a password, or the folder/database is named differently, edit **`api/db.php`** (four variables at the top).

## How the pieces fit

```
Browser (HTML/CSS/JS pages)  ──fetch JSON──►  api/*.php  ──PDO──►  MySQL (15 tables)
   assets/js/data-api.js                       (PHP sessions = login)
```

* **Frontend** — your Sufra pages, unchanged in look. `mock-data.js` (localStorage) was replaced by `assets/js/data-api.js`, which keeps the same function names but calls the API. `auth-demo.js` became `auth.js` (real login).
* **Backend** — the teammate's PHP logic, moved into `api/` as JSON endpoints. All the business rules were kept: donation lock on request, reject re-opens it, volunteer claims a pickup, delivery subtracts quantity and re-opens leftovers, auto-waste of expired food (runs on every API call, no cron needed), notifications, audit log, forgot/reset password, feedback for food + volunteer, admin category CRUD.
* **Database** — the team's *final consolidated schema*, unchanged, plus a few additive columns the Sufra UI needs (each marked `[MERGE ADDITION]` in the SQL file): `AppUser.phone/address/status`, `Volunteer.availability_note`, `FoodDonation.description/prepared_at/contact/notes` + statuses `draft`/`cancelled`, `Request.people_to_serve/notes/preferred_pickup`, `PickupAssignment` status `in_transit`, `AuditLog.description`, and `UNIQUE(request_id)` on `Feedback`.

## Food photos

Donors can attach one photo (JPG, PNG or WebP, max 5 MB) when creating a donation and can add/replace it later from *My Donations → View*. Files are stored in `uploads/food/` (random names, PHP execution blocked by `uploads/food/.htaccess`); MySQL keeps only the relative path in `DonationImage.image_url`. No SQL migration is needed. Details and the test checklist are in `INTEGRATION_PROGRESS.md`.

## Status names (DB → screen)

| Database (`FoodDonation.status`) | Shown in UI |
|---|---|
| available | Available |
| requested | Pending (a request is waiting for the donor) |
| assigned | Claimed (donor accepted, volunteer assigned/pending) |
| delivered / expired / wasted / draft / cancelled | same |

## API endpoints (`api/`)

`login`, `logout`, `session`, `register`, `forgot-password`, `reset-password`, `users`, `categories`, `donations`, `requests`, `pickup-assignments`, `waste-logs`, `feedback`, `notifications`, `audit-logs` (all `.php`). Every endpoint checks the logged-in role on the server.

## Security notes

Prepared statements everywhere (no SQL injection), `password_hash`/`password_verify`, session cookie is HttpOnly, state-changing calls require an `X-Requested-With` header (CSRF guard), all database text is HTML-escaped before display. For a real deployment set `APP_DEBUG` to `false` in `api/helpers.php`.

## Forgot password without a mail server

XAMPP can't send email, so the reset link is shown on screen after you submit your email (it expires in 30 minutes). A real deployment would email it instead.
