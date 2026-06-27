// Read/write the weekly learnings sidecar JSON.
//
// Path comes from WEEKLY_STORE_PATH (config) — defaults to a local file under
// data/. Override via .env to store it elsewhere.
//
// Layout:
//   { weeks: { "<YYYY-Www>": { ... } },
//     saved_moments_inbox: [...] }

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { WEEKLY_STORE_PATH } from "../config.mjs";

export const WEEKLY_PATH = WEEKLY_STORE_PATH;

export async function load(path = WEEKLY_PATH) {
  if (!existsSync(path)) {
    return { weeks: {}, saved_moments_inbox: [] };
  }
  const raw = await readFile(path, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.weeks) parsed.weeks = {};
    if (!Array.isArray(parsed.saved_moments_inbox)) parsed.saved_moments_inbox = [];
    return parsed;
  } catch {
    return { weeks: {}, saved_moments_inbox: [] };
  }
}

export async function save(data, path = WEEKLY_PATH) {
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

// ISO week key for a date: e.g. 2026-W20.
// Week starts Monday, ISO 8601.
export function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

// Range Monday..Sunday for the ISO week containing `d` (local time).
export function weekRange(d = new Date()) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay() || 7; // 1..7
  const monday = new Date(date);
  monday.setDate(date.getDate() - (day - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: ymd(monday), end: ymd(sunday), startDate: monday, endDate: sunday };
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
