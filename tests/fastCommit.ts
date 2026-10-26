/** Adds `-c synchronous_commit=off` to a connection string's `options`, for test databases only. */
export function fastCommitUrl(url: string): string {
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) return url; // never touch a connection that is not a test database
  const existing = u.searchParams.get("options") ?? "";
  if (!/synchronous_commit/.test(existing)) u.searchParams.set("options", `${existing} -c synchronous_commit=off`.trim());
  return u.toString();
}
