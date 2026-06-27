// Crawl Claude Code session JSONL transcripts from the last N days, build a
// short per-session digest (what the user was working on + key user prompts),
// LLM-classify each digest against active curriculum topics, write into the
// weekly sidecar JSON under "your_work".
//
// Run: node crawl-sessions.mjs              (last 7 days, current week)
//      node crawl-sessions.mjs --days 7 --week 2026-W20

import { readdir, stat, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import OpenAI from "openai";

import { CLAUDE_PROJECTS_DIR, CURRICULUM_HTML_SOURCE } from "./config.mjs";
import { activeTopics } from "./lib/topics.mjs";
import { classifyBatch } from "./lib/classify.mjs";
import { load, save, isoWeek, weekRange } from "./lib/weekly-store.mjs";

if (!CLAUDE_PROJECTS_DIR || !CURRICULUM_HTML_SOURCE) {
  console.error("[sessions] needs CLAUDE_PROJECTS_DIR and CURRICULUM_HTML_SOURCE set in .env (see .env.example).");
  process.exit(1);
}
const HTML_PATH = CURRICULUM_HTML_SOURCE;
const SESSIONS_DIR = CLAUDE_PROJECTS_DIR;

const MAX_USER_PROMPTS_PER_SESSION = 8;
const MAX_USER_PROMPT_CHARS = 280;
const MAX_FIRST_ASSISTANT_CHARS = 600;
const NOISE_PREFIXES = [
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<system-reminder>",
  "Caveat: The messages below",
  "<bash-input>",
  "<bash-stdout>",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = args.days ?? 7;
  const weekKey = args.week ?? isoWeek(new Date());
  const range = weekRange(new Date());

  console.log(`[sessions] crawling last ${days} days, week ${weekKey}`);

  const topics = activeTopics(HTML_PATH);
  if (!topics.length) {
    console.log("[sessions] no active topics — exit");
    return;
  }
  console.log(`[sessions] ${topics.length} active topics`);

  const cutoff = Date.now() - days * 86400 * 1000;
  const files = await readdir(SESSIONS_DIR);
  const recent = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const full = path.join(SESSIONS_DIR, f);
    const s = await stat(full);
    if (s.mtimeMs >= cutoff) recent.push({ path: full, mtime: s.mtimeMs });
  }
  recent.sort((a, b) => a.mtime - b.mtime);
  console.log(`[sessions] ${recent.length} recent sessions`);

  const digests = [];
  for (const { path: p } of recent) {
    const d = await digestSession(p);
    if (d && d.userPrompts.length) digests.push(d);
  }
  console.log(`[sessions] ${digests.length} non-empty digests`);

  if (!digests.length) {
    await writeEmpty(weekKey, range);
    return;
  }

  const items = digests.map((d) => ({
    text: formatDigest(d),
    raw: d,
  }));

  const openai = new OpenAI();
  const matches = await classifyBatch(items, topics, openai);
  console.log(`[sessions] ${matches.length} matches`);

  const byTopic = new Map();
  for (const m of matches) {
    if (!byTopic.has(m.topic_id)) byTopic.set(m.topic_id, []);
    byTopic.get(m.topic_id).push({
      session_id: m.item.raw.sessionId,
      started_at: m.item.raw.startedAt,
      cwd: m.item.raw.cwd,
      first_prompt: m.item.raw.userPrompts[0] || "",
      evidence_quote: m.evidence_quote,
      why: m.why_it_matters,
    });
  }

  const yourWork = [];
  for (const [topic_id, sessions] of byTopic.entries()) {
    const t = topics.find((x) => x.id === topic_id);
    if (!t) continue;
    sessions.sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
    yourWork.push({
      topic_id,
      topic_title: t.title,
      phase_title: t.phase_title,
      sessions: sessions.slice(0, 5),
    });
  }
  yourWork.sort((a, b) => a.topic_title.localeCompare(b.topic_title));

  const data = await load();
  if (!data.weeks[weekKey]) data.weeks[weekKey] = {};
  const w = data.weeks[weekKey];
  w.range_start = range.start;
  w.range_end = range.end;
  w.your_work = yourWork;
  w.your_work_generated_at = new Date().toISOString();
  await save(data);
  console.log(`[sessions] wrote week ${weekKey} with ${yourWork.length} topics`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") out.days = Number(argv[++i]);
    else if (argv[i] === "--week") out.week = argv[++i];
  }
  return out;
}

async function digestSession(filePath) {
  const sessionId = path.basename(filePath, ".jsonl");
  let startedAt = null;
  let cwd = null;
  const userPrompts = [];
  let firstAssistant = null;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!startedAt && rec.timestamp) startedAt = rec.timestamp;
    if (!cwd && rec.cwd) cwd = rec.cwd;

    if (rec.type === "user" && rec.message && rec.message.role === "user") {
      const content = rec.message.content;
      const text = typeof content === "string" ? content : extractTextBlocks(content);
      if (!text) continue;
      if (NOISE_PREFIXES.some((p) => text.startsWith(p))) continue;
      if (rec.isMeta) continue;
      const trimmed = text.trim().slice(0, MAX_USER_PROMPT_CHARS);
      if (trimmed.length < 8) continue;
      userPrompts.push(trimmed);
      if (userPrompts.length >= MAX_USER_PROMPTS_PER_SESSION) {
        // keep reading to find assistant if we still don't have one
      }
    } else if (
      !firstAssistant &&
      rec.type === "assistant" &&
      rec.message &&
      rec.message.role === "assistant"
    ) {
      const text = extractTextBlocks(rec.message.content);
      if (text) firstAssistant = text.trim().slice(0, MAX_FIRST_ASSISTANT_CHARS);
    }
  }

  return { sessionId, startedAt, cwd, userPrompts, firstAssistant };
}

function extractTextBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n").trim();
}

function formatDigest(d) {
  const cwdLabel = d.cwd ? ` (cwd: ${d.cwd})` : "";
  const startLabel = d.startedAt ? d.startedAt.slice(0, 10) : "unknown date";
  const prompts = d.userPrompts.map((p, i) => `  USER[${i}]: ${p}`).join("\n");
  const assistant = d.firstAssistant ? `\n  FIRST_ASSISTANT: ${d.firstAssistant}` : "";
  return `SESSION ${startLabel}${cwdLabel}\n${prompts}${assistant}`;
}

async function writeEmpty(weekKey, range) {
  const data = await load();
  if (!data.weeks[weekKey]) data.weeks[weekKey] = {};
  data.weeks[weekKey].range_start = range.start;
  data.weeks[weekKey].range_end = range.end;
  data.weeks[weekKey].your_work = [];
  data.weeks[weekKey].your_work_generated_at = new Date().toISOString();
  await save(data);
}

main().catch((e) => {
  console.error("[sessions] fatal:", e);
  process.exit(1);
});
