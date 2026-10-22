/* Postgres connection. Render's external URL needs SSL; the internal one does
   not, so this only turns it on when the host is reachable from outside. */
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Minimal .env reader — no dependency, and it never logs what it read. */
export function loadEnv(file = join(root, ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) {
      process.env[k] = v.replace(/^["']|["']$/g, "");
    }
  }
}

let pool;

export function getPool() {
  if (pool) return pool;
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — copy .env.example to .env");

  const external = /\.render\.com/.test(url) && !/\.internal/.test(url);
  pool = new pg.Pool({
    connectionString: url,
    ssl: external ? { rejectUnauthorized: false } : false,
    /* This database is shared with the chatbot. Our tables live in their own
       schema; public stays untouched and visible for schema_migrations.
       Set on the startup packet so no extra round trip and no race. */
    options: "-c search_path=revenue_share,public",
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000
  });
  return pool;
}

export const query = (text, params) => getPool().query(text, params);

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function close() {
  if (pool) { await pool.end(); pool = undefined; }
}

/* Is this column here yet?
 *
 * Render deploys on a push to main and nothing runs the migrations for it —
 * `npm run migrate` is run by hand, deliberately, because this database is
 * production. So there is always a window, minutes or days wide, where the
 * code is ahead of the schema. A query naming a column that does not exist yet
 * does not degrade: Postgres rejects the whole statement, which would take out
 * the point log, somebody's report, or a sync, for a field that is optional.
 *
 * So the few queries that read a newly added column ask first. A column that
 * is there is remembered for good; one that is not is re-checked a minute
 * later, so running the migration starts working without a restart.
 */
const columnSeen = new Map();          // 'table.column' -> true | ms of last miss

export async function hasColumn(table, column) {
  const key = `${table}.${column}`;
  const seen = columnSeen.get(key);
  if (seen === true) return true;
  if (typeof seen === "number" && Date.now() - seen < 60_000) return false;
  try {
    const r = await query(
      `select 1 from information_schema.columns
        where table_schema = any (current_schemas(false))
          and table_name = $1 and column_name = $2`, [table, column]);
    const found = r.rowCount > 0;
    columnSeen.set(key, found ? true : Date.now());
    return found;
  } catch {
    /* The database being unreachable is the caller's problem to report, not
       something to answer with a guess about the schema. */
    return false;
  }
}

/**
 * The expression to read `note` off a point entry with — or a null in its place
 * while 015 has not been run. Callers name it themselves, because it is read
 * both as a column of its own and inside a concatenation.
 */
export const pointNote = async (prefix = "") =>
  (await hasColumn("point_events", "note")) ? `${prefix}note` : "null::text";

/** Host only, so we can log where we connected without leaking credentials. */
export function safeTarget() {
  loadEnv();
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}${u.pathname}`;
  } catch { return "(unparseable DATABASE_URL)"; }
}
