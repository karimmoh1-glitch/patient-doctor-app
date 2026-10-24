-- One pharmacy order per prescription, enforced by the database. The route
-- already checked first, but two near-simultaneous requests could both pass
-- that check.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pharmacy_orders_one_per_prescription ON pharmacy_orders (prescription_id);
