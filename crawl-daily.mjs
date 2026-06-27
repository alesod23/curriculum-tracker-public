// Daily WhatsApp-group crawl -> inbox backlog. (OPTIONAL integration.)
//
// Pulls recent messages from a WhatsApp group (via a local WhatsApp daemon's
// search.js), LLM-classifies each substantive message against ALL curriculum
// topics, and appends matches to data/inbox.json as PENDING items. The web
// app's Backlog tab is where the user approves (message becomes an example
// under its topic) or dismisses.
//
// Idempotent: dedups on (message ts + sender + topic_id) against everything
// already in the inbox, so overlapping windows are safe.
//
// Needs WA_DAEMON_DIR + WA_GROUP_JID set in .env (see .env.example).
//
// Run: node crawl-daily.mjs            (last 2 days — overlap covers missed runs)
//      node crawl-daily.mjs --days 7

import { spawn } from "node:child_process";
import OpenAI from "openai";

import { WA_DAEMON_DIR, WA_GROUP_JID } from "./config.mjs";
import { classifyDaily } from "./lib/classify-daily.mjs";
import { loadCurriculum, loadInbox, saveInbox, allTopics, genId } from "./lib/store.mjs";

if (!WA_DAEMON_DIR || !WA_GROUP_JID) {
  console.error("[daily] WhatsApp crawler needs WA_DAEMON_DIR and WA_GROUP_JID set in .env (see .env.example).");
  process.exit(1);
}

const args = process.argv.slice(2);
const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 2;

const curriculum = await loadCurriculum();
if (!curriculum) {
  console.error("[daily] data/curriculum.json missing — copy data/curriculum.example.json to data/curriculum.json (or build topics first)");
  process.exit(1);
}
const topics = allTopics(curriculum);
console.log(`[daily] ${topics.length} topics, crawling last ${days} day(s)`);

const messages = await fetchWaMessages(WA_GROUP_JID, days);
console.log(`[daily] ${messages.length} raw messages`);

const items = messages
  .filter(substantive)
  .map((m) => ({
    text: `From ${m.sender || "unknown"} on ${m.iso?.slice(0, 10)}: ${m.text}`,
    raw: m,
  }));
console.log(`[daily] ${items.length} substantive after filter`);

const inbox = await loadInbox();
const seen = new Set(inbox.items.map((it) => dedupKey(it.ts, it.from, it.topic_id)));

let added = 0;
if (items.length) {
  const matches = await classifyDaily(items, topics, new OpenAI());
  console.log(`[daily] ${matches.length} topic matches`);
  for (const m of matches) {
    const raw = m.item.raw;
    const key = dedupKey(raw.iso, raw.sender, m.topic_id);
    if (seen.has(key)) continue;
    seen.add(key);
    const t = topics.find((x) => x.id === m.topic_id);
    inbox.items.push({
      id: genId("ib"),
      ts: raw.iso || null,
      from: raw.sender || "unknown",
      text: raw.text,
      topic_id: m.topic_id,
      topic_title: t?.title || m.topic_id,
      phase_title: t?.phase_title || "",
      evidence_quote: m.evidence_quote,
      why: m.why_it_matters,
      status: "pending", // pending | approved | dismissed
      crawled_at: new Date().toISOString(),
    });
    added++;
  }
}

inbox.last_crawl_at = new Date().toISOString();
await saveInbox(inbox);
const pending = inbox.items.filter((i) => i.status === "pending").length;
console.log(`[daily] +${added} new items, ${pending} pending in backlog`);

function dedupKey(ts, from, topicId) {
  return `${ts || ""}|${from || ""}|${topicId}`;
}

function substantive(m) {
  if (!m.text || typeof m.text !== "string") return false;
  const t = m.text.trim();
  if (t.length < 60) return false;
  if (/^https?:\/\/\S+$/.test(t)) return false;
  return true;
}

function fetchWaMessages(jid, days) {
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
        resolve(JSON.parse(out).messages || []);
      } catch (e) {
        reject(new Error(`wa search parse: ${e.message}\n${out.slice(0, 300)}`));
      }
    });
  });
}
