/**
 * Operator scripts (create the administrator, retire the demo, erase a person, seed, verify) act on the
 * database as its OWNER, using DATABASE_URL. They must never pick up the restricted application role from
 * APP_DATABASE_URL: as that role, with nobody established, every protected table looks empty and every
 * write is silently ignored, so a script could print "Done" having changed nothing.
 *
 * Import this right after `dotenv/config` and before anything that loads the database module.
 */
delete process.env.APP_DATABASE_URL;
delete process.env.DB_ENFORCE_RLS;
