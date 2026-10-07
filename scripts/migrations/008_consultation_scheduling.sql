-- Doctor acceptance includes choosing an exact India-time appointment.
ALTER TABLE consultations ADD COLUMN scheduled_at DATETIME NULL AFTER accepted_at;
CREATE INDEX idx_consult_scheduled ON consultations (status, scheduled_at);
