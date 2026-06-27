// Ingest one of your own projects as curriculum material.
//
// Mines BOTH the project's handmade source code AND the Claude Code build-session
// transcript(s), classifies every excerpt against all curriculum topics, and
// appends the matches to the backlog as PENDING items tagged with the project
// (kind:"project") — they land in that project's own backlog section, NOT
// straight into the curriculum. You review/approve them there.
//
// Usage:
//   node ingest-project.mjs --path <dir> [--name <name>] [--session <jsonl> ...] [--code-only]
//
// The /sde skill normally fills these in (resolves the path + finds the build
// sessions), but it runs fine standalone.

import path from "node:path";
import { existsSync } from "node:fs";
import OpenAI from "openai";

import "./config.mjs";
import { collectCodeFiles, collectSessionSnippets } from "./lib/project-ingest.mjs";
import { classifyProject } from "./lib/classify-project.mjs";
import { loadCurriculum, loadInbox, saveInbox, loadSources, saveSources, allTopics, genId } from "./lib/store.mjs";

const argv = process.argv.slice(2);
function flag(name) { const i = argv.indexOf(name); return i >= 0; }
function val(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
function vals(name) { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === name) out.push(argv[i + 1]); return out; }

const projPath = val("--path");
if (!projPath || !existsSync(projPath)) {
  console.error("[cs] --path <existing project dir> required");
  process.exit(1);
}
const name = val("--name") || path.basename(projPath.replace(/[\\/]+$/, ""));
const sessions = vals("--session").filter(Boolean);
const codeOnly = flag("--code-only");

const curriculum = await loadCurriculum();
if (!curriculum) { console.error("[cs] curriculum.json missing"); process.exit(1); }
const topics = allTopics(curriculum);

console.log(`[cs] project "${name}" at ${projPath}`);
const codeItems = collectCodeFiles(projPath);
console.log(`[cs] ${codeItems.length} source files`);
let sessionItems = [];
if (!codeOnly && sessions.length) {
  sessionItems = collectSessionSnippets(sessions);
  console.log(`[cs] ${sessionItems.length} session excerpts from ${sessions.length} transcript(s)`);
} else if (!codeOnly) {
  console.log(`[cs] no --session given; code only this run`);
}

const items = [...codeItems, ...sessionItems];
if (!items.length) { console.error("[cs] nothing to ingest"); process.exit(1); }

const matches = await classifyProject(items, topics, new OpenAI());
console.log(`[cs] ${matches.length} topic matches across ${items.length} excerpts`);

const inbox = await loadInbox();
// Dedup against everything already in the backlog by (project, origin, topic).
const seen = new Set(inbox.items.map((i) => `${i.project || ""}|${i.origin || ""}|${i.topic_id}`));
let added = 0;
for (const m of matches) {
  const key = `${name}|${m.item.origin}|${m.topic_id}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const t = topics.find((x) => x.id === m.topic_id);
  inbox.items.push({
    id: genId("ib"),
    kind: "project",
    project: name,
    origin: m.item.origin,
    ts: null,
    from: m.item.origin,
    text: m.evidence_quote || m.item.text.slice(0, 240),
    topic_id: m.topic_id,
    topic_title: t?.title || m.topic_id,
    phase_title: t?.phase_title || "",
    evidence_quote: m.evidence_quote,
    why: m.why_it_matters,
    status: "pending",
    crawled_at: new Date().toISOString(),
  });
  added++;
}
await saveInbox(inbox);

const sources = await loadSources();
const existing = sources.projects.find((p) => p.name === name);
const rec = existing || { name, path: projPath, created_at: new Date().toISOString() };
rec.path = projPath;
rec.last_ingest_at = new Date().toISOString();
rec.sessions = Array.from(new Set([...(rec.sessions || []), ...sessions]));
rec.code_files = codeItems.length;
rec.last_added = added;
if (!existing) sources.projects.push(rec);
await saveSources(sources);

const pendingForProject = inbox.items.filter((i) => i.project === name && i.status === "pending").length;
console.log(`[cs] +${added} new backlog items for "${name}" (${pendingForProject} pending in its section)`);
