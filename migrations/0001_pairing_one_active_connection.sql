-- A patient may hold at most one open *or accepted* connection per doctor.
-- The original index only covered 'requested', so a patient could be
-- "accepted" by the same doctor twice, splitting the message thread.
-- (drizzle-kit push does not diff partial-index predicates, hence raw SQL.)
DROP INDEX IF EXISTS idx_pairing_requests_one_open_per_pair;
CREATE UNIQUE INDEX idx_pairing_requests_one_open_per_pair
  ON pairing_requests (patient_user_id, doctor_profile_id)
  WHERE status IN ('requested', 'accepted');
