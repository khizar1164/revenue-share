/* Connecteam, for raising a task when someone crosses a discipline threshold.
 *
 * Andrew, 3 October: "create a quick task in connecteam for matthew under
 * Payroll." The points system already knows the moment somebody crosses 15,
 * 30 or 45 in a rolling 60 days. Up to now that fact sat on a dashboard and
 * waited to be noticed. This puts it on Matthew's list instead.
 *
 * Two switches, the same as mail, and for the same reason. CONNECTEAM_API_KEY
 * says the integration *can* reach Connecteam. CONNECTEAM_TASKS=on says it
 * *may*. Configured and allowed are different questions, and a key appearing
 * in the environment is not Andrew saying yes — he has not yet confirmed the
 * board, the assignee, or whether a suspension should raise a task of its own.
 * Until he does, this reads but never writes.
 *
 * Nothing here is clever. It is a key in a header and three endpoints:
 *
 *   GET  /users/v1/users                              who Matthew is
 *   GET  /tasks/v1/taskboards                         which board is Payroll
 *   POST /tasks/v1/taskboards/{boardId}/tasks         the task itself
 *
 * https://developer.connecteam.com/docs/tasks-overview
 */

const BASE = (process.env.CONNECTEAM_BASE || "https://api.connecteam.com").replace(/\/+$/, "");

export function apiKey() {
  return (process.env.CONNECTEAM_API_KEY || "").trim() || null;
}

/** Can it reach Connecteam at all. */
export function configured() {
  return Boolean(apiKey());
}

/** Is it allowed to create anything. Reading is always allowed. */
export function writingEnabled() {
  return process.env.CONNECTEAM_TASKS === "on";
}

/** Why task creation is unavailable, in words worth showing someone. */
export function status() {
  if (!configured()) return "no Connecteam API key configured";
  if (!writingEnabled()) {
    return "task creation is switched off — nobody has said to start writing to Matthew's list yet";
  }
  return null;
}

/* The levels that raise a task. Andrew has not said whether a suspension and a
   termination should each raise one of their own, so the default is that they
   do: a seven-day unpaid suspension needs more arranging than a warning, and a
   task nobody needed is cheaper than a suspension nobody booked. */
