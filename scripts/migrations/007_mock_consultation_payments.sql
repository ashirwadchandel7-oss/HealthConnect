-- Internal demo-only payment records. No external payment provider is used.
CREATE TABLE IF NOT EXISTS mock_consultation_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transaction_id VARCHAR(64) NOT NULL UNIQUE,
  consultation_id BIGINT UNSIGNED NOT NULL UNIQUE,
  patient_id BIGINT UNSIGNED NOT NULL,
  doctor_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  payment_method VARCHAR(32) NOT NULL DEFAULT 'DEMO_WALLET',
  payment_status ENUM('PENDING','SUCCESS','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_mock_tx_patient (patient_id, created_at),
  KEY idx_mock_tx_doctor (doctor_id, payment_status, created_at),
  CONSTRAINT fk_mock_tx_consultation FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE,
  CONSTRAINT fk_mock_tx_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mock_tx_doctor FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE consultations
  MODIFY payment_status ENUM('NOT_REQUIRED','PENDING','AUTHORIZED','CAPTURED','REFUND_PENDING','SETTLED','SUCCESS','FAILED','CANCELLED') NOT NULL DEFAULT 'NOT_REQUIRED';
