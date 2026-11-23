const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFormat = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export const formatDate = (iso: string): string => dateFormat.format(new Date(iso));

export const formatDateTime = (iso: string): string =>
  `${dateTimeFormat.format(new Date(iso))} UTC`;

/** Binary units, as the limits are written (`storageBytes` defaults to 1 GiB). */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The curl quickstart, against the tenant API at `apiUrl`. */
export const quickstart = (apiUrl: string): string =>
  `# Start a conversation
curl -X POST ${apiUrl}/v1/conversations \\
  -H "Authorization: Bearer $KERBY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "anthropic/<model-id>"}'

# Send a message
curl -X POST ${apiUrl}/v1/conversations/<id>/messages \\
  -H "Authorization: Bearer $KERBY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "Hello"}'

# Stream the reply
curl -N ${apiUrl}/v1/conversations/<id>/events \\
  -H "Authorization: Bearer $KERBY_API_KEY"`;
