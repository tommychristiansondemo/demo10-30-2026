/**
 * Defense-in-depth validation for model-generated and user-supplied SQL.
 * The real security boundary is IAM (the Lambda can only read the GridSight Glue database and
 * lake bucket) plus the Athena workgroup's bytes-scanned cutoff; this guard keeps queries
 * read-only, single-statement, scoped to known tables, and bounded in size.
 */
export class SqlRejected extends Error {}

const FORBIDDEN =
  /\b(insert|update|delete|merge|drop|create|alter|grant|revoke|unload|msck|call|execute|prepare|deallocate|vacuum|optimize|show|describe|set|reset|use|commit|rollback|truncate|information_schema)\b/i;

export function guardSql(input: string, allowedTables: string[], maxRows = 1000, database?: string): string {
  let sql = input.trim().replace(/;+\s*$/, '');
  if (!sql) throw new SqlRejected('Empty query');
  if (sql.length > 8000) throw new SqlRejected('Query too long (max 8000 characters)');
  if (sql.includes(';')) throw new SqlRejected('Only a single statement is allowed');
  if (/--|\/\*/.test(sql)) throw new SqlRejected('SQL comments are not allowed');
  if (!/^(select|with)\b/i.test(sql)) throw new SqlRejected('Only SELECT queries are allowed');
  const forbidden = sql.replace(/'(?:[^']|'')*'/g, "''").match(FORBIDDEN);
  if (forbidden) throw new SqlRejected(`Keyword not allowed: ${forbidden[1].toUpperCase()}`);

  const ctes = new Set([...sql.matchAll(/(?:with|,)\s*([a-zA-Z_][\w]*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const allowed = new Set(allowedTables.map((t) => t.toLowerCase()));
  for (const m of sql.matchAll(/\b(?:from|join)\s+([a-zA-Z_"][\w."]*)/gi)) {
    const ref = m[1].replace(/"/g, '').toLowerCase();
    const parts = ref.split('.');
    const table = parts[parts.length - 1];
    if (parts.length > 2) throw new SqlRejected(`Cross-catalog reference not allowed: ${ref}`);
    if (parts.length === 2 && database && parts[0] !== database.toLowerCase()) throw new SqlRejected(`Database not allowed: ${parts[0]}`);
    if (!allowed.has(table) && !ctes.has(table)) throw new SqlRejected(`Unknown table: ${table}. Allowed: ${allowedTables.join(', ')}`);
  }

  const limit = sql.match(/\blimit\s+(\d+)\s*$/i);
  if (limit) {
    if (Number(limit[1]) > maxRows) sql = sql.replace(/\blimit\s+\d+\s*$/i, `LIMIT ${maxRows}`);
  } else {
    sql = `${sql}\nLIMIT ${maxRows}`;
  }
  return sql;
}
