/* Linking movers to MoveitPro employees: the decision, with no database and no
 * network. These are the cases the roster actually had on 11 November 2026.
 *
 * What has to hold, because a wrong link credits one mover's jobs to another:
 *   - an exact name links
 *   - a terminated record is never linked, even with the right name
 *   - "Josh" links to "Joshua" with the same surname, only when it is the one fit
 *   - two people who share a first name and initial are never linked by guesswork
 *   - nobody is linked twice, and a MoveitPro employee already taken stays taken
 *   - anyone with no match is reported, not guessed
 */
import { matchEmployees } from "../src/sync/mip-crew.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

const mip = [
  { id: "m-jacob-old", first_name: "Jacob", last_name: "Byer", employee_status: "Terminated", is_dispatchable: false },
  { id: "m-jacob",     first_name: "Jacob", last_name: "Byer", employee_status: "Employed",   is_dispatchable: true },
  { id: "m-mitchell",  first_name: "Mitchell", last_name: "Byer", employee_status: "Terminated" },
  { id: "m-joshua",    first_name: "Joshua", last_name: "Trim", employee_status: "Employed", is_dispatchable: true },
  { id: "m-jason-pl",  first_name: "Jason", last_name: "Plummer", employee_status: "Employed" },
  { id: "m-jason-po",  first_name: "Jason", last_name: "Powell", employee_status: "Employed" },
  { id: "m-craig",     first_name: "Craig", last_name: "Hawkins", employee_status: "Employed" }
];
const movers = [
  { id: "e-jacob",  full_name: "Jacob Byer" },
  { id: "e-josh",   full_name: "Josh Trim" },
  { id: "e-jason",  full_name: "Jason Plummer" },
  { id: "e-brett",  full_name: "Brett Wood" },
  { id: "e-craig",  full_name: "Craig Hawkins" }
];

console.log("\n1. WHO LINKS");
const out = matchEmployees(movers, mip);
const linkOf = id => out.links.find(l => l.employeeId === id)?.mipId;
check("an exact name links", linkOf("e-craig") === "m-craig");
check("the current Jacob Byer, never the terminated record", linkOf("e-jacob") === "m-jacob", linkOf("e-jacob"));
check("Josh Trim is Joshua Trim", linkOf("e-josh") === "m-joshua");
check("Jason Plummer is not mistaken for Jason Powell", linkOf("e-jason") === "m-jason-pl");
check("no match is reported, not guessed", out.unmatched.includes("Brett Wood") && !linkOf("e-brett"));

console.log("\n2. WHAT IT MUST NOT DO");
const twoJosh = matchEmployees([{ id: "x", full_name: "Josh Trim" }],
  [...mip, { id: "m-joshua2", first_name: "Joshua", last_name: "Trim", employee_status: "Employed" }]);
check("two people who could be Josh are left alone", !twoJosh.links.length && twoJosh.ambiguous.includes("Josh Trim"));

const taken = matchEmployees([{ id: "y", full_name: "Craig Hawkins" }], mip, { taken: new Set(["m-craig"]) });
check("a MoveitPro employee already linked is not linked again", !taken.links.length);

const once = matchEmployees([{ id: "a", full_name: "Craig Hawkins" }, { id: "b", full_name: "Craig Hawkins" }], mip);
check("one MoveitPro employee is given to one mover in a run", once.links.length === 1);

const onlyOld = matchEmployees([{ id: "z", full_name: "Mitchell Byer" }], mip);
check("a name that only exists as a terminated record does not link", !onlyOld.links.length);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
