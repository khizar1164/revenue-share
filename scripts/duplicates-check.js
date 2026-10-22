/* Two accounts, one person — both halves of it.
 *
 * Andrew, 21 October: "Landon has two accounts in revenue dashboard."
 *
 * There are two questions here and they fail in opposite directions.
 *
 *   The door. When a SmartMoving crew member works their first job, is that
 *   somebody already on the roster or somebody new? Say "new" too easily and
 *   you get Landon twice. Say "already here" too easily and you pay two
 *   different people as one, which is worse and much quieter.
 *
 *   The panel. Which rows look like the same person, and how sure is that?
 *   An exact name or a shared email is as good as certain. A first name and a
 *   last initial is not: Jason Powell and Jason Plummer are both "Jason P",
 *   and both are real people here.
 *
 * No database and no network. Both are decisions over rows, so both are
 * exercised as decisions over rows.
 */
import { likelyDuplicates, placeAgainstRoster } from "../src/roster.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

/* The roster as the fault actually looked: Landon arrived from Connecteam on
   the day he was set up and has no crew id, the rest came in through jobs. */
const ROSTER = [
  { id: "e1", code_name: "RANGER", full_name: "Josh Trim",     sm_crew_id: "sm-1" },
  { id: "e2", code_name: "JAGUAR", full_name: "Brett Wood",    sm_crew_id: "sm-2" },
  { id: "e3", code_name: "LYNX",   full_name: "Landon Keller", sm_crew_id: null },
  { id: "e4", code_name: "BEAR",   full_name: "Jason Plummer", sm_crew_id: null },
  { id: "e5", code_name: "OFFICE-MB", full_name: "Matthew Brown", sm_crew_id: null },
  { id: "e6", code_name: "STOAT",  full_name: "Landon Keller", sm_crew_id: null,
    merged_into: "e3" }
];

console.log("1. THE DOOR THAT MADE TWO LANDONS");
{
  const crew = [
    { id: "sm-1", name: "Josh Trim" },          // already here, by crew id
    { id: "sm-9", name: "Landon Keller" },      // here from Connecteam, no crew id
    { id: "sm-7", name: "Blade Williams" }      // genuinely new
  ];
  const out = placeAgainstRoster(crew, ROSTER);

  check("somebody already carrying the crew id is left alone", out.already === 1);
  check("Landon is recognised, not enrolled again",
    out.adopt.length === 1 && out.adopt[0].employee.code_name === "LYNX",
    out.adopt.map(a => a.member.name + " → " + a.employee.code_name).join(", ") || "nobody");
  check("and the crew id goes to the account he already has",
    out.adopt[0].member.id === "sm-9");
  check("somebody genuinely new is still enrolled",
    out.add.length === 1 && out.add[0].name === "Blade Williams",
    out.add.map(m => m.name).join(", ") || "nobody");
}

console.log("\n2. WHAT IT MUST NOT DO");
{
  /* Spelling is not identity. "Landon Kellar" is one letter out, and adopting
     on that would be the system deciding, which is the one thing it must not
     do with somebody's pay. */
  const out = placeAgainstRoster([{ id: "sm-5", name: "Landon Kellar" }], ROSTER);
  check("a near-miss name is not adopted", out.adopt.length === 0);
  check("it is enrolled and reported for somebody to look at",
    out.add.length === 1 && out.maybe.length === 1, out.maybe.join("; ") || "nothing said");

  /* Jason Powell in sales and Jason Plummer on the crew are both "Jason P". */
  const two = placeAgainstRoster([{ id: "sm-6", name: "Jason Powell" }], ROSTER);
  check("a first name and last initial never adopts", two.adopt.length === 0);

  /* The merged row carries the same name as the account that was kept. If it
     could take the crew id, every job would attach to the row nobody reads. */
  const landon = placeAgainstRoster([{ id: "sm-9", name: "Landon Keller" }], ROSTER);
  check("a row already merged away is never the one adopted",
    landon.adopt.length === 1 && landon.adopt[0].employee.id === "e3",
    "picked " + (landon.adopt[0] ? landon.adopt[0].employee.code_name : "nobody"));

  /* Migration 004: Matthew stays on the roster, not a mover, so that the sync
     does not re-enrol him on his next job. That only holds if his crew id can
     land on the row that is already there. */
  const mb = placeAgainstRoster([{ id: "sm-8", name: "Matthew Brown" }], ROSTER);
  check("the office does take its crew id, so it is not enrolled again",
    mb.adopt.length === 1 && mb.adopt[0].employee.code_name === "OFFICE-MB");

  /* Two crew members with the same name in one run must not both be given the
     same row — the second is a genuinely separate account to look at. */
  const twice = placeAgainstRoster(
    [{ id: "sm-a", name: "Landon Keller" }, { id: "sm-b", name: "Landon Keller" }], ROSTER);
  check("one roster row is claimed once in a run",
    twice.adopt.length === 1 && twice.add.length === 1);
}

