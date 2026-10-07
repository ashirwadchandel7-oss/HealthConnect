-- Additive workflow schema for existing HealthConnect Bharat MySQL/TiDB installs.
-- No existing user data is deleted or rewritten.
ALTER TABLE users MODIFY role ENUM('patient','doctor','hospital','health_worker','admin') NOT NULL;

CREATE TABLE IF NOT EXISTS provider_profiles (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  registration_authority VARCHAR(180) NULL,
  years_experience SMALLINT UNSIGNED NULL,
  practice_address VARCHAR(500) NULL,
  state VARCHAR(100) NULL,
  postal_code VARCHAR(20) NULL,
  public_phone TINYINT(1) NOT NULL DEFAULT 0,
  verification_status ENUM('PENDING','UNDER_REVIEW','VERIFIED','REJECTED','NEEDS_CORRECTION') NOT NULL DEFAULT 'PENDING',
  review_reason VARCHAR(1000) NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_provider_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_provider_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_provider_review (verification_status, submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hospitals (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  registered_name VARCHAR(180) NOT NULL,
  licence_number VARCHAR(120) NULL,
  address VARCHAR(500) NOT NULL,
  state VARCHAR(100) NULL,
  postal_code VARCHAR(20) NULL,
  departments TEXT NULL,
  services TEXT NULL,
  facilities TEXT NULL,
  accessibility TEXT NULL,
  representative_name VARCHAR(120) NULL,
  public_description VARCHAR(1000) NULL,
  CONSTRAINT fk_hospital_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_hospital_directory (state, postal_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Existing professional accounts become pending review; they are not silently treated as verified.
INSERT INTO provider_profiles (user_id,verification_status)
SELECT id,'PENDING' FROM users WHERE role IN ('doctor','hospital','health_worker')
ON DUPLICATE KEY UPDATE user_id=VALUES(user_id);

INSERT INTO hospitals (user_id,registered_name,address)
SELECT id,COALESCE(NULLIF(organization,''),name),COALESCE(NULLIF(city,''),'Address details required')
FROM users WHERE role='hospital'
ON DUPLICATE KEY UPDATE user_id=VALUES(user_id);

CREATE TABLE IF NOT EXISTS provider_reviews (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider_user_id BIGINT UNSIGNED NOT NULL,
  reviewer_id BIGINT UNSIGNED NOT NULL,
  old_status VARCHAR(30) NOT NULL,
  new_status ENUM('PENDING','UNDER_REVIEW','VERIFIED','REJECTED','NEEDS_CORRECTION') NOT NULL,
  reason VARCHAR(1000) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_review_provider FOREIGN KEY (provider_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_review_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id),
  INDEX idx_provider_history (provider_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS doctor_availability (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  doctor_id BIGINT UNSIGNED NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  consultation_type ENUM('in_person','online') NOT NULL,
  location VARCHAR(300) NULL,
  slot_status ENUM('AVAILABLE','BLOCKED') NOT NULL DEFAULT 'AVAILABLE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_availability_doctor FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_doctor_slot_start (doctor_id, starts_at),
  INDEX idx_availability_search (doctor_id, slot_status, starts_at, ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appointments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  booking_reference CHAR(12) NOT NULL UNIQUE,
  patient_id BIGINT UNSIGNED NOT NULL,
  doctor_id BIGINT UNSIGNED NOT NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  availability_id BIGINT UNSIGNED NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  consultation_type ENUM('in_person','online') NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status ENUM('BOOKED','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW','REJECTED') NOT NULL DEFAULT 'BOOKED',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_appointment_patient FOREIGN KEY (patient_id) REFERENCES users(id),
  CONSTRAINT fk_appointment_doctor FOREIGN KEY (doctor_id) REFERENCES users(id),
  CONSTRAINT fk_appointment_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  CONSTRAINT fk_appointment_slot FOREIGN KEY (availability_id) REFERENCES doctor_availability(id) ON DELETE SET NULL,
  INDEX idx_appointment_patient (patient_id, starts_at),
  INDEX idx_appointment_doctor (doctor_id, starts_at),
  INDEX idx_appointment_overlap (doctor_id, status, starts_at, ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS medical_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id BIGINT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  appointment_id BIGINT UNSIGNED NULL,
  title VARCHAR(180) NOT NULL,
  notes TEXT NULL,
  private_file_key VARCHAR(500) NULL,
  mime_type VARCHAR(120) NULL,
  file_size BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_record_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_record_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_record_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
  INDEX idx_patient_records (patient_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS prescriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id BIGINT UNSIGNED NOT NULL,
  doctor_id BIGINT UNSIGNED NOT NULL,
  appointment_id BIGINT UNSIGNED NULL,
  prescription_text MEDIUMTEXT NOT NULL,
  amended_from BIGINT UNSIGNED NULL,
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_prescription_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_prescription_doctor FOREIGN KEY (doctor_id) REFERENCES users(id),
  CONSTRAINT fk_prescription_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL,
  CONSTRAINT fk_prescription_amendment FOREIGN KEY (amended_from) REFERENCES prescriptions(id) ON DELETE SET NULL,
  INDEX idx_patient_prescriptions (patient_id, issued_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  category VARCHAR(40) NOT NULL,
  title VARCHAR(180) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notification_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_notifications (user_id, read_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  details_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_audit_search (action, entity_type, created_at),
  INDEX idx_audit_actor (actor_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

