/* The individual report has to be right in three different situations, and be
   honest in all of them: paid, short on hours, and forfeited. Set each state up
   against August (which has real jobs and points), read the report back, then
   put everything as it was. */
import { query, close } from "../src/db.js";

const BASE = "http://localhost:3000";
const PERIOD = "2026-08-01";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};
const api = async (path, opts) => {
  const r = await fetch(BASE + path, { headers: { "content-type": "application/json" }, ...opts });
  if (r.status === 204) return null;
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error((b && b.error) || `HTTP ${r.status}`);
  return b;
};

const undo = [];

try {
  const roster = await api("/api/admin/roster");

  /* Pick deliberately rather than taking the first three. The "being paid"
     case should be someone who actually earned same-day points, otherwise the
     ledger has nothing derived in it to check. */
  const aug = await api("/api/admin/summary?month=2026-08");
  const byPoints = aug.rows.slice().sort((x, y) => y.points - x.points);
  const a = roster.find(e => e.id === byPoints[0].employee_id);
  const [b, c] = roster.filter(e => e.id !== a.id);
  console.log(`  using ${a.full_name} (${byPoints[0].points} pts), ${b.full_name}, ${c.full_name}`);

  console.log("\n1. PAGE AND PREVIEW");
  check("report page loads", (await fetch(BASE + "/me")).ok);
  check("preview list is offered while there is no sign-in",
    (await api("/api/me-preview")).length === roster.length);

  /* three states, against August */
  await api("/api/admin/hours/bulk", { method: "PUT", body: JSON.stringify({
    period: PERIOD, rows: [
      { employee_id: a.id, name: a.full_name, hours: 186 },   // comfortably in
      { employee_id: b.id, name: b.full_name, hours: 61 },    // short
      { employee_id: c.id, name: c.full_name, hours: 174 }    // in, then walks
    ] }) });
  undo.push(() => query(`delete from hours where period = $1::date`, [PERIOD]));

  const rv = await api("/api/admin/reviews", { method: "POST", body: JSON.stringify({
    occurred_on: "2026-08-14", job_number: "REPORT-CHECK", customer_name: "R. Tester",
    source: "LP Google", has_photo: true, crew: [a.id] }) });
  undo.push(() => api(`/api/admin/reviews/${rv.id}`, { method: "DELETE" }));

  const bonus = await api("/api/admin/adjustments", { method: "POST", body: JSON.stringify({
    employee_id: a.id, occurred_on: "2026-08-14", kind: "bonus",
    reason: "Hoarder house — share of the clean-out fee", amount: 150 }) });
  undo.push(() => query(`delete from adjustments where id = $1`, [bonus.id]));

  const ded = await api("/api/admin/adjustments", { method: "POST", body: JSON.stringify({
    employee_id: a.id, occurred_on: "2026-08-18", kind: "deduction",
    reason: "Left a dolly on the job", amount: 40 }) });
  undo.push(() => query(`delete from adjustments where id = $1`, [ded.id]));

  const pt = await api("/api/admin/points", { method: "POST", body: JSON.stringify({
    employee_id: a.id, occurred_on: "2026-08-11", delta: -2, reason: "Call off" }) });
  undo.push(() => query(`delete from point_events where id = $1`, [pt.id]));

  console.log("\n2. SOMEONE BEING PAID");
  {
    const r = await api(`/api/me/${a.id}?month=2026-08`);
    check("their own real name is shown", r.full_name === a.full_name, r.full_name);
    check("and their code name", r.code_name === a.code_name);
    check("paid", r.paid === true && r.share > 0, "$" + r.share);
    check("take-home is share + extras − deductions",
      Math.abs(r.take_home - (r.share + 150 - 40)) < 0.02,
      `$${r.share} + $150 − $40 = $${r.take_home}`);
    check("the review shows up", (r.reviews || []).some(x => x.job_number === "REPORT-CHECK"));
    check("worth 3 with a photo", (r.reviews || []).find(x => x.job_number === "REPORT-CHECK")?.points === 3);
    check("both adjustments are listed", (r.adjustments || []).length === 2);
    check("the ledger explains the points",
      (r.ledger || []).some(e => e.reason === "Call off" && e.delta === -2),
      `${(r.ledger || []).length} entries`);
    check("same-day jobs are in the ledger without anyone logging them",
      (r.ledger || []).some(e => /same-day/i.test(e.reason)));
    check("the running total reconciles",
      15 + (r.ledger || []).reduce((s, e) => s + e.delta, 0) === r.points, `${r.points} points`);
    check("discipline counts the call off", r.discipline_lost >= 2, `${r.discipline_lost} lost`);
    check("standing is graded", ["clear","warning","suspension","termination"].includes(r.standing), r.standing);
  }

  console.log("\n3. SOMEONE SHORT ON HOURS");
  {
    const r = await api(`/api/me/${b.id}?month=2026-08`);
    check("not paid", r.paid === false && r.share === 0);
    check("nothing forfeited — short hours is not walking out", r.forfeited === 0);
    check("the reason says how far short", /hours short/.test(r.reason || ""), r.reason);
    check("points still counted and shown", r.points > 0, `${r.points} points`);
  }

  console.log("\n4. SOMEONE WHO LEFT WITHOUT NOTICE");
  {
    await api(`/api/admin/employee/${c.id}`, { method: "PATCH", body: JSON.stringify({ status: "no_notice" }) });
    undo.push(() => api(`/api/admin/employee/${c.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }));

    const r = await api(`/api/me/${c.id}?month=2026-08`);
    check("not paid", r.share === 0);
    check("they are told the amount they forfeited", r.forfeited > 0, "$" + r.forfeited);
    check("the reason says why", /two weeks notice/.test(r.reason || ""), r.reason);

    const others = (await api("/api/admin/summary?month=2026-08")).rows.filter(x => x.paid);
    check("it went to the crew still working", others.length > 0 && others.every(x => x.share > 0),
      `${others.length} sharing`);
  }

  console.log("\n5. THE REPORT SHOWS NOBODY ELSE'S MONEY");
  {
    const raw = JSON.stringify(await api(`/api/me/${a.id}?month=2026-08`));
    const others = roster.filter(e => e.id !== a.id);
    const leaked = others.filter(o => raw.includes(o.full_name) || raw.includes(o.id));
    check("no other employee's name or id appears", leaked.length === 0,
      leaked.length ? leaked.map(o => o.full_name).join(", ") : `checked ${others.length}`);
    check("no roster-wide figures", !/"rows"|"counts"/.test(raw));
  }

  console.log("\n6. A BAD ID IS REFUSED");
  {
    const r = await fetch(BASE + "/api/me/00000000-0000-0000-0000-000000000000?month=2026-08");
    check("unknown person is a 404, not a blank report", r.status === 404);
  }

  console.log("\n" + "=".repeat(58));
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
  console.log("=".repeat(58));
} catch (e) {
  console.error("\nERRORED:", e.message);
  failures++;
} finally {
  for (const fn of undo.reverse()) { try { await fn(); } catch {} }
  console.log("\ntest data removed.");
  await close();
}
process.exit(failures ? 1 : 0);