console.log("\n3. WHICH ROWS LOOK LIKE ONE PERSON");
{
  const rows = [
    { id: "1", code_name: "OTTER", full_name: "Landon Keller", email: "landon@x.com" },
    { id: "2", code_name: "STOAT", full_name: "Landon Keller", email: null },
    { id: "3", code_name: "WOLF",  full_name: "Josh Trim",     email: "josh@t.com" },
    { id: "4", code_name: "RAVEN", full_name: "Joshua Trim",   email: "Josh@T.com" },
    { id: "5", code_name: "BEAR",  full_name: "Jason Plummer", email: null },
    { id: "6", code_name: "HAWK",  full_name: "Jason Powell",  email: "jp@x.com" },
    { id: "7", code_name: "ELK",   full_name: "Brett Wood",    email: null },
    { id: "8", code_name: "GONE",  full_name: "Landon Keller", email: null, merged_into: "1" }
  ];
  const groups = likelyDuplicates(rows);
  const by = name => groups.find(g => g.people.some(p => p.code_name === name));

  check("the same name is found", !!by("OTTER") && by("OTTER").certain,
    by("OTTER") ? by("OTTER").why : "not found");
  check("so is the same address, spelled differently",
    !!by("WOLF") && by("WOLF").people.length === 2 && by("WOLF").certain,
    by("WOLF") ? by("WOLF").why : "not found");
  check("two people who merely look alike are flagged, not stated",
    !!by("BEAR") && by("BEAR").certain === false,
    by("BEAR") ? by("BEAR").why : "not found");
  check("somebody on their own is not in a group", !by("ELK"));
  check("a row already merged is left out of it",
    !groups.some(g => g.people.some(p => p.code_name === "GONE")));
  check("and that is all of them", groups.length === 3,
    groups.map(g => g.people.map(p => p.code_name).join("+")).join(", "));
}

console.log("\n4. A PILE HELD TOGETHER BY A WEAK LINK IS NOT CERTAIN");
{
  /* Two spellings of Landon and one typo. The typo only matches on the loose
     key, so the group it drags in cannot be called certain however sure the
     other link was. */
  const groups = likelyDuplicates([
    { id: "1", code_name: "OTTER", full_name: "Landon Keller", email: "l@x.com" },
    { id: "2", code_name: "STOAT", full_name: "Landon Keller", email: null },
    { id: "3", code_name: "ELK",   full_name: "Landon Kellar", email: null }
  ]);
  check("all three come back as one group",
    groups.length === 1 && groups[0].people.length === 3);
  check("and it asks to be checked", groups[0].certain === false);
  check("naming both reasons", /same name/.test(groups[0].why) &&
    /last initial/.test(groups[0].why), groups[0].why);
}

console.log("\n" + "=".repeat(58));
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`);
console.log("=".repeat(58));
process.exit(failures ? 1 : 0);
