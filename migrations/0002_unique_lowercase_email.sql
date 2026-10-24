-- Emails are compared case-insensitively everywhere, so Bob@x.com and bob@x.com
-- must not be able to exist as two accounts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
