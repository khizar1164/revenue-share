/* New movers arrive from Connecteam, not from their first job.
 *
 * Andrew, 9 October: "can you automate when mover is added to connecteam they
 * get added to revenue dashboard?"
 *
 * Until now the roster followed SmartMoving: working a job is what made
 * somebody a mover. That is a sound rule and it is always late. Somebody hired
 * on the Monday does not exist here until their first job lands in a sync,
 * which means their first days have nowhere to record a tardy and nobody can
 * see them on the board. With SmartMoving going away it stops working at all.
 *
 * Connecteam knows about somebody the day they are set up, so it knows first.
 *
 * WHO COUNTS AS A MOVER
 *
 * Connecteam builds a group per department, and this company's movers are the
 * Operations department. Every one of the fifteen already on the dashboard is
 * in it; the office — sales, accounting, customer service — is not. So the
 * rule is a department Andrew already maintains in Connecteam for his own
 * reasons, rather than a list in here that would drift the first time somebody
 * was hired.
 *
 * The group is looked up by name every run. If it is renamed or removed this
 * stops and says so, rather than finding no group, adding everybody, and
 * putting the receptionist on the revenue share.
 *
 * MATCHING, WHICH IS THE WHOLE DIFFICULTY
 *
 * Email first. It is the only thing both systems agree on exactly, and it is
 * what already quietly matches "Joshua Trim" in Connecteam to "Josh Trim"
 * here. Then a normalised name, because some people have no email at all in
 * Connecteam. Only when both miss is somebody new.
 *
 * It never removes anyone. Somebody leaving is a decision with money attached —
 * notice or no notice changes whether they are paid — and it is made in the
 * admin panel by a person.
 */
import { query } from "../db.js";
import { listUsers, configured, status as ctStatus } from "../connecteam.js";

const DEPARTMENT = process.env.CONNECTEAM_CREW_GROUP || "Operations";

/* Shared with the SmartMoving roster so the two never collide on a name. */
const NAME_POOL = ["RANGER","JAGUAR","LYNX","BEAR","BISON","RHINO","WOLF","OTTER",
  "FALCON","HERON","BADGER","MARTEN","STOAT","OSPREY","KESTREL","RAVEN","HAWK",
  "EAGLE","PUMA","TIGER","COBRA","VIPER","MAMBA","DINGO","JACKAL","CARIBOU",
  "MOOSE","ELK","STAG","BOAR"];

/** Lowercase, no punctuation, single spaces — enough to match a roster by hand. */
export const normName = n => String(n ?? "")
  .toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

async function crewGroupId(fetchImpl) {
  const r = await (fetchImpl ?? globalThis.fetch)(
    `${(process.env.CONNECTEAM_BASE || "https://api.connecteam.com").replace(/\/+$/, "")}/users/v1/smart-groups`,
    { headers: { "X-API-KEY": (process.env.CONNECTEAM_API_KEY || "").trim(), Accept: "application/json" } });
  if (!r.ok) throw new Error(`Connecteam smart-groups → ${r.status}`);
  const groups = (await r.json())?.data?.groups ?? [];
  const want = DEPARTMENT.trim().toLowerCase();
  const found = groups.find(g => String(g.name ?? "").trim().toLowerCase() === want);
  if (!found) {
    throw new Error(`no Connecteam group called "${DEPARTMENT}" — ` +
      `found ${groups.map(g => g.name).join(", ").slice(0, 160)}`);
  }
  return found.id;
}

/**
 * Bring anybody new across.
 *
 *   dryRun   work out who would be added, add nobody
 */
export async function syncCrew({ dryRun = false, fetchImpl } = {}) {
  if (!configured()) return `not configured — ${ctStatus()}`;

  const groupId = await crewGroupId(fetchImpl);
  const everyone = await listUsers({ fetchImpl });
  const crew = everyone.filter(u =>
    u.userType === "user" && !u.isArchived && (u.smartGroupsIds ?? []).includes(groupId));

  const roster = (await query(
    `select id, full_name, lower(coalesce(email,'')) as email from employees`)).rows;
  const byEmail = new Map(roster.filter(r => r.email).map(r => [r.email, r]));
  const byName = new Map(roster.map(r => [normName(r.full_name), r]));

  const added = [], skipped = [];
  for (const u of crew) {
    const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
    if (!name) { skipped.push("a Connecteam user with no name"); continue; }

    const email = (u.email ?? "").trim().toLowerCase();
    if ((email && byEmail.has(email)) || byName.has(normName(name))) continue;

    if (dryRun) { added.push(name); continue; }

    const taken = new Set((await query(`select code_name from employees`)).rows.map(r => r.code_name));
    const code = NAME_POOL.find(n => !taken.has(n)) ?? `CREW${taken.size + 1}`;
    const ins = await query(
      `insert into employees (code_name, full_name, email, status, is_mover)
       values ($1, $2, nullif($3, ''), 'active', true)
       returning id`, [code, name, email]);

    /* So the new row matches the one just inserted and a second person in the
       same run cannot be given the same code or be added twice. */
    byName.set(normName(name), { id: ins.rows[0].id });
    if (email) byEmail.set(email, { id: ins.rows[0].id });
    added.push(`${name} as ${code}`);
  }

  const parts = [`${crew.length} in ${DEPARTMENT}`];
  parts.push(added.length ? `added ${added.join(", ")}` : "nobody new");
  if (skipped.length) parts.push(`skipped ${skipped.length}`);
  if (dryRun) parts.push("(dry run — nothing written)");
  return parts.join(" · ");
}
