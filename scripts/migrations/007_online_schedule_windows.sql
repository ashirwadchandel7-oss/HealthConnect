ALTER TABLE doctor_online_schedule
  ADD COLUMN second_starts_at TIME NULL AFTER ends_at;

ALTER TABLE doctor_online_schedule
  ADD COLUMN second_ends_at TIME NULL AFTER second_starts_at;
