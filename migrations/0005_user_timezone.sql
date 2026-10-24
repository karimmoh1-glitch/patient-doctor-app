-- The patient's own time zone, learned from their browser. Dose times are
-- wall-clock ("20:00"), so "today" must be computed in this zone, not UTC.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone varchar;