export function taskLevels() {
  const raw = (process.env.CONNECTEAM_TASK_LEVELS || "warning,suspension,termination");
  return new Set(raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

/* ------------------------------------------------------------------------- */

async function call(path, { method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
  const key = apiKey();
  if (!key) throw new Error("no Connecteam API key configured");

  const res = await fetchImpl(`${BASE}${path}`, {
    method,
    headers: {
      "X-API-KEY": key,
      "Accept": "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave it as text */ }

  if (!res.ok) {
    /* Connecteam's errors are readable; say what it said rather than "request
       failed", because the usual cause is a plan that does not include the API
       or a key missing a scope, and both of those are stated in the reply. */
    /* Validation errors come back as an object, and a template literal turns
       that into "[object Object]" — which is how an afternoon gets spent
       guessing at a message the server already sent. */
    const raw = json?.message ?? json?.error ?? json?.detail ?? text.slice(0, 400) ?? res.statusText;
    const why = typeof raw === "string" ? raw : JSON.stringify(raw);
    const err = new Error(`Connecteam ${method} ${path} → ${res.status}: ${why}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Everyone Connecteam knows about. */
export async function listUsers(opts = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await call(`/users/v1/users?limit=500&offset=${offset}`, opts);
    const users = page?.data?.users ?? [];
    out.push(...users);
    if (users.length < 500) break;
    offset += users.length;
  }
  return out;
}

/** The one person a task is for. Email first, because names are the weak point. */
export async function findUser({ email, name }, opts = {}) {
  const users = await listUsers(opts);
  const want = (email || "").trim().toLowerCase();
  if (want) {
    const byEmail = users.find(u => (u.email || "").toLowerCase() === want);
    if (byEmail) return byEmail;
  }
  const wantName = (name || "").trim().toLowerCase();
  if (wantName) {
    const byName = users.find(u =>
      `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim().toLowerCase() === wantName);
    if (byName) return byName;
  }
  return null;
}

export async function listBoards(opts = {}) {
  const r = await call("/tasks/v1/taskboards", opts);
  /* The reply has been seen shaped both ways in the wild, so take either. */
  return r?.data?.taskBoards ?? r?.data?.taskboards ?? r?.data ?? [];
}

/**
 * The board a task goes on.
 *
 * Immediate Movers has exactly one, "Task Management", and everything is
 * organised by label rather than by board. So an unnamed board means the only
 * board there is: naming it in configuration would be writing down a fact the
 * account can already answer, and getting a new board added would silently
 * break it. Name one explicitly and it has to be that one.
 */
export async function findBoard(name = process.env.CONNECTEAM_BOARD, opts = {}) {
  const boards = await listBoards(opts);
  if (!name) return boards.length === 1 ? boards[0] : null;
  const want = String(name).trim().toLowerCase();
  return boards.find(b => String(b.name ?? b.title ?? "").trim().toLowerCase() === want) ?? null;
}

export async function listLabels(boardId, opts = {}) {
  const r = await call(`/tasks/v1/taskboards/${encodeURIComponent(boardId)}/labels`, opts);
  return r?.data?.labels ?? [];
}

/**
 * The label the task is filed under.
 *
 * Andrew, 6 October: 'Quick Task label "Human Resources"'. His earlier message
 * said Payroll; both labels exist, and the later, more specific instruction is
 * the one followed. It is also the label already on the quick tasks Matthew
 * gets today, so a write-up will land where he is used to looking.
 */
export async function findLabel(boardId, name = process.env.CONNECTEAM_LABEL || "Human Resources", opts = {}) {
  const labels = await listLabels(boardId, opts);
  const want = String(name).trim().toLowerCase();
  /* One of the labels in this account is called "Maintenance " with a trailing
     space, so trimming both sides is not fussiness. */
  return labels.find(l => String(l.name ?? "").trim().toLowerCase() === want) ?? null;
}

/**
 * Create one quick task.
 *
 * Refuses unless CONNECTEAM_TASKS=on. The refusal is thrown rather than
 * returned quietly, because a caller that reports "task created" when nothing
 * was created is worse than one that fails.
 */
export async function createTask({ boardId, userIds, title, description, labelIds, dueDate }, opts = {}) {
  if (!writingEnabled()) {
    throw new Error("CONNECTEAM_TASKS is not 'on' — no task would be created");
  }
  if (!boardId) throw new Error("no task board given");
  if (!Array.isArray(userIds) || !userIds.length) throw new Error("a task needs somebody to do it");

  const body = {
    title: String(title).slice(0, 200),
    userIds,
    status: "published",
    type: "oneTime",
    /* Not a string, and not the shape a task comes back in either. Reading a
       task gives description as a list of typed blocks; writing one wants an
       object with a content string. Send a string and it is rejected; send the
       shape that was read back and it is also rejected, with "field required"
       pointing at body.description.content. Found by asking the API. */
    ...(description ? { description: { type: "html", content: String(description) } } : {}),
    ...(labelIds?.length ? { labelIds } : {}),
    /* Connecteam wants whole seconds. */
    ...(dueDate ? { dueDate: Math.floor(new Date(dueDate).getTime() / 1000) } : {})
  };

  const r = await call(`/tasks/v1/taskboards/${encodeURIComponent(boardId)}/tasks`,
    { ...opts, method: "POST", body });
  return r?.data?.task ?? r?.data ?? r;
}

/* ------------------------------------------------------------------------- */

/* What the task says. Written to be read on a phone, by someone who is about
   to go and have an uncomfortable conversation and wants to know what it is
   about before they walk in. */
export function taskText({ name, level, lost, windowFrom, windowTo, incidents = [] }) {
  const WHAT = {
    warning:     "Written warning",
    suspension:  "Suspension — 7 days unpaid",
    termination: "Termination review"
  };
  const title = `${WHAT[level] ?? "Disciplinary action"} — ${name}`;

  const at = level === "warning" ? 15 : level === "suspension" ? 30 : 45;

  const worst = incidents
    .filter(i => i.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 4)
    .map(i => `<li>${esc(i.date)} — ${esc(i.reason)} <b>(${i.delta})</b></li>`);

  /* The body is HTML because that is what Connecteam stores. Kept to the tags
     a task card actually renders: paragraphs, a list, bold. */
  const html = [
    `<p><b>${esc(name)}</b> has lost <b>${lost} points</b> in the 60 days to ${esc(windowTo)}.</p>`,
    `<p>That crosses the ${at}-point threshold, so a ` +
      `${esc(WHAT[level]?.toLowerCase() ?? "disciplinary notice")} is due.</p>`,
    worst.length ? `<p>Biggest deductions in the window:</p><ul>${worst.join("")}</ul>` : "",
    `<p>Window: ${esc(windowFrom)} to ${esc(windowTo)}.</p>`,
    `<p>The write-up generates from the points record. Print it, go through it ` +
      `with them, and both sign.</p>`,
    `<p><i>Raised automatically by the revenue share system.</i></p>`
  ].filter(Boolean).join("");

  return { title, description: html };
}

/* A reason comes off a sheet somebody types into, so it reaches here as
   whatever they wrote. Into HTML it goes escaped. */
function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
