/* Exercise the admin flows against the live database, then put everything back.
   The hours paste is the one worth testing hardest: Matthew's export spells
   names its own way, and a name that silently fails to match means someone
   quietly doesn't get paid. */
import { query, close } from "../src/db.js";

const BASE = "http://localhost:3000";
const PERIOD = "2026-09-01";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const api = async (path, opts) => {
  const r = await fetch(BASE + path, {
    headers: { "content-type": "application/json" }, ...opts });
  if (r.status === 204) return null;
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error((b && b.error) || `HTTP ${r.status}`);
  return b;
};

const created = { reviews: [], claims: [], adjustments: [], points: [] };

try {
  console.log("\n1. PAGES");
  for (const [label, path] of [["admin", "/admin"], ["tv", "/tv/immediate-movers-break-room"]]) {
    const r = await fetch(BASE + path);
    check(`${label} page loads`, r.ok);
  }

  const roster = await api("/api/admin/roster");
  console.log(`\n2. HOURS PASTE  (roster of ${roster.length})`);
  {
    /* deliberately awkward: tabs, double spaces, a nickname, a middle initial,
       a trailing title, and one person who simply is not on the roster */
    const paste = [
      { name: roster[0].full_name,                    hours: 82 },       // exact
      { name: roster[1].full_name.toUpperCase(),      hours: 91.5 },     // shouting
      { name: roster[2].full_name.split(" ")[0] + " " +
              roster[2].full_name.split(" ")[1][0],   hours: 64 },       // first + initial
      { name: "  " + roster[3].full_name + "  ",      hours: 77.25 },    // whitespace
      { name: "Nobody McGhost",                       hours: 40 }        // not one of ours
    ];
    const r = await api("/api/admin/hours/bulk", {
      method: "PUT", body: JSON.stringify({ period: PERIOD, rows: paste }) });

    check("exact name matched", r.saved.some(s => s.full_name === roster[0].full_name));
    check("upper-case name matched", r.saved.some(s => s.full_name === roster[1].full_name));
    check("first name + last initial matched", r.saved.some(s => s.full_name === roster[2].full_name),
      roster[2].full_name.split(" ")[0] + " " + roster[2].full_name.split(" ")[1][0]);
    check("surrounding whitespace ignored", r.saved.some(s => s.full_name === roster[3].full_name));
    check("an unknown name is reported, not dropped silently",
      r.unmatched.length === 1 && r.unmatched[0].name === "Nobody McGhost");
    check("four saved", r.saved.length === 4, r.saved.map(s => s.code_name).join(", "));
  }

  console.log("\n3. THE GATE ACTUALLY GATES");
  {
    const s = await api("/api/admin/summary?month=2026-09");
    const over = s.rows.filter(p => p.hours >= 75);
    const under = s.rows.filter(p => p.hours > 0 && p.hours < 75);
    check("someone at 82 hours qualifies", over.length >= 1, `${over.length} over 75`);
    check("someone at 64 hours does not", under.every(p => !p.paid), `${under.length} under 75`);
    check("qualified count matches", s.counts.qualified === over.length);
    check("only people with hours are paid", s.rows.every(p => p.paid ? p.hours >= 75 : true));
  }

  console.log("\n4. WAIVING THE GATE");
  {
    await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({
      period: PERIOD, hours_gate_waived: true, note: "admin-check" }) });
    const s = await api("/api/admin/summary?month=2026-09");
    check("everyone on the roster now shares", s.counts.qualified === s.counts.roster,
      `${s.counts.qualified} of ${s.counts.roster}`);
    check("the flag is reported back", s.hours_gate_waived === true);
    const sum = s.rows.reduce((a, p) => a + p.share, 0);
    check("paid + unallocated equals the pool", Math.abs(sum + s.unallocated - s.pool) < 0.05,
      `paid ${sum.toFixed(2)} + unallocated ${s.unallocated.toFixed(2)} vs pool ${s.pool.toFixed(2)}`);

    await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({
      period: PERIOD, hours_gate_waived: false, note: null }) });
    const back = await api("/api/admin/summary?month=2026-09");
    check("turning it off restores the gate", back.hours_gate_waived === false);
  }

  console.log("\n5. CLAIMS, BONUSES, POINTS");
  {
    const who = roster[0].id;
    const c = await api("/api/admin/claims", { method: "POST", body: JSON.stringify({
      occurred_on: "2026-09-05", job_number: "TEST-1", reason: "admin-check", amount: 25 }) });
    created.claims.push(c.id);
    const b = await api("/api/admin/adjustments", { method: "POST", body: JSON.stringify({
      employee_id: who, occurred_on: "2026-09-05", kind: "bonus",
      reason: "admin-check bonus", amount: 100 }) });
    created.adjustments.push(b.id);
    const d = await api("/api/admin/adjustments", { method: "POST", body: JSON.stringify({
      employee_id: who, occurred_on: "2026-09-05", kind: "deduction",
      reason: "admin-check deduction", amount: 30 }) });
    created.adjustments.push(d.id);
    const p = await api("/api/admin/points", { method: "POST", body: JSON.stringify({
      employee_id: who, occurred_on: "2026-09-05", delta: -2, reason: "Call off" }) });
    created.points.push(p.id);

    const s = await api("/api/admin/summary?month=2026-09");
    const me = s.rows.find(r => r.employee_id === who);
    check("claim came off the pool", s.claims_total === 25, `${s.claims_total}`);
    check("bonus and deduction land on take-home",
      Math.abs(me.take_home - (me.share + 100 - 30)) < 0.02,
      `share $${me.share} → take-home $${me.take_home}`);
    check("neither touches the shared pool",
      Math.abs(s.rows.reduce((a, r) => a + r.share, 0) + s.unallocated - s.pool) < 0.05);
    check("point deduction registered", me.points === 13 || me.points < 15, `${me.points} points`);
  }

  console.log("\n6. FORFEIT FROM THE ROSTER SCREEN");
  {
    const s0 = await api("/api/admin/summary?month=2026-09");
    const target = s0.rows.find(p => p.paid);
    if (!target) { check("a paid mover exists to test with", false); }
    else {
      const before = s0.rows.filter(p => p.paid && p.employee_id !== target.employee_id)
        .reduce((a, p) => a + p.share, 0);

      await api(`/api/admin/employee/${target.employee_id}`, {
        method: "PATCH", body: JSON.stringify({ status: "no_notice" }) });
      const s1 = await api("/api/admin/summary?month=2026-09");
      const gone = s1.rows.find(p => p.employee_id === target.employee_id);
      const after = s1.rows.filter(p => p.paid).reduce((a, p) => a + p.share, 0);

      check("they stop being paid", gone.share === 0);
      check("a forfeited figure appears", gone.forfeited > 0, `$${gone.forfeited.toFixed(2)}`);
      check("everyone else absorbs it", after > before - 0.01,
        `$${before.toFixed(2)} → $${after.toFixed(2)}`);
      check("paid + unallocated equals the pool", Math.abs(after + s1.unallocated - s1.pool) < 0.05);

      await api(`/api/admin/employee/${target.employee_id}`, {
        method: "PATCH", body: JSON.stringify({ status: "active" }) });
      const s2 = await api("/api/admin/summary?month=2026-09");
      check("setting them back restores the split", s2.forfeited === 0);
    }
  }

  console.log("\n7. WEEKLY HOURS ADD UP");
  {
    const who = roster[0];
    await api("/api/admin/hours", { method: "PUT", body: JSON.stringify({
      employee_id: who.id, period: PERIOD, hours: 40 }) });
    await api("/api/admin/hours/bulk", { method: "PUT", body: JSON.stringify({
      period: PERIOD, rows: [{ name: who.full_name, hours: 35 }], add: true }) });
    const s = await api("/api/admin/summary?month=2026-09");
    const me = s.rows.find(r => r.employee_id === who.id);
    check("a second week adds rather than replaces", me.hours === 75, `${me.hours} hours`);

    await api("/api/admin/hours/bulk", { method: "PUT", body: JSON.stringify({
      period: PERIOD, rows: [{ name: who.full_name, hours: 82 }] }) });
    const s2 = await api("/api/admin/summary?month=2026-09");
    check("without the flag it replaces",
      s2.rows.find(r => r.employee_id === who.id).hours === 82);
  }

  console.log("\n" + "=".repeat(58));
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
  console.log("=".repeat(58));
} catch (e) {
  console.error("\nERRORED:", e.message);
  failures++;
} finally {
  /* leave the database as we found it */
  for (const id of created.claims)      await query(`delete from claims where id = $1`, [id]);
  for (const id of created.adjustments) await query(`delete from adjustments where id = $1`, [id]);
  for (const id of created.points)      await query(`delete from point_events where id = $1`, [id]);
  await query(`delete from hours where period = $1::date`, [PERIOD]);
  await query(`delete from month_settings where period = $1::date`, [PERIOD]);
  console.log("\ntest data removed.");
  await close();
}
process.exit(failures ? 1 : 0);
