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

/** Host only, so we can log where we connected without leaking credentials. */
export function safeTarget() {
  loadEnv();
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}${u.pathname}`;
  } catch { return "(unparseable DATABASE_URL)"; }
}
