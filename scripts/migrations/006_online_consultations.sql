-- Paid online consultations. This migration is additive; review before applying to a live database.
CREATE TABLE IF NOT EXISTS consultation_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  rate_per_minute DECIMAL(10,2) NOT NULL DEFAULT 5.00,
  max_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  platform_fee_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_consultation_settings_admin FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO consultation_settings (id, rate_per_minute, max_minutes, currency, platform_fee_percent, enabled)
VALUES (1, 5.00, 60, 'INR', 0.00, 1);

CREATE TABLE IF NOT EXISTS doctor_online_consult_settings (
  doctor_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_online_settings_doctor FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS doctor_online_schedule (
  doctor_id BIGINT UNSIGNED NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL,
  starts_at TIME NOT NULL DEFAULT '00:00:00',
  ends_at TIME NOT NULL DEFAULT '00:00:00',
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (doctor_id, weekday),
  CONSTRAINT fk_online_schedule_doctor FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS consultations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id CHAR(36) NOT NULL UNIQUE,
  room_name CHAR(64) NOT NULL UNIQUE,
  patient_id BIGINT UNSIGNED NOT NULL,
  doctor_id BIGINT UNSIGNED NOT NULL,
  status ENUM('REQUESTED','ACCEPTED','PAYMENT_PENDING','READY','ACTIVE','SETTLING','COMPLETED','CANCELLED','REJECTED','EXPIRED','FAILED') NOT NULL DEFAULT 'REQUESTED',
  payment_status ENUM('NOT_REQUIRED','PENDING','AUTHORIZED','CAPTURED','REFUND_PENDING','SETTLED','FAILED') NOT NULL DEFAULT 'NOT_REQUIRED',
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at DATETIME NULL,
  patient_joined_at DATETIME NULL,
  doctor_joined_at DATETIME NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  patient_disconnected_at DATETIME NULL,
  doctor_disconnected_at DATETIME NULL,
  actual_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  billing_minutes INT UNSIGNED NOT NULL DEFAULT 0,
  rate_per_minute DECIMAL(10,2) NOT NULL,
  max_minutes SMALLINT UNSIGNED NOT NULL,
  authorization_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  platform_fee_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  doctor_earning_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  ended_by BIGINT UNSIGNED NULL,
  failure_reason VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_consult_patient (patient_id, requested_at),
  KEY idx_consult_doctor (doctor_id, status, requested_at),
  KEY idx_consult_state (status, started_at),
  CONSTRAINT fk_consult_patient FOREIGN KEY (patient_id) REFERENCES users(id),
  CONSTRAINT fk_consult_doctor FOREIGN KEY (doctor_id) REFERENCES users(id),
  CONSTRAINT fk_consult_ended_by FOREIGN KEY (ended_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS consultation_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  consultation_id BIGINT UNSIGNED NOT NULL,
  gateway VARCHAR(32) NOT NULL DEFAULT 'razorpay',
  gateway_order_id VARCHAR(100) NULL UNIQUE,
  gateway_payment_id VARCHAR(100) NULL UNIQUE,
  gateway_refund_id VARCHAR(100) NULL,
  amount_paise BIGINT UNSIGNED NOT NULL,
  captured_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  refund_paise BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('CREATED','AUTHORIZED','CAPTURED','REFUND_PENDING','REFUNDED','FAILED') NOT NULL DEFAULT 'CREATED',
  checkout_signature_verified TINYINT(1) NOT NULL DEFAULT 0,
  webhook_event_id VARCHAR(120) NULL UNIQUE,
  failure_reason VARCHAR(500) NULL,
  gateway_response_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_consult_payment_once (consultation_id),
  CONSTRAINT fk_consult_payment FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS consultation_audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  consultation_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(80) NOT NULL,
  details_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_consult_audit (consultation_id, created_at),
  CONSTRAINT fk_consult_audit_consult FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE,
  CONSTRAINT fk_consult_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
