// Ids are uuid columns, compared as uuid (`id = $1`) so the index serves the lookup. Cast to text, the column matches no
// index and every call scans the whole table (rule `queries`). A value that is not a uuid would make Postgres throw,
// so a lookup checks it first and treats it as not found.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` can be compared with a uuid column; anything else names no row. */
export const isUuid = (value: string): boolean => UUID.test(value);
