-- =====================================================================
-- FOOD WASTE MANAGEMENT SYSTEM (Sufra) - FINAL MERGED DATABASE
-- Engine : MySQL / MariaDB (XAMPP + phpMyAdmin compatible)
--
-- This is the team's FINAL CONSOLIDATED SCHEMA (15 tables, all earlier
-- ALTERs already merged in) PLUS a few small ADDITIVE columns needed so
-- the Sufra frontend can run on real data. Every addition is marked
-- with the tag  [MERGE ADDITION]  so it is easy to spot and explain.
-- No original column or table was removed or renamed.
--
-- HOW TO USE: phpMyAdmin -> Import -> choose this file -> Go.
-- (It DROPS and re-creates the database `food_waste_management`, so
--  only run it on a fresh/dev database.)
--
-- Demo accounts (password for ALL of them: demo1234)
--   donor@demo.com      recipient@demo.com
--   volunteer@demo.com  admin@demo.com
-- =====================================================================

DROP DATABASE IF EXISTS food_waste_management;
CREATE DATABASE food_waste_management CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE food_waste_management;

-- =====================================================================
-- 1. APPUSER (Base entity for ISA hierarchy)
--    + reset_token, reset_expires (Forgot Password feature)
--    [MERGE ADDITION] phone, address, status
--      (the Sufra profile page / admin "activate-deactivate user")
-- =====================================================================
CREATE TABLE AppUser (
    user_id       INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    email         VARCHAR(150) NOT NULL UNIQUE,
    password      VARCHAR(255) NOT NULL,          -- hashed with password_hash()
    role          ENUM('donor', 'volunteer', 'admin', 'recipient') NOT NULL,
    phone         VARCHAR(30)  NULL DEFAULT NULL,                    -- [MERGE ADDITION]
    address       VARCHAR(255) NULL DEFAULT NULL,                    -- [MERGE ADDITION]
    status        ENUM('active', 'inactive') NOT NULL DEFAULT 'active', -- [MERGE ADDITION]
    reset_token   VARCHAR(64)  NULL DEFAULT NULL,
    reset_expires DATETIME     NULL DEFAULT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- =====================================================================
-- 2. ADDRESS
-- =====================================================================
CREATE TABLE Address (
    address_id   INT AUTO_INCREMENT PRIMARY KEY,
    street       VARCHAR(150) NOT NULL,
    city         VARCHAR(80) NOT NULL,
    state        VARCHAR(80),
    postal_code  VARCHAR(20)
) ENGINE=InnoDB;

-- =====================================================================
-- 3. DONOR (ISA subclass of AppUser)
-- =====================================================================
CREATE TABLE Donor (
    donor_id     INT PRIMARY KEY,
    donor_type   ENUM('individual', 'restaurant', 'grocery', 'event', 'other') DEFAULT 'individual',
    org_name     VARCHAR(150),
    address_id   INT,
    FOREIGN KEY (donor_id) REFERENCES AppUser(user_id) ON DELETE CASCADE,
    FOREIGN KEY (address_id) REFERENCES Address(address_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- =====================================================================
-- 4. VOLUNTEER (ISA subclass of AppUser)
--    [MERGE ADDITION] availability_note - free-text availability that
--    the Sufra forms collect ("Weekday evenings"); the original
--    availability ENUM is kept untouched.
-- =====================================================================
CREATE TABLE Volunteer (
    volunteer_id      INT PRIMARY KEY,
    vehicle_type      VARCHAR(50),
    availability      ENUM('available', 'busy', 'offline') DEFAULT 'available',
    availability_note VARCHAR(150) NULL DEFAULT NULL,                -- [MERGE ADDITION]
    FOREIGN KEY (volunteer_id) REFERENCES AppUser(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================================
-- 5. ADMIN (ISA subclass of AppUser)
-- =====================================================================
CREATE TABLE Admin (
    admin_id         INT PRIMARY KEY,
    permission_level ENUM('super', 'moderator', 'support') DEFAULT 'moderator',
    FOREIGN KEY (admin_id) REFERENCES AppUser(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================================
-- 6. RECIPIENT (ISA subclass of AppUser)
-- =====================================================================
CREATE TABLE Recipient (
    recipient_id    INT PRIMARY KEY,
    recipient_type  ENUM('individual', 'ngo', 'shelter', 'orphanage', 'other') DEFAULT 'individual',
    org_name        VARCHAR(150),
    FOREIGN KEY (recipient_id) REFERENCES AppUser(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================================
-- 7. FOODCATEGORY
-- =====================================================================
CREATE TABLE FoodCategory (
    category_id    INT AUTO_INCREMENT PRIMARY KEY,
    category_name  VARCHAR(80) NOT NULL UNIQUE
) ENGINE=InnoDB;

-- =====================================================================
-- 8. FOODDONATION (central entity)
--    quantity = REMAINING quantity (decreases as portions are
--    delivered; donation reopens to 'available' if quantity > 0 remains)
--    [MERGE ADDITION] status also allows 'draft' (saved, not published)
--    and 'cancelled' (donor withdrew it); plus description, prepared_at,
--    contact, notes (fields on the Sufra "Create Donation" form).
-- =====================================================================
CREATE TABLE FoodDonation (
    donation_id   INT AUTO_INCREMENT PRIMARY KEY,
    donor_id      INT NOT NULL,
    category_id   INT,
    address_id    INT,
    title         VARCHAR(150) NOT NULL,
    description   TEXT NULL,                                          -- [MERGE ADDITION]
    quantity      DECIMAL(10,2) NOT NULL,
    unit          VARCHAR(30) NOT NULL,
    prepared_at   DATETIME NULL DEFAULT NULL,                         -- [MERGE ADDITION]
    expiry_time   DATETIME NOT NULL,
    contact       VARCHAR(50) NULL DEFAULT NULL,                      -- [MERGE ADDITION]
    notes         VARCHAR(255) NULL DEFAULT NULL,                     -- [MERGE ADDITION]
    status        ENUM('available', 'requested', 'assigned', 'delivered', 'wasted', 'expired',
                       'draft', 'cancelled') DEFAULT 'available',     -- [MERGE ADDITION] draft, cancelled
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (donor_id) REFERENCES Donor(donor_id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES FoodCategory(category_id) ON DELETE SET NULL,
    FOREIGN KEY (address_id) REFERENCES Address(address_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- =====================================================================
-- 9. DONATIONIMAGE (weak entity)
-- =====================================================================
CREATE TABLE DonationImage (
    image_id     INT AUTO_INCREMENT PRIMARY KEY,
    donation_id  INT NOT NULL,
    image_url    VARCHAR(255) NOT NULL,
    FOREIGN KEY (donation_id) REFERENCES FoodDonation(donation_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================================
-- 10. REQUEST
--     A donation is locked (status='requested') as soon as one request
--     is made; rejecting a request reopens the donation.
--     [MERGE ADDITION] people_to_serve, notes, preferred_pickup
--     (fields on the Sufra "Request this food" form).
-- =====================================================================
CREATE TABLE Request (
    request_id       INT AUTO_INCREMENT PRIMARY KEY,
    recipient_id     INT NOT NULL,
    donation_id      INT NOT NULL,
    requested_qty    DECIMAL(10,2) NOT NULL,
    people_to_serve  INT NULL DEFAULT NULL,                           -- [MERGE ADDITION]
    notes            VARCHAR(255) NULL DEFAULT NULL,                  -- [MERGE ADDITION]
    preferred_pickup VARCHAR(255) NULL DEFAULT NULL,                  -- [MERGE ADDITION]
    status           ENUM('pending', 'approved', 'rejected', 'fulfilled') DEFAULT 'pending',
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recipient_id) REFERENCES Recipient(recipient_id) ON DELETE CASCADE,
    FOREIGN KEY (donation_id) REFERENCES FoodDonation(donation_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================================
-- 11. PICKUPASSIGNMENT
--     [MERGE ADDITION] status also allows 'in_transit' (the Sufra
--     pickup timeline has a separate "In transit" step).
-- =====================================================================
CREATE TABLE PickupAssignment (
    assignment_id  INT AUTO_INCREMENT PRIMARY KEY,
    volunteer_id   INT NOT NULL,
    request_id     INT NOT NULL,
    pickup_time    DATETIME,
    delivery_time  DATETIME,
    status         ENUM('assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled') DEFAULT 'assigned',
    FOREIGN KEY (volunteer_id) REFERENCES Volunteer(volunteer_id) ON DELETE CASCADE,
    FOREIGN KEY (request_id) REFERENCES Request(request_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================================
-- 12. WASTELOG (weak entity)
--     Populated either manually by a donor, or automatically when a
--     donation's expiry_time passes before it's claimed.
-- =====================================================================
CREATE TABLE WasteLog (
    waste_id         INT AUTO_INCREMENT PRIMARY KEY,
    donation_id      INT NOT NULL,
    quantity_wasted  DECIMAL(10,2) NOT NULL,
    reason           VARCHAR(255),
    logged_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (donation_id) REFERENCES FoodDonation(donation_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================================
-- 13. NOTIFICATION
-- =====================================================================
CREATE TABLE Notification (
    notification_id  INT AUTO_INCREMENT PRIMARY KEY,
    user_id          INT NOT NULL,
    donation_id      INT,
    message          VARCHAR(255) NOT NULL,
    is_read          BOOLEAN DEFAULT FALSE,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES AppUser(user_id) ON DELETE CASCADE,
    FOREIGN KEY (donation_id) REFERENCES FoodDonation(donation_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- =====================================================================
-- 14. FEEDBACK
--     Two ratings in one submission: rating/comments (the food) and
--     volunteer_rating/volunteer_comments (the delivery service).
--     request_id ties feedback to one specific request/transaction.
--     [MERGE ADDITION] UNIQUE(request_id): one feedback per request.
-- =====================================================================
CREATE TABLE Feedback (
    feedback_id         INT AUTO_INCREMENT PRIMARY KEY,
    user_id             INT NOT NULL,
    donation_id         INT NOT NULL,
    request_id          INT NULL,
    rating              TINYINT CHECK (rating BETWEEN 1 AND 5),
    comments            VARCHAR(500),
    volunteer_id        INT NULL,
    volunteer_rating    TINYINT NULL,
    volunteer_comments  VARCHAR(500) NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_feedback_request (request_id),                      -- [MERGE ADDITION]
    FOREIGN KEY (user_id) REFERENCES AppUser(user_id) ON DELETE CASCADE,
    FOREIGN KEY (donation_id) REFERENCES FoodDonation(donation_id) ON DELETE CASCADE,
    FOREIGN KEY (request_id) REFERENCES Request(request_id) ON DELETE CASCADE,
    FOREIGN KEY (volunteer_id) REFERENCES Volunteer(volunteer_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- =====================================================================
-- 15. AUDITLOG
--     [MERGE ADDITION] description - human-readable sentence shown on
--     the admin Audit Log page.
-- =====================================================================
CREATE TABLE AuditLog (
    log_id       INT AUTO_INCREMENT PRIMARY KEY,
    user_id      INT NOT NULL,
    action_type  VARCHAR(50) NOT NULL,
    target_table VARCHAR(50) NOT NULL,
    target_id    INT,
    description  VARCHAR(255) NULL DEFAULT NULL,                      -- [MERGE ADDITION]
    action_time  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES AppUser(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =====================================================================
-- INDEXES for common lookups
-- =====================================================================
CREATE INDEX idx_donation_status ON FoodDonation(status);
CREATE INDEX idx_donation_expiry ON FoodDonation(expiry_time);
CREATE INDEX idx_request_status ON Request(status);
CREATE INDEX idx_notification_user ON Notification(user_id, is_read);
CREATE INDEX idx_auditlog_user ON AuditLog(user_id);

-- =====================================================================
-- SEED DATA (demo content so every dashboard has something to show).
-- Times are relative to NOW() so the demo never looks stale.
-- =====================================================================

-- ---- Food categories (same four the frontend was designed around) ----
INSERT INTO FoodCategory (category_id, category_name) VALUES
    (1, 'Cooked Meal'), (2, 'Packaged Food'), (3, 'Produce'), (4, 'Bakery');

-- ---- Addresses ----
INSERT INTO Address (address_id, street, city) VALUES
    (1, 'House 12, Road 5, Dhanmondi', 'Dhaka'),
    (2, 'Road 9, Uttara', 'Dhaka'),
    (3, 'Sector 7, Uttara', 'Dhaka'),
    (4, 'Road 11, Gulshan', 'Dhaka'),
    (5, 'Road 27, Banani', 'Dhaka'),
    (6, 'Road 3, Mohammadpur', 'Dhaka'),
    (7, 'Road 6, Bashundhara', 'Dhaka');

-- ---- Users (all demo passwords = demo1234) ----
INSERT INTO AppUser (user_id, name, email, password, role, phone, address, status, created_at) VALUES
    (1, 'Amina Rahman',   'donor@demo.com',            '$2y$10$WBdk5yY0yWY0Ip4lIRA42O/WB9KpoTiBvoLm38DFg0WFyT42/04x.', 'donor',     '+880 1711-000111', 'House 12, Road 5, Dhanmondi, Dhaka', 'active',   NOW() - INTERVAL 100 DAY),
    (2, 'Karim Hasan',    'recipient@demo.com',        '$2y$10$WBdk5yY0yWY0Ip4lIRA42O/WB9KpoTiBvoLm38DFg0WFyT42/04x.', 'recipient', '+880 1811-222333', '45 Mirpur Road, Dhaka',              'active',   NOW() - INTERVAL 95 DAY),
    (3, 'Tanvir Alam',    'volunteer@demo.com',        '$2y$10$WBdk5yY0yWY0Ip4lIRA42O/WB9KpoTiBvoLm38DFg0WFyT42/04x.', 'volunteer', '+880 1911-444555', '22 Banani, Dhaka',                   'active',   NOW() - INTERVAL 80 DAY),
    (4, 'System Admin',   'admin@demo.com',            '$2y$10$WBdk5yY0yWY0Ip4lIRA42O/WB9KpoTiBvoLm38DFg0WFyT42/04x.', 'admin',     '+880 1611-777888', 'Sufra HQ, Gulshan, Dhaka',           'active',   NOW() - INTERVAL 120 DAY),
    (5, 'Farhan Kabir',   'farhan.kabir@example.com',  '$2y$10$WBdk5yY0yWY0Ip4lIRA42O/WB9KpoTiBvoLm38DFg0WFyT42/04x.', 'donor',     '+880 1722-333444', 'Road 9, Uttara, Dhaka',              'active',   NOW() - INTERVAL 60 DAY),
    (6, 'Nusrat Jahan',   'nusrat.jahan@example.com',  '$2y$10$WBdk5yY0yWY0Ip4lIRA42O/WB9KpoTiBvoLm38DFg0WFyT42/04x.', 'recipient', '+880 1733-555666', 'Road 2, Mohammadpur, Dhaka',         'active',   NOW() - INTERVAL 50 DAY),
    (7, 'Rafiul Islam',   'rafiul.islam@example.com',  '$2y$10$WBdk5yY0yWY0Ip4lIRA42O/WB9KpoTiBvoLm38DFg0WFyT42/04x.', 'volunteer', '+880 1744-666777', 'Road 14, Dhanmondi, Dhaka',          'inactive', NOW() - INTERVAL 40 DAY),
    (8, 'Shireen Akter',  'shireen.akter@example.com', '$2y$10$WBdk5yY0yWY0Ip4lIRA42O/WB9KpoTiBvoLm38DFg0WFyT42/04x.', 'donor',     '+880 1755-777888', 'Road 6, Bashundhara, Dhaka',         'inactive', NOW() - INTERVAL 30 DAY);

INSERT INTO Donor (donor_id, donor_type, org_name, address_id) VALUES
    (1, 'restaurant', 'Green Leaf Kitchen', 1),
    (5, 'grocery',    'Daily Fresh Mart',   2),
    (8, 'individual', NULL,                 7);

INSERT INTO Recipient (recipient_id, recipient_type, org_name) VALUES
    (2, 'ngo',     'Hope Shelter Trust'),
    (6, 'shelter', 'Shonar Bangla Kitchen');

INSERT INTO Volunteer (volunteer_id, vehicle_type, availability, availability_note) VALUES
    (3, 'Motorbike', 'available', 'Evenings & weekends'),
    (7, 'Bicycle',   'offline',   'Weekday mornings');

INSERT INTO Admin (admin_id, permission_level) VALUES (4, 'super');

-- ---- Donations ----
-- 1 pending request | 2 available (earlier request rejected) | 3 expired
-- 4 delivered       | 5-7 available                          | 8 approved, waiting for a volunteer
-- 9 expired (other donor) | 10 available (other donor)
INSERT INTO FoodDonation (donation_id, donor_id, category_id, address_id, title, description, quantity, unit, prepared_at, expiry_time, contact, status, created_at) VALUES
    (1, 1, 1, 1, 'Vegetable Biryani Trays',   'Freshly cooked vegetable biryani, prepared for a cancelled event.',                     12, 'trays',  NOW() - INTERVAL 3 HOUR,  NOW() + INTERVAL 9 HOUR,  '+880 1711-000111', 'requested', NOW() - INTERVAL 3 HOUR),
    (2, 1, 2, 1, 'Packaged Sandwiches',       'Sealed sandwich packs left over from a catering order.',                                30, 'packs',  NOW() - INTERVAL 5 HOUR,  NOW() + INTERVAL 20 HOUR, '+880 1711-000111', 'available', NOW() - INTERVAL 5 HOUR),
    (3, 1, 3, 1, 'Mixed Seasonal Produce',    'Excess vegetables from the morning market delivery.',                                   18, 'kg',     NOW() - INTERVAL 40 HOUR, NOW() - INTERVAL 20 HOUR, '+880 1711-000111', 'expired',   NOW() - INTERVAL 40 HOUR),
    (4, 1, 4, 1, 'Bread & Bakery Assortment', 'End-of-day unsold bread and pastries, still fresh.',                                    0,  'pieces', NOW() - INTERVAL 30 HOUR, NOW() - INTERVAL 12 HOUR, '+880 1711-000111', 'delivered', NOW() - INTERVAL 30 HOUR),
    (5, 1, 3, 3, 'Fresh Fruit Basket',        'Assorted seasonal fruit, slightly overripe but perfectly good to eat today.',           15, 'kg',     NOW() - INTERVAL 2 HOUR,  NOW() + INTERVAL 2 HOUR,  '+880 1711-000111', 'available', NOW() - INTERVAL 2 HOUR),
    (6, 1, 1, 4, 'Leftover Catering Curry',   'Chicken and vegetable curry from a corporate lunch event, kept warm and covered.',       8, 'trays',  NOW() - INTERVAL 1 HOUR,  NOW() + INTERVAL 10 HOUR, '+880 1711-000111', 'available', NOW() - INTERVAL 1 HOUR),
    (7, 1, 4, 5, 'Day-old Croissants & Buns', 'Unsold bakery stock from yesterday, sealed and stored overnight.',                      40, 'pieces', NOW() - INTERVAL 14 HOUR, NOW() + INTERVAL 30 HOUR, '+880 1711-000111', 'available', NOW() - INTERVAL 14 HOUR),
    (8, 1, 2, 6, 'Surplus Rice Packets',      'Sealed rice packets from an overstocked community drive.',                              20, 'packs',  NOW() - INTERVAL 6 HOUR,  NOW() + INTERVAL 6 HOUR,  '+880 1711-000111', 'assigned',  NOW() - INTERVAL 5 HOUR),
    (9, 5, 4, 2, 'Assorted Pastries',         'End-of-week unsold pastries that nobody claimed in time.',                              16, 'pieces', NOW() - INTERVAL 60 HOUR, NOW() - INTERVAL 48 HOUR, '+880 1722-333444', 'expired',   NOW() - INTERVAL 60 HOUR),
    (10,5, 3, 2, 'Fresh Vegetable Crate',     'Mixed vegetables from today''s delivery, sorted and crated.',                           25, 'kg',     NOW() - INTERVAL 1 HOUR,  NOW() + INTERVAL 14 HOUR, '+880 1722-333444', 'available', NOW() - INTERVAL 1 HOUR);

-- ---- Requests ----
INSERT INTO Request (request_id, recipient_id, donation_id, requested_qty, people_to_serve, notes, status, created_at) VALUES
    (1, 2, 1, 6,  25, 'Serving evening meal at our shelter.',   'pending',   NOW() - INTERVAL 1 HOUR),
    (2, 2, 4, 24, 20, 'Breakfast for residents.',               'fulfilled', NOW() - INTERVAL 29 HOUR),
    (3, 2, 2, 10, 10, 'Could pick up same afternoon.',          'rejected',  NOW() - INTERVAL 4 HOUR),
    (4, 2, 8, 20, 30, 'Weekly food drive at the shelter.',      'approved',  NOW() - INTERVAL 4 HOUR);

-- ---- Pickup assignment (request 2 already delivered) ----
INSERT INTO PickupAssignment (assignment_id, volunteer_id, request_id, pickup_time, delivery_time, status) VALUES
    (1, 3, 2, NOW() - INTERVAL 27 HOUR, NOW() - INTERVAL 26 HOUR, 'delivered');

-- ---- Waste log ----
INSERT INTO WasteLog (waste_id, donation_id, quantity_wasted, reason, logged_at) VALUES
    (1, 3, 18, 'Expired before pickup/request', NOW() - INTERVAL 20 HOUR),
    (2, 9, 16, 'Expired before pickup/request', NOW() - INTERVAL 48 HOUR);

-- ---- Feedback (recipient rated food + volunteer) ----
INSERT INTO Feedback (feedback_id, user_id, donation_id, request_id, rating, comments, volunteer_id, volunteer_rating, volunteer_comments, created_at) VALUES
    (1, 2, 4, 2, 5, 'Well packed and right on time. Thank you!', 3, 5, 'Polite and on time.', NOW() - INTERVAL 25 HOUR);

-- ---- Notifications ----
INSERT INTO Notification (notification_id, user_id, donation_id, message, is_read, created_at) VALUES
    (1, 1, 1, 'Someone has requested your donation "Vegetable Biryani Trays".', 0, NOW() - INTERVAL 1 HOUR),
    (2, 2, 8, 'Your request for "Surplus Rice Packets" was accepted.',          0, NOW() - INTERVAL 3 HOUR),
    (3, 2, 2, 'Your request for "Packaged Sandwiches" was declined by the donor.', 1, NOW() - INTERVAL 3 HOUR),
    (4, 1, 3, '"Mixed Seasonal Produce" expired without being claimed.',        0, NOW() - INTERVAL 20 HOUR),
    (5, 2, 4, 'Your donation "Bread & Bakery Assortment" has been delivered.',  1, NOW() - INTERVAL 26 HOUR),
    (6, 3, 4, 'Thanks for delivering "Bread & Bakery Assortment".',             1, NOW() - INTERVAL 26 HOUR),
    (7, 3, 8, 'A new pickup is waiting for a volunteer: "Surplus Rice Packets".', 0, NOW() - INTERVAL 3 HOUR);

-- ---- Audit log ----
INSERT INTO AuditLog (user_id, action_type, target_table, target_id, description, action_time) VALUES
    (2, 'INSERT', 'Request',         1, 'Requested 6 trays from "Vegetable Biryani Trays".',                 NOW() - INTERVAL 1 HOUR),
    (1, 'UPDATE', 'Request',         4, 'Accepted Hope Shelter Trust''s request for "Surplus Rice Packets".', NOW() - INTERVAL 3 HOUR),
    (1, 'UPDATE', 'Request',         3, 'Rejected Hope Shelter Trust''s request for "Packaged Sandwiches".',  NOW() - INTERVAL 3 HOUR),
    (1, 'INSERT', 'WasteLog',        1, 'System: "Mixed Seasonal Produce" expired unclaimed and was logged as waste.', NOW() - INTERVAL 20 HOUR),
    (3, 'INSERT', 'PickupAssignment',1, 'Claimed the pickup for "Bread & Bakery Assortment".',                NOW() - INTERVAL 28 HOUR),
    (3, 'UPDATE', 'PickupAssignment',1, 'Delivered "Bread & Bakery Assortment" to Hope Shelter Trust.',       NOW() - INTERVAL 26 HOUR),
    (4, 'UPDATE', 'AppUser',         7, 'Deactivated volunteer account for Rafiul Islam pending verification.', NOW() - INTERVAL 40 DAY);

-- =====================================================================
-- END OF FINAL MERGED SCHEMA + SEED DATA
-- =====================================================================
