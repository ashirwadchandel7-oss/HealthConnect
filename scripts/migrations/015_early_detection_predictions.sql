CREATE TABLE IF NOT EXISTS early_detection_predictions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  patient_id BIGINT UNSIGNED NOT NULL,
  condition_key ENUM('parkinson','brain_tumor','alzheimer') NOT NULL,
  predicted_class VARCHAR(160) NOT NULL,
  confidence DECIMAL(7,6) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_early_detection_patient FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_early_detection_patient (patient_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
