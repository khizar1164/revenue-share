/* Apply db/*.sql in order, once each. Safe to re-run. */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { query, withTransaction, close, safeTarget } from "../src/db.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "db");

console.log("connecting to", safeTarget());

/* Always schema-qualify this one. The connection's search_path puts
   revenue_share first, so an unqualified CREATE would make a second, empty
   ledger there and every migration would look unapplied. */
await query(`create schema if not exists revenue_share`);
await query(`
  create table if not exists revenue_share.schema_migrations (
    name       text primary key,
    applied_at timestamptz not null default now()
  )
`);

/* carry over anything recorded before the schema move */
await query(`
  insert into revenue_share.schema_migrations (name, applied_at)
  select name, applied_at from public.schema_migrations
   where to_regclass('public.schema_migrations') is not null
  on conflict (name) do nothing
`);

const done = new Set(
  (await query("select name from revenue_share.schema_migrations")).rows.map(r => r.name));
const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();

let applied = 0;
for (const f of files) {
  if (done.has(f)) { console.log(`  = ${f} (already applied)`); continue; }
  const sql = readFileSync(join(dir, f), "utf8");
  process.stdout.write(`  + ${f} … `);
  try {
    await withTransaction(async c => {
      await c.query(sql);
      await c.query("insert into revenue_share.schema_migrations (name) values ($1)", [f]);
    });
    console.log("ok");
    applied++;
  } catch (e) {
    console.log("FAILED");
    console.error("\n" + e.message);
    await close();
    process.exit(1);
  }
}

const tables = await query(`
  select table_name, (select count(*) from information_schema.columns c
                      where c.table_name = t.table_name and c.table_schema = t.table_schema) as cols
  from information_schema.tables t
  where table_schema = 'revenue_share' and table_type = 'BASE TABLE'
  order by table_name
`);

console.log(`\n${applied} migration(s) applied. ${tables.rowCount} tables:\n`);
for (const r of tables.rows) console.log(`  ${r.table_name.padEnd(22)} ${r.cols} columns`);

await close();
