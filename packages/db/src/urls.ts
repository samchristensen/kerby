/**
 * `url` (a `postgres://` URL) changed to another role, password or database of the same cluster: how a self-hosted
 * install reaches its limited roles and maintenance database from the one `DATABASE_URL` it is given (ADR 0024).
 */
export function postgresUrl(
  url: string,
  change: { role?: string; password?: string; database?: string },
): string {
  const target = new URL(url);
  if (change.role !== undefined) target.username = encodeURIComponent(change.role);
  if (change.password !== undefined) target.password = encodeURIComponent(change.password);
  if (change.database !== undefined) target.pathname = `/${encodeURIComponent(change.database)}`;
  return target.toString();
}
