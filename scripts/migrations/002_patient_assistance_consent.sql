-- Patients may grant a health worker a time-limited, narrow booking scope.
CREATE TABLE IF NOT EXISTS patient_assistance_consents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id BIGINT UNSIGNED NOT NULL,
  health_worker_id BIGINT UNSIGNED NOT NULL,
  purpose ENUM('doctor_search_and_booking') NOT NULL DEFAULT 'doctor_search_and_booking',
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  CONSTRAINT fk_consent_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_consent_worker FOREIGN KEY (health_worker_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_consent_worker (health_worker_id, revoked_at, expires_at),
  INDEX idx_consent_patient (patient_id, revoked_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
