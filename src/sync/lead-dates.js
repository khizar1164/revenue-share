/* Put the move date on estimates MoveitPro left undated.
 *
 * A lead created through the API keeps its move_date, but the estimate raised
 * for it comes out with service_date null, and the estimate is what the sales
 * team work from and what drives their follow-up list. Leads arriving any
 * other way, by phone or through the lead provider webhook, have the date on
 * both. Raised with MoveitPro; this is the workaround until they close it.
 *
 * It runs as a job rather than at the moment the lead lands because the
 * estimate is not there yet when the lead is created. A lead created at 13:39
 * still had no estimate minutes later, so writing at intake would have found
 * nothing to write to, and waiting for one would hold Zapier's request open.
 *
 * Only drafts with no date are touched. Once the office has set a date, or
 * moved the estimate past draft, theirs stands and this leaves it alone.
 */
import { get, patch } from "../moveitpro.js";

const PAGE = 100;

/**
 * Returns what it did, so the scheduler line says something worth reading:
 * { looked, dated, already, waiting, failed, capped }
 */
export async function syncLeadDates({ log = console.log, ...opts } = {}) {
  const leads = asRows(await get(`/v1/leads?limit=${PAGE}`, opts));
  const drafts = asRows(await get(`/v1/estimates?limit=${PAGE}&status=draft`, opts));

  const draftFor = new Map();
  for (const e of drafts) if (e.prospect_id && !draftFor.has(e.prospect_id)) draftFor.set(e.prospect_id, e);

  const out = { looked: 0, dated: 0, already: 0, waiting: 0, failed: 0, capped: drafts.length >= PAGE };

  for (const lead of leads) {
    if (!lead.move_date) continue;
    out.looked++;
    const estimate = draftFor.get(lead.id);
    /* No draft means either the office has already worked it, in which case it
       is not ours to touch, or MoveitPro has not raised one yet and the next
       run will find it. */
    if (!estimate) { out.waiting++; continue; }
    if (estimate.service_date) { out.already++; continue; }

    try {
      await patch(`/v1/estimates/${encodeURIComponent(estimate.id)}`,
        { service_date: lead.move_date },
        { idempotencyKey: `estdate-${estimate.id}-${lead.move_date}`,
          ifMatch: estimate.updated_at, ...opts });
      out.dated++;
      log(`lead-dates: estimate #${estimate.estimate_number ?? estimate.id} → ${lead.move_date}`);
    } catch (e) {
      /* A 412 means the estimate changed between our read and our write, which
         is the office editing it. Theirs wins; we will see it next time. */
      out.failed++;
      log(`lead-dates: #${estimate.estimate_number ?? estimate.id} not dated: ${e.message}`);
    }
  }

  if (out.capped) log(`lead-dates: ${PAGE} drafts is a full page, older ones were not looked at`);
  return out;
}

const asRows = v => (Array.isArray(v) ? v : v?.data ?? []);
