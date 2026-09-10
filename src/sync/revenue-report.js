/* Revenue Forecast report — the authoritative source for Completed Revenue.
 *
 * We do not derive revenue from the API. That was tried: summing payments on
 * completed opportunities matched August 2026 to 0.11% but was 6-7% out on June
 * and July, because payments include tips and an opportunity spanning two months
 * gets counted into both. SmartMoving's own report already has the exact figure,
 * so we read that instead.
 *
 * SmartMoving can email this report on a daily schedule. The mail contains a
 * "Download Report" link rather than an attachment — the link is signed and
 * needs no login (verified in a private window), and the file lives 30 days.
 *
 * Flow:  scheduled mail -> extract link -> download xlsx -> parse -> revenue row
 */

import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

/* ------------------------------------------------------------ xlsx read ---- */
/* An xlsx is a zip of XML. Rather than take a dependency for one known report
   shape, read the two parts we need directly. */

function readZipEntries(buf) {
  const entries = new Map();
  /* walk the end-of-central-directory to find each local file header */
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name     = buf.toString("utf8", p + 46, p + 46 + nameLen);

    const lNameLen  = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    entries.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

const unescapeXml = s => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const colIndex = ref => {
  const letters = ref.match(/^([A-Z]+)/)[1];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export function parseXlsx(buffer) {
  const zip = readZipEntries(buffer);

  const ssXml = zip.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared = ssXml.split("<si>").slice(1).map(si =>
    unescapeXml([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(""))
  );

  const sheetName = [...zip.keys()].find(k => /^xl\/worksheets\/sheet1\.xml$/.test(k))
    ?? [...zip.keys()].find(k => /^xl\/worksheets\/.*\.xml$/.test(k));
  if (!sheetName) throw new Error("no worksheet found in xlsx");
  const xml = zip.get(sheetName).toString("utf8");

  const rows = [];
  for (const rowXml of xml.split("<row ").slice(1)) {
    const cells = [];
    for (const m of rowXml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const [, ref, attrs, inner] = m;
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      let v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (v === undefined) v = (inner.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] ?? "";
      cells[colIndex(ref)] = type === "s" ? (shared[Number(v)] ?? v) : unescapeXml(String(v));
    }
    rows.push(cells);
  }
  return rows;
}

/* -------------------------------------------------------------- report ---- */

const HEADERS = {
  date:      /^date$/i,
  completed: /^#\s*completed$/i,
  revenue:   /^completed revenue$/i,
  tips:      /^total tips$/i,
  taxes:     /^total taxes$/i
};

const num = v => {
  const n = Number(String(v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Turn the Revenue Forecast sheet into one row per month.
 * The report's Date column is "8/2026"; we normalise to a period date.
 */
export function parseRevenueForecast(buffer) {
  const rows = parseXlsx(buffer);
  const header = rows.find(r => r.some(c => HEADERS.date.test(String(c ?? "").trim())));
  if (!header) throw new Error("could not find the header row — is this the Revenue Forecast report?");

  const col = {};
  header.forEach((cell, i) => {
    const text = String(cell ?? "").trim();
    for (const [key, re] of Object.entries(HEADERS)) if (re.test(text)) col[key] = i;
  });
  for (const need of ["date", "revenue"]) {
    if (col[need] === undefined) throw new Error(`report is missing the "${need}" column`);
  }

  const start = rows.indexOf(header) + 1;
  const out = [];
  for (const r of rows.slice(start)) {
    const label = String(r[col.date] ?? "").trim();
    const m = label.match(/^(\d{1,2})\/(\d{4})$/);
    if (!m) continue;
    const [, mm, yyyy] = m;
    out.push({
      period:            `${yyyy}-${String(mm).padStart(2, "0")}-01`,
      label,
      completed_jobs:    col.completed !== undefined ? num(r[col.completed]) : null,
      completed_revenue: num(r[col.revenue]) ?? 0,
      total_tips:        col.tips  !== undefined ? num(r[col.tips])  : null,
      total_taxes:       col.taxes !== undefined ? num(r[col.taxes]) : null
    });
  }
  if (!out.length) throw new Error("no month rows parsed from the report");
  return out;
}

export const monthOf = (months, period) => months.find(m => m.period === period) ?? null;

export const currentPeriod = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

/* --------------------------------------------------------------- email ---- */

/**
 * Pull the "Download Report" link out of the SmartMoving notification mail.
 *
 * The mail has other links — the company address, the homepage — so the one
 * whose text says "Download" wins, then anything that looks like a report or
 * file link. Works on the HTML body or the plain-text one, since Zapier can
 * forward either.
 */
export function extractReportLink(body) {
  const text = String(body ?? "");
  const unescape = u => u.replace(/&amp;/g, "&").trim();
  const noise = /^(mailto:|tel:)|google\.[a-z.]+\/maps|unsubscribe|\/privacy|\/terms/i;
  const bareHome = /^https?:\/\/(www\.)?smartmoving\.com\/?$/i;

  /* <a href="…">Download Report →</a> — the anchor text is the strongest signal */
  const anchors = [...text.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ url: unescape(m[1]), label: m[2].replace(/<[^>]+>/g, " ").trim() }))
    .filter(a => /^https?:/i.test(a.url) && !noise.test(a.url) && !bareHome.test(a.url));

  const byLabel = anchors.find(a => /download/i.test(a.label));
  if (byLabel) return byLabel.url;

  const byShape = anchors.find(a => /download|report|export|blob|s3|storage|file/i.test(a.url));
  if (byShape) return byShape.url;

  /* plain text: "Download Report ( https://… )" */
  const bare = [...text.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)].map(m => unescape(m[0]))
    .filter(u => !noise.test(u) && !bareHome.test(u));
  return bare.find(u => /download|report|export|blob|s3|storage|file/i.test(u)) ?? bare[0] ?? null;
}

/*
 * Where a report may legitimately come from.
 *
 * Anyone who learns the webhook address could post a fake email pointing at a
 * spreadsheet of their own and move the pool. So the file has to come from
 * SmartMoving or the cloud storage it serves downloads from — checked against
 * the host the download finally lands on, after any click-tracking redirects,
 * not the host written in the email. REPORT_LINK_HOSTS adds to the list.
 */
const DEFAULT_HOSTS = [
  "smartmoving.com", "amazonaws.com", "blob.core.windows.net",
  "storage.googleapis.com", "cloudfront.net"
];

export function allowedReportHost(hostname) {
  const extra = (process.env.REPORT_LINK_HOSTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const h = String(hostname ?? "").toLowerCase();
  return [...DEFAULT_HOSTS, ...extra].some(d => h === d || h.endsWith("." + d));
}

const MAX_REPORT_BYTES = 5 * 1024 * 1024;   // the real one is about 6 KB

/**
 * Follow the link and parse. The link is signed — no credentials needed.
 * Returns the parsed months and the host it actually came from.
 */
export async function fetchReport(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
      headers: { "user-agent": "ImmediateMovers-RevenueShare/1.0" }
    });
  } catch (e) {
    throw new Error(`could not reach the report link: ${e.cause?.code || e.message}`);
  }

  const finalHost = new URL(res.url || url).hostname;
  if (!allowedReportHost(finalHost)) {
    throw new Error(`report came from ${finalHost}, which is not SmartMoving — refused`);
  }
  if (!res.ok) {
    throw new Error(res.status === 403 || res.status === 404
      ? `the report link has expired or been removed (${res.status})`
      : `report download failed: ${res.status}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_REPORT_BYTES) throw new Error("the downloaded file is far too large to be the report");
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("the download is not a spreadsheet — the link may have expired");
  }

  /* parseRevenueForecast throws unless the sheet has the Revenue Forecast's
     own columns, so a spreadsheet of the wrong shape cannot slip through */
  return { months: parseRevenueForecast(buf), host: finalHost, bytes: buf.length };
}

export function parseReportFile(path) {
  return parseRevenueForecast(readFileSync(path));
}
