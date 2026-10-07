-- Base schema for a new HealthConnect Bharat installation.
-- Existing databases are preserved; run versioned scripts/migrations afterwards.
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  phone VARCHAR(30) NOT NULL,
  role ENUM('patient','doctor','hospital','health_worker','admin') NOT NULL DEFAULT 'patient',
  organization VARCHAR(180) NULL,
  specialization VARCHAR(120) NULL,
  qualification VARCHAR(180) NULL,
  registration_number VARCHAR(100) NULL,
  city VARCHAR(100) NULL,
  password_hash VARCHAR(255) NOT NULL,
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  verified_at DATETIME NULL,
  account_status ENUM('active','pending','suspended') NOT NULL DEFAULT 'active',
  consultation_fee DECIMAL(10,2) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_directory (role,account_status,email_verified,city),
  INDEX idx_users_specialty (specialization)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_otps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  purpose ENUM('verify','reset') NOT NULL,
  code_hash CHAR(64) NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  INDEX idx_otp_lookup (email,purpose,created_at),
  INDEX idx_otp_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
