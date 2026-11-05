/* The lesson from a claim, in a sentence the crew can act on.
 *
 * Andrew, 3 November, about the break-room board: "show a list of all of the
 * claims and what they're for, that way the crew knows where we have more room
 * for improvement." And then, minutes later, the thing that shapes this file:
 * "I don't want it so highlighted on 'hey, this is everything we're doing
 * wrong'... maybe we can have it show some automated tips."
 *
 * A claim on its own reads as blame. A claim with what to do differently reads
 * as training. So the board shows both and the tip does the work.
 *
 * Patterns rather than a model, for the same reason the write-up uses them:
 * no key, no running cost, nothing to go wrong at six in the morning when the
 * TV wakes up, and every sentence is one somebody wrote. The library is
 * matched against the claim's reason and note together, because the reason is
 * usually just "Claim" and everything useful is in the note.
 *
 * Where it finds nothing it says so plainly rather than inventing advice, and
 * Andrew can rewrite any tip by hand. A rewritten one is never overwritten.
 */

/* First match wins, so the order is the design. A note reading "Lost 2 TV
   cords" is about small parts, not about televisions, and "Primer, Paint,
   Glue, Hardware" is about paint. The specific patterns have to sit above the
   general ones or the general one answers for both. */
export const TIP_LIBRARY = [
  [/cord|cable|remote/i,
   "Small parts go missing between the dresser and the truck, not on the road. Bag the cords, screws and remotes, tape the bag to the item they belong to, and they arrive with it."],

  [/paint|primer|knick|nick|door jamb|scuff/i,
   "Door jambs, stair walls and tight corners are where paint gets marked. Pad the frame before the first heavy item goes through it, not after the first knock."],

  /* Above reassembly on purpose. A note opening "inefficient/slow crew
     performance" and mentioning assembly in passing is about pace; matching
     the word "assembly" first answered the wrong complaint. */
  [/slow|inefficien|performance|pace/i,
   "Pace is usually a planning problem, not an effort problem. Walk the job, agree who takes what, and stage items near the door before carrying starts."],

  [/reattach|reassemb|assembl|not put back|mirror/i,
   "Anything taken apart gets put back the same day, by whoever took it apart. A mirror left off a dresser is a return trip, and the customer notices it the moment we drive away."],

  [/overpack|rearrang|repack|restack/i,
   "A truck loaded once properly beats one rearranged three times. Heavy and square on the bottom, tiered and tied as you go: restacking in the customer's driveway costs time and is where things get damaged."],

  [/\btv\b|television|screen/i,
   "Televisions are the single most claimed item we handle. They travel in a box or a TV bag, never loose, never flat, and never under anything. Photograph the screen before it goes on the truck."],

  [/floor|carpet|scratch/i,
   "Floor protection goes down before the first item comes in, across the whole path, not just the doorway. Runners cost minutes and floor repairs cost hundreds."],

  [/window|storm/i,
   "Storm windows and covers break because they are in the path and nobody moved them. Walk the route first and take off what is in the way before carrying anything through it."],

  [/dolly|strap|shoulder|equipment/i,
   "Equipment that walks off a job was usually set down outside the truck. Everything that comes off goes back on before the doors close, and a count at the end takes a minute."],

  [/cabinet|furniture|foot|leg|drawer/i,
   "Furniture breaks at its weakest point, which is the feet and legs. Lift from the frame, never drag, and pad the corners before it moves."],

  [/box|carton|crush/i,
   "Boxes crush from below. Heaviest at the bottom, nothing fragile under anything, and no stack higher than it is stable."],

  [/water|rain|wet|weather/i,
   "Wet weather needs the truck closed between trips and covers on anything absorbent. Water damage shows up days later, long after we have gone."],

  [/hardware|screw|bolt|wall/i,
   "Fixings and wall contact are where small damage starts. Keep hardware with its item and protect the wall before anything heavy passes it."]
];

/* The claim's own words, which is what the patterns read. The reason on a
   claim is nearly always just "Claim"; the note is where the detail lives. */
export const claimText = c => [c.reason, c.note].filter(Boolean).join(" — ");

/**
 * A tip for one claim, or null when nothing in the library fits.
 *
 * Null rather than a generic line on purpose. "Be careful out there" on a wall
 * for a fortnight teaches nobody anything and trains people to stop reading
 * the screen. A claim with no tip still shows, with its reason, and Andrew can
 * write the tip himself.
 */
export function tipFor(claim) {
  const text = claimText(claim);
  if (!text.trim()) return null;
  return (TIP_LIBRARY.find(([re]) => re.test(text)) ?? [, null])[1];
}

/**
 * Which tip the board shows today.
 *
 * Andrew: "if there are two claims in a month, the tip will change every day,
 * and they can see, okay, we can improve this and this and this." So it cycles
 * a day at a time through everything there is, rather than holding one up
 * until a new claim arrives.
 *
 * The day number drives it rather than a stored cursor, so every screen shows
 * the same tip on the same day, the board can restart without losing its
 * place, and nothing has to be written to pick one.
 */
export function tipOfTheDay(tips, when = new Date()) {
  if (!tips.length) return null;
  const days = Math.floor(Date.parse(
    `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}T00:00:00Z`
  ) / 864e5);
  return tips[days % tips.length];
}
