/* Who a name on a sheet is allowed to match to.
 *
 * This is not the same question as "who is on the board this month". The
 * calculation decides that. This decides only which people a name written in
 * Matthew's tardy log, Nicole's review log or a Connecteam export can refer to.
 *
 * Someone who gave notice still has hours, reviews and tardies belonging to the
 * month they worked, and they are still paid for it, so they have to stay
 * matchable after they leave. They were not, which is why every sync was
 * reporting "NOT MATCHED: Jeffrey Martin" and quietly dropping his September.
 *
 * They do not stay matchable for ever. Names are matched loosely — first name
 * plus last initial — so a roster that never forgets anyone would eventually
 * have two people answering to "Josh T." and the sheet would pick the wrong one.
 * So a leaver ages out: either at the start of the month being synced, or three
 * months after they left when the sync is not about one month in particular.
 */

import { query, withTransaction, hasColumn } from "./db.js";

/**
 * @param {string|null} period  the month being synced, 'YYYY-MM-01'. When given,
 *   anyone who left on or after the 1st of that month can still be matched.
 *   When omitted, anyone who left in the last three months can.
 */
export async function matchableRoster(period = null) {
  const r = await query(
    `select id, code_name, full_name from employees
      where is_mover
        and (status <> 'left'
             or ended_on >= coalesce($1::date, (current_date - interval '3 months')::date))
      order by code_name`,
    [period ?? null]);
  return r.rows;
}

