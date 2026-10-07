-- Add doctor-owned UPI display details for mock appointment payment flow.
ALTER TABLE appointments
  MODIFY payment_method ENUM('CASH','RAZORPAY','UPI') NOT NULL DEFAULT 'CASH';
ALTER TABLE appointments
  ADD COLUMN mock_payment_reference VARCHAR(64) NULL AFTER razorpay_payment_id;
ALTER TABLE appointments
  ADD UNIQUE KEY uq_appointment_mock_payment_reference (mock_payment_reference);

CREATE TABLE IF NOT EXISTS doctor_payment_profiles (
  doctor_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  upi_id VARCHAR(120) NOT NULL,
  qr_image_url VARCHAR(255) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_doctor_payment_profiles_user
    FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
