/**
 * Development and test fixtures only. The authenticator secret shared by every FIXTURE clinician and administrator, so the
 * automated tests can answer the second factor. It is public (it is in the repository), which is exactly why a production
 * server refuses every account marked as a fixture and why this secret protects nothing real.
 */
export const FIXTURE_MFA_SECRET = "JBSWY3DPEHPK3PXP";
