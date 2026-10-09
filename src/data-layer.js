/**
 * Data layer for Daily Ops Briefing.
 *
 * Two interchangeable sources:
 *   1. Google Sheet  (set GOOGLE_SHEET_ID + GOOGLE_API_KEY) - the business owner
 *      edits their normal spreadsheet and the briefing reflects it, no JSON.
 *   2. Local file    data/business.json (default, used for demos/tests)
 *
 * Expected sheet tabs (first row = headers):
 *   Business:   key | value            (name, owner_name, timezone, currency)
 *   Leads:      id | company | contact | status | last_event | next_step | next_step_due
 *   Followups:  id | what | due | done
 *   Revenue:    date | sales | amount
 *   Products:   name | price | copies_last_7_days
 *
 * Writes: voice tools (add_followup, log_sale, mark_followup_done) write back
 * to the Sheet via the same key (works when the Sheet's sharing is set to
 * "Anyone with the link can edit"). If the write-back fails, the change is
 * kept in the local snapshot and the response says so - never crashes.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "data", "business.json");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const API_KEY = process.env.GOOGLE_API_KEY;
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const CACHE_TTL_MS = 60_000; // re-fetch the sheet at most once a minute

let cache = { data: null, at: 0 };

export const sheetsConfigured = () => Boolean(SHEET_ID && API_KEY);
export const dataSource = () => (sheetsConfigured() ? "google_sheets" : "local_file");

/* ---------- Google Sheets ---------- */

const num = (v) => (v === "" || v === undefined || v === null ? 0 : Number(v) || 0);
const str = (v) => (v === undefined || v === null ? "" : String(v));

async function fetchTab(tab) {
  const url = `${SHEETS_BASE}/${SHEET_ID}/values/${encodeURIComponent(tab)}?key=${API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Sheets API ${tab}: ${resp.status} ${await resp.text()}`);
  const body = await resp.json();
  return (body.values || []).slice(1); // drop header row
}

async function fetchSheetData() {
  const [businessRows, leadRows, followupRows, revenueRows, productRows] = await Promise.all(
    ["Business", "Leads", "Followups", "Revenue", "Products"].map(fetchTab)
  );

  const business = {};
  for (const [k, v] of businessRows) business[str(k)] = str(v);

  return {
    business: {
      name: business.name || "My Business",
      owner_name: business.owner_name || "",
      timezone: business.timezone || "UTC",
      currency: business.currency || "USD",
    },
    leads: leadRows.map((r) => ({
      id: str(r[0]),
      company: str(r[1]),
      contact: str(r[2]),
      status: str(r[3]).toLowerCase(),
      last_event: str(r[4]),
      next_step: str(r[5]),
      next_step_due: str(r[6]),
    })),
    followups: followupRows.map((r) => ({
      id: str(r[0]),
      what: str(r[1]),
      due: str(r[2]),
      done: /^(true|yes|done|1)$/i.test(str(r[3])),
    })),
    revenue: {
      last_7_days: revenueRows
        .filter((r) => str(r[0]))
        .map((r) => ({ date: str(r[0]), sales: num(r[1]), amount: num(r[2]) })),
    },
    products: productRows.map((r) => ({
      name: str(r[0]),
      price: num(r[1]),
      copies_last_7_days: num(r[2]),
    })),
  };
}

async function sheetAppend(tab, row) {
  const range = `${encodeURIComponent(tab)}!A:${String.fromCharCode(65 + row.length - 1)}`;
  const url = `${SHEETS_BASE}/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&key=${API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!resp.ok) throw new Error(`Sheets append ${tab}: ${resp.status}`);
}

async function sheetMarkDone(id) {
  // Find the row (1-based sheet row = index + 2 for header), then set its done column.
  const rows = await fetchTab("Followups");
  const idx = rows.findIndex((r) => str(r[0]) === String(id));
  if (idx === -1) throw new Error(`Follow-up ${id} not found in Sheet`);
  const url = `${SHEETS_BASE}/${SHEET_ID}/values/Followups!D${idx + 2}?valueInputOption=USER_ENTERED&key=${API_KEY}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: [["TRUE"]] }),
  });
  if (!resp.ok) throw new Error(`Sheets update: ${resp.status}`);
}

/* ---------- Unified access ---------- */

export async function loadData() {
  if (!sheetsConfigured()) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const data = await fetchSheetData();
  cache = { data, at: Date.now() };
  // Keep a local snapshot so writes still work if the Sheet is temporarily unreachable.
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch { /* read-only filesystem (e.g. Lambda) - snapshot optional */ }
  return data;
}

export function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  cache = { data: null, at: 0 }; // invalidate so the next read is fresh
}

/** Try a Sheet write-back. Returns true if synced, false otherwise. */
export async function sheetWrite(kind, payload) {
  if (!sheetsConfigured()) return false;
  try {
    if (kind === "append") await sheetAppend(payload.tab, payload.row);
    else if (kind === "mark_done") await sheetMarkDone(payload.id);
    else throw new Error(`Unknown sheet write: ${kind}`);
    cache = { data: null, at: 0 };
    return true;
  } catch (err) {
    console.error("Sheet write-back failed:", err.message);
    return false;
  }
}
