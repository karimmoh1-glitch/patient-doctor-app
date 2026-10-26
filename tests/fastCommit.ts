/** Adds `-c synchronous_commit=off` to a connection string's `options`, for test databases only. */
export function fastCommitUrl(url: string): string {
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) return url; // never touch a connection that is not a test database
  const existing = u.searchParams.get("options") ?? "";
  if (!/synchronous_commit/.test(existing)) u.searchParams.set("options", `${existing} -c synchronous_commit=off`.trim());
  return u.toString();
}

/**
 * The same test database, as the restricted runtime role (avela_app) the application is meant to use in
 * production: no ownership, no DDL, subject to row-level security. Only for a database ending in `_test`.
 */
export function appRoleUrl(url: string): string {
  const u = new URL(fastCommitUrl(url));
  if (!u.pathname.replace(/^\//, "").endsWith("_test")) return url;
  const existing = u.searchParams.get("options") ?? "";
  if (!/\brole=/.test(existing)) u.searchParams.set("options", `${existing} -c role=avela_app`.trim());
  return u.toString();
}
