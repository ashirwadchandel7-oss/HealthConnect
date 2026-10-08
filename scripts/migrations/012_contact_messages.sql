CREATE TABLE IF NOT EXISTS contact_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  sender_role VARCHAR(24) NULL,
  sender_name VARCHAR(120) NOT NULL,
  sender_email VARCHAR(254) NOT NULL,
  sender_phone VARCHAR(32) NULL,
  category VARCHAR(40) NOT NULL,
  message TEXT NOT NULL,
  status ENUM('OPEN','IN_PROGRESS','RESOLVED') NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_contact_messages_status_created (status, created_at),
  INDEX idx_contact_messages_user_created (user_id, created_at),
  CONSTRAINT fk_contact_messages_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contact_message_evidence (
  message_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  original_name VARCHAR(180) NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  file_data MEDIUMBLOB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_contact_evidence_message FOREIGN KEY (message_id) REFERENCES contact_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
