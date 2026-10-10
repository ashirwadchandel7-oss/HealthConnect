ALTER TABLE consultations
  ADD COLUMN payment_method VARCHAR(16) NULL,
  ADD COLUMN payment_proof_mime VARCHAR(32) NULL,
  ADD COLUMN payment_proof MEDIUMBLOB NULL,
  ADD COLUMN payment_proof_status ENUM('PENDING','APPROVED','REJECTED') NULL;
