-- Scheduling foundation: doctor time zone, published weekly availability,
-- and a DB-level guard against two live appointments starting at the same
-- instant for one doctor. Idempotent so it is safe on databases that were
-- created from the current schema with `drizzle-kit push`.
ALTER TABLE doctor_profiles ADD COLUMN IF NOT EXISTS timezone varchar NOT NULL DEFAULT 'America/New_York';

CREATE TABLE IF NOT EXISTS doctor_availability (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  doctor_profile_id varchar NOT NULL REFERENCES doctor_profiles(id),
  weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CONSTRAINT availability_window_order CHECK (start_minute < end_minute)
);
CREATE INDEX IF NOT EXISTS idx_doctor_availability_doctor ON doctor_availability (doctor_profile_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_doctor_start_live
  ON appointments (doctor_profile_id, scheduled_at)
  WHERE status IN ('requested', 'confirmed');
