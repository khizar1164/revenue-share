/* Writing the tip that goes on the break-room wall.
 *
 * The pattern library in tips.js answers every claim on record, but it answers
 * them from thirteen rules, and a claim about something nobody anticipated
 * gets nothing. This asks Claude instead, and falls back to the library when
 * it cannot.
 *
 * Written at the moment the claim is recorded, deliberately, not each morning
 * when the board wakes up. Three reasons, and the first is the real one:
 *
 *   Andrew is sitting there. He has just typed the reason, so he can read the
 *   sentence and fix it while the incident is in his head, rather than finding
 *   out a fortnight later that a screen in the break room has been saying
 *   something odd.
 *
 *   The board never waits on a network call. Whatever happens here, by six in
 *   the morning the tip is a row in a table.
 *
 *   The wording stays put. A tip regenerated daily drifts under the crew's
 *   eyes and nobody can tell whether the advice changed or the model did.
 *
 * Failure is never fatal. No key, a timeout, a refusal, a reply that does not
 * look like a tip: all of them fall through to the library, and a claim is
 * never lost because the board would have been one sentence short.
 */
import Anthropic from "@anthropic-ai/sdk";
import { tipFor, claimText } from "./tips.js";

export const configured = () => Boolean((process.env.ANTHROPIC_API_KEY || "").trim());

/* Andrew, 6 November: "Lets leave off the tips for now until I can provide
   better instructions on that". Off by default rather than removed: the
   wording is what he wants to think about, not the machinery, and when he
   comes back to it this is one environment variable rather than a rebuild.
   Off also means nothing is generated, so it costs nothing while it waits. */
export const tipsEnabled = () =>
  /^(on|true|1|yes)$/i.test((process.env.CLAIM_TIPS || "").trim());

/* House style, and the boundaries. The crew read this on a wall, so it has to
   be short, specific and about what to do rather than what went wrong. The
   last two lines matter most: this is a page about improving, not a notice
   about a person, and nothing here should ever read as an accusation. */
const SYSTEM = `You write one-sentence safety and quality tips for the crew of a
moving company, shown on a screen in their break room.

A tip is written from a damage or loss claim. Write what to do differently next
time, in plain English, as practical advice a mover can act on.

Rules:
- One or two sentences. Under 40 words.
- Say what to do, not what went wrong.
- Never name or refer to any person, crew or job. Never say "you" accusingly.
- No preamble, no quotes, no bullet points. Return the tip text only.
- British or American spelling is fine; match plain, direct trade language.

Example claim: "TV Damaged"
Example tip: "Televisions travel in a box or a TV bag, never loose and never
flat. Photograph the screen before it goes on the truck."`;

/**
 * A tip for one claim.
 *
 * Returns { tip, source } so the caller can record which wrote it. Never
 * throws: every path ends in a sentence or in null.
 */
export async function writeTip(claim, { timeoutMs = 20_000 } = {}) {
  const fallback = tipFor(claim);
  const text = claimText(claim);
  if (!text.trim()) return { tip: null, source: "none" };
  if (!configured()) return { tip: fallback, source: fallback ? "library" : "none" };

  try {
    const client = new Anthropic();
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 300,
      /* Low effort on purpose. This is one sentence of plain advice, not a
         problem to reason about, and the board is waiting on nothing. */
      output_config: { effort: "low" },
      /* A refused request otherwise just stops. A tip about moving furniture
         is never going to trip a classifier, but the cost of saying so is two
         fields and the cost of being wrong is a blank wall. */
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: `Claim: ${text}` }]
    }, { timeout: timeoutMs });

    if (res.stop_reason === "refusal") {
      return { tip: fallback, source: fallback ? "library" : "none" };
    }

    const out = res.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join(" ")
      .trim();

    /* A reply that is empty, enormous, or has clearly answered some other
       question is not going on a wall. The library is right there. */
    if (!out || out.length > 400) {
      return { tip: fallback, source: fallback ? "library" : "none" };
    }
    return { tip: out, source: "claude" };
  } catch (e) {
    console.warn(`tip not written by Claude, using the library: ${e.message}`);
    return { tip: fallback, source: fallback ? "library" : "none" };
  }
}
