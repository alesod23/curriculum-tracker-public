// Pull the last 7 days of a WhatsApp group, LLM-classify each substantive
// message against active curriculum topics, write the results into the weekly
// sidecar JSON under the current ISO week. (OPTIONAL integration.)
//
// Run: node crawl-wa.mjs            (last 7 days, current week)
//      node crawl-wa.mjs --days 14  (custom window)
//      node crawl-wa.mjs --week 2026-W19  (target a specific week)
//
// Needs WA_DAEMON_DIR + WA_GROUP_JID + CURRICULUM_HTML_SOURCE set in .env.

import { spawn } from "node:child_process";
import OpenAI from "openai";

import { WA_DAEMON_DIR, WA_GROUP_JID, CURRICULUM_HTML_SOURCE } from "./config.mjs";
import { activeTopics } from "./lib/topics.mjs";
import { classifyBatch } from "./lib/classify.mjs";
import { load, save, isoWeek, weekRange } from "./lib/weekly-store.mjs";

if (!WA_DAEMON_DIR || !WA_GROUP_JID || !CURRICULUM_HTML_SOURCE) {
  console.error("[wa] needs WA_DAEMON_DIR, WA_GROUP_JID and CURRICULUM_HTML_SOURCE set in .env (see .env.example).");
  process.exit(1);
}
const HTML_PATH = CURRICULUM_HTML_SOURCE;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = args.days ?? 7;
  const weekKey = args.week ?? isoWeek(new Date());
  const range = weekRange(new Date());

  console.log(`[wa] crawling WhatsApp group, last ${days} days, week ${weekKey}`);

  const topics = activeTopics(HTML_PATH);
  if (!topics.length) {
    console.log("[wa] no active topics, nothing to classify against — exit");
    return;
  }
  console.log(`[wa] ${topics.length} active topics`);

  const messages = await fetchWaMessages(WA_GROUP_JID, days);
  console.log(`[wa] fetched ${messages.length} raw messages`);

  const items = messages
    .filter((m) => substantive(m))
    .map((m) => ({
      text: `From ${m.sender || "unknown"} on ${m.iso?.slice(0, 10)}: ${m.text}`,
      raw: m,
    }));
  console.log(`[wa] ${items.length} substantive items after filter`);

  if (!items.length) {
    await writeEmpty(weekKey, range);
    return;
  }

  const openai = new OpenAI();
  const matches = await classifyBatch(items, topics, openai);
  console.log(`[wa] ${matches.length} matches`);

  const byTopic = new Map();
  for (const m of matches) {
    if (!byTopic.has(m.topic_id)) byTopic.set(m.topic_id, []);
    byTopic.get(m.topic_id).push({
      ts: m.item.raw.iso,
      from: m.item.raw.sender,
      text: m.item.raw.text,
      evidence_quote: m.evidence_quote,
      why: m.why_it_matters,
    });
  }

  const cdtmEng = [];
  for (const [topic_id, examples] of byTopic.entries()) {
    const t = topics.find((x) => x.id === topic_id);
    if (!t) continue;
    examples.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
    cdtmEng.push({
      topic_id,
      topic_title: t.title,
      phase_title: t.phase_title,
      examples: examples.slice(0, 5),
    });
  }
  cdtmEng.sort((a, b) => a.topic_title.localeCompare(b.topic_title));

  const data = await load();
  if (!data.weeks[weekKey]) data.weeks[weekKey] = {};
  const w = data.weeks[weekKey];
  w.range_start = range.start;
  w.range_end = range.end;
  w.cdtm_eng = cdtmEng;
  w.cdtm_eng_generated_at = new Date().toISOString();
  await save(data);
  console.log(`[wa] wrote week ${weekKey} with ${cdtmEng.length} topics`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") out.days = Number(argv[++i]);
    else if (argv[i] === "--week") out.week = argv[++i];
  }
  return out;
}

function substantive(m) {
  if (!m.text || typeof m.text !== "string") return false;
  const t = m.text.trim();
  if (t.length < 60) return false;
  if (/^https?:\/\/\S+$/.test(t)) return false;
  return true;
}

async function fetchWaMessages(jid, days) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "node",
      ["search.js", "--chat", jid, "--days", String(days), "--max", "1000", "--force", "--json"],
      { cwd: WA_DAEMON_DIR }
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (b) => (out += b.toString()));
    proc.stderr.on("data", (b) => (err += b.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`wa search exit ${code}: ${err}`));
      try {
        const parsed = JSON.parse(out);
        resolve(parsed.messages || []);
      } catch (e) {
        reject(new Error(`wa search parse: ${e.message}\n${out.slice(0, 300)}`));
      }
    });
  });
}

async function writeEmpty(weekKey, range) {
  const data = await load();
  if (!data.weeks[weekKey]) data.weeks[weekKey] = {};
  data.weeks[weekKey].range_start = range.start;
  data.weeks[weekKey].range_end = range.end;
  data.weeks[weekKey].cdtm_eng = [];
  data.weeks[weekKey].cdtm_eng_generated_at = new Date().toISOString();
  await save(data);
}

main().catch((e) => {
  console.error("[wa] fatal:", e);
  process.exit(1);
});
