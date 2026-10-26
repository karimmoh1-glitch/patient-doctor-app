-- Video visits are not offered (there is no video provider), so a row created without a type must not claim to be one.
ALTER TABLE appointments ALTER COLUMN type SET DEFAULT 'Phone Call';
