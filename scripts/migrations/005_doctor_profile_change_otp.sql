-- Doctor profile changes require a verified email code before entering admin review.
-- Existing account verification and password reset codes are unchanged.
ALTER TABLE email_otps MODIFY purpose ENUM('verify','reset','profile') NOT NULL;