/** Same normalising the name matcher uses, so the two agree on what a name is. */
export const normaliseName = s =>
  String(s ?? "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Names known to belong to nobody on the programme — usually people who left
 * before it started. They are credited nothing either way; this only keeps them
 * out of the NOT MATCHED warning, so a genuine mismatch still stands out.
 *
 * Returns a function: isIgnored("Tyler H") -> true
 */
export async function ignoredNames() {
  let rows = [];
  try {
    rows = (await query(`select name from ignored_names`)).rows;
  } catch {
    /* Deployed ahead of its migration. An empty list only means every unmatched
       name is reported, which is the old behaviour — never a reason to fail a
       sync and leave a month unbuilt. */
    return () => false;
  }
  const set = new Set(rows.map(x => x.name));
  return name => set.has(normaliseName(name));
}

/* ------------------------------------------------------- two of somebody --- */

/**
 * Who on this list might be the same person twice.
 *
 * Andrew, 21 October: "Landon has two accounts in revenue dashboard." The
 * roster has two doors into it — a job worked in SmartMoving, and a setup in
 * Connecteam — and until the SmartMoving one learned to match on a name, the
 * first job worked by anybody hired since 9 October opened a second account.
 *
 * Pure, and it decides nothing. Three keys, strongest first:
 *
 *   the same email address, which both systems agree on exactly;
 *   the same name once punctuation and case are taken out;
 *   the same first name and last initial, which is how the sheets spell people
 *     and is also how two different people collide — Jason Powell and Jason
 *     Plummer are both "Jason P".
 *
 * So the first two are stated as the same person and the third as worth
 * looking at, and a person does the merging either way. Anything already
 * merged is left out: its row exists to hold the sm_crew_id it arrived with,
 * and reporting it for ever would make this panel permanent furniture.
 */
export function likelyDuplicates(people) {
  const live = (people ?? []).filter(p => !p.merged_into);

  const emailKey = p => {
    const e = String(p.email ?? "").trim().toLowerCase();
    return e.includes("@") ? e : null;
  };
  const nameKey = p => normaliseName(p.full_name) || null;
  const looseKey = p => {
    const parts = normaliseName(p.full_name).split(" ").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1][0]}` : null;
  };

  /* Union-find, so somebody matched by email to one row and by name to another
     comes back as one group of three rather than two overlapping pairs. */
  const parent = new Map(live.map(p => [p.id, p.id]));
  const find = id => {
    while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); }
    return id;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  /* Every link that actually put two rows together, kept until the groups have
     settled: a later union can move a root, so which group a reason belongs to
     is only knowable once all of them are done.
     Strongest key first, and a key that only confirms what a stronger one
     already decided is not a link — two rows with the same name also have the
     same first name and last initial, and that must not make the pair read as
     the doubtful kind. */
  const links = [];
  for (const [kind, key] of [["email", emailKey], ["name", nameKey], ["loose", looseKey]]) {
    const seen = new Map();
    for (const p of live) {
      const k = key(p);
      if (!k) continue;
      if (!seen.has(k)) { seen.set(k, p.id); continue; }
      const other = seen.get(k);
      if (find(p.id) === find(other)) continue;
      union(p.id, other);
      links.push([p.id, kind]);
    }
  }

  const groups = new Map();
  for (const p of live) {
    const root = find(p.id);
    if (!groups.has(root)) groups.set(root, { people: [], kinds: new Set() });
    groups.get(root).people.push(p);
  }
  for (const [id, kind] of links) groups.get(find(id)).kinds.add(kind);

  const WHY = {
    email: "the same email address",
    name: "the same name",
    loose: "the same first name and last initial"
  };

  return [...groups.values()]
    .filter(g => g.people.length > 1)
    .map(g => ({
      /* Strongest reason first, and every reason named: a pile held together
         by an email AND a loose initial is not as sure as one held by the
         email alone, and the panel has to be able to say so. */
      why: ["email", "name", "loose"].filter(k => g.kinds.has(k)).map(k => WHY[k]).join(", and "),
      certain: g.kinds.size > 0 && !g.kinds.has("loose"),
      people: [...g.people].sort((a, b) =>
        String(a.code_name ?? "").localeCompare(String(b.code_name ?? "")))
    }))
    .sort((a, b) => (b.certain - a.certain) ||
      a.people[0].full_name.localeCompare(b.people[0].full_name));
}

/**
 * Fold one account into another.
 *
 * Everything a person typed moves: points, reviews, hours, bonuses and
 * deductions, sign-ins, discipline notices, and the session they may be signed
 * in with right now. Nothing is deleted, here or anywhere — the spare row stays
 * as the record of the merge, marked not a mover, which takes it off every
 * roster, out of every name match and out of the sign-in list.
 *
 * Hours for the same month are added together. Two accounts normally split the
 * months between them rather than sharing one, but when they do share one the
 * total is the honest answer and the figure is on screen to be corrected.
 *
 * Nothing about a past month is rewritten, because no past month is stored:
 * every month is computed from these rows when it is read, so a month that was
 * split across two accounts comes back whole as soon as this returns. That
 * includes months already paid, which is the point — somebody short of the
 * 100-hour gate on two half sets of hours was short by an accident of the
 * roster, not by how much they worked.
 */
export async function mergeEmployees(loserId, keeperId) {
  /* Refused rather than failed: something a person got wrong, and worth saying
     back to them in words. Anything else is a fault and is not theirs to read. */
  const refuse = msg => { const e = new Error(msg); e.refused = true; return e; };

  if (!loserId || !keeperId) throw refuse("two accounts are needed to merge");
  if (loserId === keeperId) throw refuse("that is one account, not two");

  return withTransaction(async c => {
    const r = await c.query(
      `select id, code_name, full_name, email, sm_crew_id, is_mover, merged_into
         from employees where id = any($1::uuid[]) for update`, [[loserId, keeperId]]);
    const keeper = r.rows.find(x => x.id === keeperId);
    const loser  = r.rows.find(x => x.id === loserId);
    if (!keeper || !loser) throw refuse("one of those accounts is not on the roster");
    if (keeper.merged_into) {
      throw refuse(`${keeper.code_name} has itself been merged into another account — ` +
        "keep the one that is still live");
    }

    /* A chain is nobody's intention. If something was already merged into the
       row being folded away, it follows it across. */
    const chained = await c.query(
      `update employees set merged_into = $1, updated_at = now()
        where merged_into = $2 returning code_name`, [keeperId, loserId]);

    const moved = {};
    for (const [table, label] of [
      ["point_events", "points"],
      ["adjustments", "bonuses and deductions"],
      ["sign_ins", "sign-ins"],
      ["discipline_notices", "discipline notices"],
      ["login_tokens", "sign-in links"],
      ["sessions", "open sessions"]
    ]) {
      const u = await c.query(
        `update ${table} set employee_id = $1 where employee_id = $2`, [keeperId, loserId]);
      moved[label] = u.rowCount;
    }

    /* One row per person per review, so a credit the keeper already has is
       already the same fact. */
    const rev = await c.query(
      `insert into review_credits (review_id, employee_id)
       select review_id, $1 from review_credits where employee_id = $2
       on conflict do nothing`, [keeperId, loserId]);
    await c.query(`delete from review_credits where employee_id = $1`, [loserId]);
    moved.reviews = rev.rowCount;

    const hrs = await c.query(
      `insert into hours (employee_id, period, hours, recorded_by)
       select $1, period, hours, recorded_by from hours where employee_id = $2
       on conflict (employee_id, period)
         do update set hours = hours.hours + excluded.hours, updated_at = now()
       returning period`, [keeperId, loserId]);
    await c.query(`delete from hours where employee_id = $1`, [loserId]);
    moved["months of hours"] = hrs.rowCount;

    /* The email has to leave the spare row whatever happens: it is unique, and
       a sign-in link requested with it would otherwise fetch an account with
       nothing in it. */
    const emailTaken = !keeper.email && !!loser.email;
    const emailDropped = !emailTaken && loser.email ? loser.email : null;

    /* The crew id is what SmartMoving knows this person by, and it is also what
       stops the sync enrolling them again. The keeper takes it when it has none
       of its own; when it already has one, the spare row keeps its own and goes
       on absorbing that second SmartMoving identity. */
    const crewTaken = !keeper.sm_crew_id && !!loser.sm_crew_id;

    /* The spare row gives these up before the kept one takes them: both
       columns are unique, so setting them on the keeper while the row being
       merged away still holds them is rejected outright. */
    await c.query(
      `update employees set
         is_mover    = false,
         merged_into = $2,
         email       = null,
         sm_crew_id  = case when $3 then null else sm_crew_id end,
         updated_at  = now()
       where id = $1`, [loserId, keeperId, crewTaken]);

    await c.query(
      `update employees set
         email      = case when $2 then $3 else email end,
         sm_crew_id = case when $4 then $5 else sm_crew_id end,
         updated_at = now()
       where id = $1`,
      [keeperId, emailTaken, loser.email, crewTaken, loser.sm_crew_id]);

    return {
      kept:    { id: keeper.id, code_name: keeper.code_name, full_name: keeper.full_name },
      merged:  { id: loser.id,  code_name: loser.code_name,  full_name: loser.full_name },
      moved,
      email_taken:    emailTaken ? loser.email : null,
      email_dropped:  emailDropped,
      crew_id_taken:  crewTaken ? loser.sm_crew_id : null,
      crew_id_kept:   !crewTaken && loser.sm_crew_id ? loser.sm_crew_id : null,
      also_repointed: chained.rows.map(x => x.code_name)
    };
  });
}

/**
 * Which SmartMoving crew members are already here, and which are genuinely new.
 *
 * This is the door that made two Landons. It used to ask one question — is
 * this sm_crew_id on the roster? — and somebody brought across from Connecteam
 * has no sm_crew_id at all, so their first job enrolled them a second time.
 *
 * Adoption is deliberately strict: the same name once case and punctuation are
 * out, and nothing looser. A loose match is how the hours and review logs are
 * read, and it is the right rule there, because the worst case is a figure
 * landing on the wrong row and being corrected. Here the worst case is two
 * people welded into one account with one set of pay, which is harder to
 * notice and much harder to undo. So a near miss is reported for somebody to
 * look at instead, and the duplicates panel asks the same question later
 * against the rows themselves.
 */
export async function placeCrewMembers(members) {
  const merged = await hasColumn("employees", "merged_into")
    ? "merged_into" : "null::uuid as merged_into";
  const roster = (await query(
    `select id, code_name, full_name, sm_crew_id, ${merged} from employees`)).rows;
  return placeAgainstRoster(members, roster);
}

/** The decision itself, against a roster already read. Pure, so it is tested. */
export function placeAgainstRoster(members, roster) {
  const known = new Set(roster.filter(r => r.sm_crew_id).map(r => r.sm_crew_id));
  /* An account already merged into another one must never pick up a crew id:
     it carries the same name as the account that was kept, and the jobs would
     attach to the row nobody reads instead of the person. The office can,
     which is the point of migration 004 — Matthew known and not a mover beats
     Matthew enrolled again on his next job. */
  const free  = roster.filter(r => !r.sm_crew_id && !r.merged_into);
  const byName = new Map(free.map(r => [normaliseName(r.full_name), r]));

  const initial = n => {
    const parts = normaliseName(n).split(" ").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1][0]}` : null;
  };
  const byInitial = new Map();
  for (const r of free) {
    const k = initial(r.full_name);
    if (k) byInitial.set(k, byInitial.has(k) ? null : r);    // null = two people fit
  }

  const taken = new Set();              // a name claimed earlier in this same run
  const adopt = [], add = [], maybe = [];
  let already = 0;

  for (const member of members) {
    if (known.has(member.id)) { already++; continue; }

    const exact = byName.get(normaliseName(member.name));
    if (exact && !taken.has(exact.id)) {
      taken.add(exact.id);
      adopt.push({ member, employee: exact });
      continue;
    }

    const close = byInitial.get(initial(member.name) ?? "");
    if (close && !taken.has(close.id)) {
      maybe.push(`${member.name} looks like ${close.full_name} (${close.code_name})`);
    }
    add.push(member);
  }

  return { adopt, add, maybe, already };
}
