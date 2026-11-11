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
import { likelyDuplicates } from "../src/roster.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

console.log("1. WHICH ROWS LOOK LIKE ONE PERSON");
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
