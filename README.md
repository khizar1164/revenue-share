# Revenue Share — Immediate Movers & Storage

Three screens over one calculation:

- **`/tv/<token>`** — the break-room board. No login. Code names, no revenue figure, no real names.
- **`/me`** — one mover's own report. Email sign-in.
- **`/admin`** — Andrew and Nicole. Reviews, claims, hours, points, bonuses, roster.

## The rules it enforces

Monthly revenue × 2%, less claims, is the pool. It splits **60% on performance points, 40% on 5-star reviews**.

- Everyone starts each month on **15 points**. A second job in a day earns **+1**, added automatically from the schedule.
- A review is worth **1**, or **3** with a photo. Every mover on the job gets the full value.
- Under **75 hours** in the month and you do not share, though your points and reviews still count.
- Leaving without **two weeks notice** forfeits the share, which is redistributed across everyone still working and shown in red on the TV.
- Bonuses and individual deductions are **private** — the person's own report only.
- Anything the split cannot allocate stays unallocated during the month and, if still unallocated when the month closes, stays with the company.

## Where the numbers come from

| | Source | How often |
|---|---|---|
| Completed revenue, job count | SmartMoving Revenue Forecast report | daily |
| Crew per job, job dates, same-day bonuses | SmartMoving API | every 4 hours |
| Hours | Connecteam → the `Hours` tabs in the Movers Dashboard sheet | every 10 minutes |
| Reviews, claims, points, bonuses, deductions | typed into `/admin` | instantly |
| Day-end summary and a backup of everything typed | written out to the sheet | nightly |

Revenue is **not** derived from the API. That was tried: summing payments matched August to 0.11% but was 6–7% out on June and July, because payments include tips and an opportunity spanning two months counts into both. The report already holds the exact figure, so we read that.

Crew assignment is read from the **crew side**, not the job. A job's `crewMembers[]` is always empty; asking each mover which jobs they worked is fully populated, and covers a month in about 18 calls.

## Running it

```bash
npm install
cp .env.example .env      # then fill it in
npm run migrate
npm start
```

`RUN_SCHEDULER=on` starts the background jobs. They are off by default so a local
run never hits SmartMoving or rewrites the sheet.

### Checks

```bash
npm test            # calculation + API, no external services
npm run test:live   # admin and report flows against the real database
```

Others worth knowing: `scripts/hours-check.js`, `weekly-check.js`,
`month-tab-check.js`, `scheduler-check.js`, `auth-check.js`,
`writeback-check.js`.

## Email

Sending is **off**. `SEND_EMAILS` must be `on`, and while `MAIL_ALLOWLIST` is set
only the addresses on it can receive anything — two independent stops, because
Andrew has not approved sign-in emails to the crew yet.

## Environment

| | |
|---|---|
| `DATABASE_URL` | Postgres. Use Render's **internal** URL in production. |
| `TV_TOKEN` | the unguessable part of the break-room URL |
| `PUBLIC_URL` | where the app is reachable — sign-in links are built from it |
| `SMARTMOVING_API_KEY` | free Basic tier is enough; we only read |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the whole key file, pasted in |
| `SHEET_ID` | the Movers Dashboard workbook |
| `RESEND_API_KEY` | sending, once approved |
| `RUN_SCHEDULER` | `on` in production |
| `SEND_EMAILS` | `on` only when the crew are meant to receive mail |
| `MAIL_ALLOWLIST` | comma-separated; clear it when the crew are live |
| `ALLOW_REPORT_PREVIEW` | `off` anywhere public |
| `TIMEZONE` | `America/Chicago` — La Porte is Central |

## Notes for whoever picks this up

**`point_events` is a dated log, never a running total.** That is what makes the
rolling 60-day discipline window, the "why is my number what it is" ledger, and
any dispute about a deduction answerable.

**The roster follows the jobs.** Working a job is what makes someone a mover, so
new starters enrol themselves. Office and management are marked `is_mover =
false` rather than deleted, because deleting them means the next sync adds them
straight back.

**Names are the weak point.** SmartMoving, Connecteam and the review log all
spell people differently — Josh Trim is "Joshua Trim" in one and "Josh T" in
another. The matcher is generous but refuses when two people fit, because a
wrong match pays the wrong man and nobody notices.

**The TV's allow-list is in `views.js`.** It names every field it emits, so
adding a column to the calculation can never silently put it on the wall.
