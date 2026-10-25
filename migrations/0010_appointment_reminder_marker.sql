-- Marks that the "your visit is coming up" notice has been sent for an
-- appointment, so the scheduler can run as often as it likes without repeating it.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at timestamp;
