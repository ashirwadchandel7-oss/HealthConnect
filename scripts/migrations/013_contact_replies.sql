CREATE TABLE IF NOT EXISTS contact_message_replies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT UNSIGNED NOT NULL,
  admin_user_id BIGINT UNSIGNED NULL,
  reply_text TEXT NOT NULL,
  delivery_status ENUM('PENDING','SENT','FAILED') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_contact_replies_message_created (message_id, created_at),
  CONSTRAINT fk_contact_replies_message FOREIGN KEY (message_id) REFERENCES contact_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_contact_replies_admin FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
