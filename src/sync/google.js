/* Minimal Google service-account client — auth plus the few Sheets calls we
 * need. Written against node:crypto rather than pulling in googleapis, which
 * is a very large dependency for reading a handful of cells and writing one
 * tab. The whole protocol here is: sign a JWT, swap it for an access token,
 * use the token.
 *
 * The credentials never appear in a log or an error message. They arrive as
 * a JSON blob in GOOGLE_SERVICE_ACCOUNT_JSON (Render env var) or, locally,
 * as a file path in GOOGLE_SERVICE_ACCOUNT_FILE.
 */

import { createSign } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE  = "https://www.googleapis.com/drive/v3";

/* Sheets to read and write our tabs; Drive read-only to find the weekly hours
   exports, which arrive as a new file each week rather than one standing tab. */
const SCOPE = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly"
].join(" ");

const b64url = buf =>
  Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export function loadCredentials() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const path   = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  let raw;
  if (inline && inline.trim().startsWith("{")) raw = inline;
  else if (path && existsSync(path)) raw = readFileSync(path, "utf8");
  else return null;

  let creds;
  try { creds = JSON.parse(raw); }
  catch { throw new Error("service account credentials are not valid JSON"); }

  if (creds.type !== "service_account") {
    throw new Error(
      'that is not a service account key — it should start {"type":"service_account"}. ' +
      "An OAuth client ID will not work here: nobody is awake at 2am to approve it.");
  }
  if (!creds.private_key || !creds.client_email) {
    throw new Error("service account key is missing private_key or client_email");
  }
  return creds;
}

export function createGoogleClient(creds = loadCredentials()) {
  if (!creds) throw new Error("no Google credentials configured");

  let token = null, expires = 0;

  async function accessToken() {
    if (token && Date.now() < expires - 60_000) return token;

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = b64url(JSON.stringify({
      iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL,
      iat: now, exp: now + 3600
    }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claim}`);
    const jwt = `${header}.${claim}.${b64url(signer.sign(creds.private_key))}`;

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt
      })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      /* Say what to do about it. These two are the failures people actually hit. */
      const hint = body.error === "invalid_grant"
        ? " — the key may have been deleted or the clock is out of step"
        : /disabled|not been used/i.test(body.error_description || "")
        ? " — enable the Google Sheets API on this project"
        : "";
      throw new Error(`Google auth failed: ${body.error || res.status}${hint}`);
    }
    token = body.access_token;
    expires = Date.now() + (body.expires_in ?? 3600) * 1000;
    return token;
  }

  async function driveCall(path) {
    const res = await fetch(DRIVE + path, {
      headers: { authorization: `Bearer ${await accessToken()}` }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error?.message || `HTTP ${res.status}`;
      if (/has not been used|disabled/i.test(msg)) {
        throw new Error(`${msg} — enable the Google Drive API on this project`);
      }
      if (res.status === 403) {
        throw new Error(`${msg} — share the folder with ${creds.client_email}`);
      }
      throw new Error(msg);
    }
    return body;
  }

  async function call(path, opts = {}) {
    const res = await fetch(SHEETS + path, {
      ...opts,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "application/json",
        ...(opts.headers || {})
      }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error?.message || `HTTP ${res.status}`;
      if (res.status === 403) {
        throw new Error(`${msg} — share the sheet with ${creds.client_email} as an Editor`);
      }
      throw new Error(msg);
    }
    return body;
  }

  return {
    email: creds.client_email,

    /**
     * Spreadsheets we can see, newest first. Pass a folderId to look in one
     * place, or namePrefix to match on title — the weekly hours exports are
     * named Movers_Hours_<from>_<to>, so the prefix is enough to find them
     * wherever they sit.
     */
    async listSpreadsheets({ folderId, namePrefix, limit = 100 } = {}) {
      const terms = ["mimeType='application/vnd.google-apps.spreadsheet'", "trashed=false"];
      if (folderId) terms.push(`'${folderId}' in parents`);
      if (namePrefix) terms.push(`name contains '${String(namePrefix).replace(/'/g, "\\'")}'`);

      const params = new URLSearchParams({
        q: terms.join(" and "),
        fields: "files(id,name,modifiedTime,owners(emailAddress))",
        orderBy: "name desc",
        pageSize: String(Math.min(limit, 200)),
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true"
      });
      const r = await driveCall(`/files?${params}`);
      return r.files || [];
    },

    /** Tab names and ids. */
    async info(spreadsheetId) {
      const r = await call(`/${spreadsheetId}?fields=properties.title,sheets.properties`);
      return {
        title: r.properties?.title,
        tabs: (r.sheets || []).map(s => ({
          id: s.properties.sheetId,
          title: s.properties.title,
          rows: s.properties.gridProperties?.rowCount,
          cols: s.properties.gridProperties?.columnCount
        }))
      };
    },

    /**
     * Read a range. Missing trailing cells come back short.
     *
     * By default Sheets returns what a person sees, so a currency-formatted
     * cell arrives as "$2,566.68" rather than 2566.68. Pass raw:true when the
     * caller wants the number — otherwise the formatting silently becomes part
     * of the value.
     */
    async read(spreadsheetId, range, { raw = false } = {}) {
      const q = raw ? "?valueRenderOption=UNFORMATTED_VALUE" : "";
      const r = await call(`/${spreadsheetId}/values/${encodeURIComponent(range)}${q}`);
      return r.values || [];
    },

    /** Overwrite a range. */
    async write(spreadsheetId, range, values) {
      return call(
        `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        { method: "PUT", body: JSON.stringify({ values }) });
    },

    async clear(spreadsheetId, range) {
      return call(`/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, { method: "POST" });
    },

    /** Create a tab if it isn't already there. Returns true if it made one. */
    async ensureTab(spreadsheetId, title, { rows = 500, cols = 8 } = {}) {
      const { tabs } = await this.info(spreadsheetId);
      if (tabs.some(t => t.title === title)) return false;
      await call(`/${spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [{ addSheet: {
          properties: { title, gridProperties: { rowCount: rows, columnCount: cols, frozenRowCount: 1 } }
        }}]})
      });
      return true;
    },

    /** Raw batchUpdate, for formatting. Requests are the Sheets API's own shape. */
    async batchUpdate(spreadsheetId, requests) {
      if (!requests.length) return null;
      return call(`/${spreadsheetId}:batchUpdate`, {
        method: "POST", body: JSON.stringify({ requests })
      });
    },

    async tabId(spreadsheetId, title) {
      const { tabs } = await this.info(spreadsheetId);
      return tabs.find(t => t.title === title)?.id ?? null;
    },

    /** Bold the header row and widen the first column — small, but it is a
        sheet a person opens and types into every week. */
    async formatHeader(spreadsheetId, title) {
      const { tabs } = await this.info(spreadsheetId);
      const tab = tabs.find(t => t.title === title);
      if (!tab) return;
      await call(`/${spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [
          { repeatCell: {
              range: { sheetId: tab.id, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 } } },
              fields: "userEnteredFormat(textFormat,backgroundColor)" } },
          { updateDimensionProperties: {
              range: { sheetId: tab.id, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
              properties: { pixelSize: 200 }, fields: "pixelSize" } }
        ]})
      });
    }
  };
}
