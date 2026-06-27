// Curriculum web app server (v2, 2026-06-11).
//
// v1 served a hand-edited HTML file. v2 is data-driven:
// curriculum lives in data/curriculum.json, the UI is app.html (vanilla JS),
// and an optional daily WhatsApp-group crawl feeds an approval backlog whose
// approved messages become per-topic examples.
//
// The per-topic tutor chat lets the user steer each explanation; committing a
// chat updates that topic's lesson and saves durable "context" (preferences /
// instructions) scoped to the topic or to all topics, replayed into every later
// tutor turn and every /btw.
//
//   GET  /                       — app.html
//   GET  /api/curriculum         — full curriculum JSON
//   POST /api/topic/status       — { topic_id, status }
//   POST /api/topic/lesson       — { topic_id, lesson } manual edit (markdown def)
//   POST /api/topic/undo         — { topic_id } revert last change to a topic
//   GET  /api/notes              — sidecar notes JSON
//   POST /api/note               — { topic_id, content, topic_title }
//   DELETE /api/note             — { topic_id, note_id }
//   GET  /api/inbox              — backlog (pending first; WA + project items)
//   POST /api/inbox/action       — { ids: [..], action: "approve"|"dismiss" }
//   GET  /api/sources            — ingested projects + per-project topic coverage
//   POST /api/crawl              — run crawl-daily.mjs now
//   POST /api/videos/refresh     — run fetch-videos.mjs (fire-and-forget)
//   GET  /api/chat?topic_id=     — saved tutor chat for a topic
//   POST /api/chat               — { topic_id, message } -> tutor reply
//   POST /api/chat/commit        — { topic_id, instruction? } -> apply lesson edits + save context
//   POST /api/chat/clear         — { topic_id } -> wipe that topic's chat
//   DELETE /api/context          — { topic_id|null, note_id } -> drop a saved context note
//   GET  /api/quiz?topic_id=     — quiz transcript + strength for a topic
//   POST /api/quiz/start         — { topic_id } -> first question
//   POST /api/quiz/message       — { topic_id, message } -> next question/hint
//   POST /api/quiz/grade         — { topic_id } -> score + save topic.strength
//   POST /api/quiz/clear         — { topic_id }
//   /weekly + weekly API         — unchanged from v1
//
// Run: node server.mjs   (or start.ps1)   URL: localhost:4117

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, watch as watchSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadWeekly, save as saveWeekly, isoWeek } from "./lib/weekly-store.mjs";
import {
  loadCurriculum, saveCurriculum, loadInbox, saveInbox,
  loadNotes, saveNotes, loadChats, saveChats,
  loadQuizChats, saveQuizChats, loadSources,
  loadUndo, saveUndo, pushUndo, findTopic, genId,
} from "./lib/store.mjs";
import { chatReply, commitChat } from "./lib/chat.mjs";
import { quizQuestion, quizReply, quizGrade } from "./lib/quiz.mjs";
import { getClient } from "./lib/llm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4117;
const APP_HTML_PATH = path.join(__dirname, "app.html");
const WEEKLY_HTML_PATH = path.join(__dirname, "weekly.html");

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
};

const LIVE_RELOAD = `
<script>
(function () {
  try {
    const es = new EventSource("/events");
    es.addEventListener("reload", () => location.reload());
    es.onerror = () => {};
  } catch (e) {}
})();
</script>`;

const clients = new Set();
function broadcastReload() {
  for (const res of clients) {
    try { res.write("event: reload\ndata: 1\n\n"); } catch (e) {}
  }
}
if (existsSync(APP_HTML_PATH)) {
  let debounce = null;
  watchSync(APP_HTML_PATH, () => {
    clearTimeout(debounce);
    debounce = setTimeout(broadcastReload, 200);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json", ...NO_CACHE });
  res.end(JSON.stringify(data));
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let crawlRunning = false;
let videosRunning = false;

const server = createServer(async (req, res) => {
  const url = req.url || "/";
  const method = req.method || "GET";

  try {
    // ---- SSE live reload ----
    if (url === "/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain", ...NO_CACHE });
      res.end("ok");
      return;
    }

    // ---- curriculum ----
    if (url === "/api/curriculum" && method === "GET") {
      const c = await loadCurriculum();
      if (!c) return json(res, 500, { error: "curriculum.json missing — run migrate.mjs" });
      const undo = await loadUndo();
      for (const phase of c.phases) for (const t of phase.topics) t.undo_count = (undo[t.id] || []).length;
      return json(res, 200, c);
    }

    if (url === "/api/topic/status" && method === "POST") {
      const { topic_id, status } = await readBody(req);
      if (!topic_id || !["untouched", "introduced", "mastered"].includes(status)) {
        return json(res, 400, { error: "topic_id and valid status required" });
      }
      const c = await loadCurriculum();
      const hit = findTopic(c, topic_id);
      if (!hit) return json(res, 404, { error: "topic not found" });
      hit.topic.status = status;
      hit.topic.history.push({ date: todayIso(), action: status, note: "set from web app" });
      await saveCurriculum(c);
      return json(res, 200, { ok: true, topic: hit.topic });
    }

    // ---- manual lesson edit ----
    if (url === "/api/topic/lesson" && method === "POST") {
      const { topic_id, lesson } = await readBody(req);
      if (!topic_id || typeof lesson !== "object" || lesson === null) {
        return json(res, 400, { error: "topic_id and lesson object required" });
      }
      const c = await loadCurriculum();
      const hit = findTopic(c, topic_id);
      if (!hit) return json(res, 404, { error: "topic not found" });
      const undo = await loadUndo();
      pushUndo(undo, hit.topic, "manual lesson edit");
      const clean = { def: typeof lesson.def === "string" ? lesson.def : "" };
      if (lesson.example && typeof lesson.example.code === "string" && lesson.example.code.trim()) {
        clean.example = { code: lesson.example.code, purpose: String(lesson.example.purpose || "") };
      } else {
        clean.example = null;
      }
      clean.fp = Array.isArray(lesson.fp)
        ? lesson.fp.filter((p) => p && (p.q || p.a)).map((p) => ({ q: String(p.q || ""), a: String(p.a || "") }))
        : [];
      hit.topic.lesson = clean;
      await saveCurriculum(c);
      await saveUndo(undo);
      return json(res, 200, { ok: true, lesson: clean });
    }

    // ---- undo last change to a topic ----
    if (url === "/api/topic/undo" && method === "POST") {
      const { topic_id } = await readBody(req);
      if (!topic_id) return json(res, 400, { error: "topic_id required" });
      const undo = await loadUndo();
      const stack = undo[topic_id] || [];
      if (!stack.length) return json(res, 400, { error: "nothing to undo" });
      const snap = stack.pop();
      const c = await loadCurriculum();
      const hit = findTopic(c, topic_id);
      if (!hit) return json(res, 404, { error: "topic not found" });
      hit.topic.lesson = snap.lesson;
      hit.topic.context = snap.context || [];
      hit.topic.examples = snap.examples || [];
      hit.topic.status = snap.status;
      hit.topic.strength = snap.strength ?? null;
      hit.topic.quizzes = snap.quizzes || [];
      await saveCurriculum(c);
      await saveUndo(undo);
      return json(res, 200, { ok: true, undone: snap.label, remaining: stack.length });
    }

    // ---- notes ----
    if (url === "/api/notes" && method === "GET") {
      return json(res, 200, await loadNotes());
    }

    if (url === "/api/note" && method === "POST") {
      const { topic_id, content, topic_title } = await readBody(req);
      if (!topic_id || !content || typeof content !== "string") {
        return json(res, 400, { error: "topic_id and content required" });
      }
      const notes = await loadNotes();
      const entry = { id: genId("n"), date: todayIso(), topic_title: topic_title || "", content: content.trim() };
      if (!notes[topic_id]) notes[topic_id] = [];
      notes[topic_id].push(entry);
      await saveNotes(notes);
      return json(res, 200, { ok: true, note: entry });
    }

    if (url === "/api/note" && method === "DELETE") {
      const { topic_id, note_id } = await readBody(req);
      if (!topic_id || !note_id) return json(res, 400, { error: "topic_id and note_id required" });
      const notes = await loadNotes();
      if (notes[topic_id]) {
        notes[topic_id] = notes[topic_id].filter((n) => n.id !== note_id);
        if (!notes[topic_id].length) delete notes[topic_id];
        await saveNotes(notes);
      }
      return json(res, 200, { ok: true });
    }

    // ---- inbox / backlog ----
    if (url === "/api/inbox" && method === "GET") {
      const inbox = await loadInbox();
      const order = { pending: 0, approved: 1, dismissed: 2 };
      const items = [...inbox.items].sort(
        (a, b) => (order[a.status] - order[b.status]) || (b.ts || "").localeCompare(a.ts || "")
      );
      return json(res, 200, { ...inbox, items });
    }

    if (url === "/api/inbox/action" && method === "POST") {
      const { ids, action } = await readBody(req);
      if (!Array.isArray(ids) || !ids.length || !["approve", "dismiss"].includes(action)) {
        return json(res, 400, { error: "ids[] and action approve|dismiss required" });
      }
      const inbox = await loadInbox();
      const c = await loadCurriculum();
      const undo = await loadUndo();
      const snapped = new Set();
      let changed = 0;
      for (const id of ids) {
        const item = inbox.items.find((i) => i.id === id);
        if (!item || item.status !== "pending") continue;
        if (action === "approve") {
          const hit = findTopic(c, item.topic_id);
          if (!hit) continue;
          if (!snapped.has(item.topic_id)) { pushUndo(undo, hit.topic, "approved backlog example"); snapped.add(item.topic_id); }
          hit.topic.examples.push({
            id: genId("ex"),
            ts: item.ts,
            from: item.from,
            text: item.text,
            why: item.why,
            approved_at: new Date().toISOString(),
            source: item.project ? item.project : "cdtm-eng",
            project: item.project || null,
            kind: item.kind || "wa",
          });
          item.status = "approved";
        } else {
          item.status = "dismissed";
        }
        changed++;
      }
      if (changed) {
        await saveCurriculum(c);
        await saveInbox(inbox);
        if (action === "approve") await saveUndo(undo);
      }
      return json(res, 200, { ok: true, changed });
    }

    // ---- project sources (per-project view) ----
    if (url === "/api/sources" && method === "GET") {
      const sources = await loadSources();
      const c = await loadCurriculum();
      const inbox = await loadInbox();
      const projects = sources.projects.map((p) => {
        const topics = [];
        for (const phase of c.phases) {
          for (const t of phase.topics) {
            const n = (t.examples || []).filter((e) => e.project === p.name).length;
            if (n) topics.push({ id: t.id, title: t.title, phase_title: phase.title, count: n, strength: t.strength ?? null, status: t.status });
          }
        }
        const pending = inbox.items.filter((i) => i.project === p.name && i.status === "pending").length;
        return { ...p, topics, pending };
      });
      return json(res, 200, { projects });
    }

    // ---- crawl now ----
    if (url === "/api/crawl" && method === "POST") {
      if (crawlRunning) return json(res, 409, { error: "crawl already running" });
      crawlRunning = true;
      try {
        const out = await runScript("crawl-daily.mjs");
        return json(res, 200, { ok: true, output: out });
      } catch (e) {
        return json(res, 500, { error: e.message });
      } finally {
        crawlRunning = false;
      }
    }

    // ---- video refresh (fire-and-forget: 69 topics x ~1.5s) ----
    if (url === "/api/videos/refresh" && method === "POST") {
      if (videosRunning) return json(res, 409, { error: "video fetch already running" });
      videosRunning = true;
      runScript("fetch-videos.mjs")
        .then((out) => console.log("[videos]", out.split("\n").pop()))
        .catch((e) => console.error("[videos] failed:", e.message))
        .finally(() => (videosRunning = false));
      return json(res, 200, { ok: true, started: true });
    }

    // ---- per-topic tutor chat ----
    if (url.startsWith("/api/chat") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const topicId = u.searchParams.get("topic_id");
      if (!topicId) return json(res, 400, { error: "topic_id required" });
      const chats = await loadChats();
      return json(res, 200, { topic_id: topicId, history: chats[topicId] || [] });
    }

    if (url === "/api/chat" && method === "POST") {
      const { topic_id, message } = await readBody(req);
      if (!topic_id || !message || !String(message).trim()) {
        return json(res, 400, { error: "topic_id and message required" });
      }
      const c = await loadCurriculum();
      const hit = findTopic(c, topic_id);
      if (!hit) return json(res, 404, { error: "topic not found" });
      const topicContext = hit.topic.context || [];
      const globalContext = c.global_context || [];

      const chats = await loadChats();
      const history = chats[topic_id] || [];
      let reply;
      try {
        reply = await chatReply(hit.topic, history, String(message).trim(), topicContext, globalContext, getClient());
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
      history.push({ role: "user", content: String(message).trim(), ts: new Date().toISOString() });
      history.push({ role: "assistant", content: reply, ts: new Date().toISOString() });
      chats[topic_id] = history;
      await saveChats(chats);
      return json(res, 200, { reply, history });
    }

    if (url === "/api/chat/commit" && method === "POST") {
      const { topic_id, instruction } = await readBody(req);
      if (!topic_id) return json(res, 400, { error: "topic_id required" });
      const c = await loadCurriculum();
      const hit = findTopic(c, topic_id);
      if (!hit) return json(res, 404, { error: "topic not found" });
      const chats = await loadChats();
      const history = chats[topic_id] || [];
      if (!history.length) return json(res, 400, { error: "no chat to commit" });

      let result;
      try {
        result = await commitChat(hit.topic, history, getClient(), instruction || "");
      } catch (e) {
        return json(res, 500, { error: e.message });
      }

      const undo = await loadUndo();
      pushUndo(undo, hit.topic, "tutor chat commit");

      // Apply an agreed lesson revision (only the fields the model returned).
      let lessonChanged = false;
      if (result.updated_lesson) {
        hit.topic.lesson = hit.topic.lesson || { def: "", example: null, fp: [] };
        const u = result.updated_lesson;
        if (typeof u.def === "string" && u.def.trim()) { hit.topic.lesson.def = u.def.trim(); lessonChanged = true; }
        if (u.example && typeof u.example.code === "string") { hit.topic.lesson.example = u.example; lessonChanged = true; }
        if (Array.isArray(u.fp) && u.fp.length) { hit.topic.lesson.fp = u.fp; lessonChanged = true; }
      }

      // Save durable context, scoped to the topic or globally.
      hit.topic.context = hit.topic.context || [];
      if (!Array.isArray(c.global_context)) c.global_context = [];
      let topicNotes = 0, globalNotes = 0;
      for (const note of result.context_notes) {
        const entry = { id: genId("ctx"), text: note.text, date: todayIso(), source: "chat" };
        if (note.scope === "all") { c.global_context.push(entry); globalNotes++; }
        else { hit.topic.context.push(entry); topicNotes++; }
      }

      hit.topic.history.push({
        date: todayIso(),
        action: hit.topic.status === "untouched" ? "introduced" : hit.topic.status,
        note: `tutor chat committed: ${result.summary}`,
      });
      if (hit.topic.status === "untouched") hit.topic.status = "introduced";

      await saveCurriculum(c);
      await saveUndo(undo);
      // Keep the conversation so he can resume; commit is additive.
      return json(res, 200, {
        ok: true, summary: result.summary,
        lesson_changed: lessonChanged, topic_notes: topicNotes, global_notes: globalNotes,
      });
    }

    if (url === "/api/chat/clear" && method === "POST") {
      const { topic_id } = await readBody(req);
      if (!topic_id) return json(res, 400, { error: "topic_id required" });
      const chats = await loadChats();
      delete chats[topic_id];
      await saveChats(chats);
      return json(res, 200, { ok: true });
    }

    if (url === "/api/context" && method === "DELETE") {
      const { topic_id, note_id } = await readBody(req);
      if (!note_id) return json(res, 400, { error: "note_id required" });
      const c = await loadCurriculum();
      if (topic_id) {
        const hit = findTopic(c, topic_id);
        if (hit && Array.isArray(hit.topic.context)) {
          hit.topic.context = hit.topic.context.filter((n) => n.id !== note_id);
        }
      } else if (Array.isArray(c.global_context)) {
        c.global_context = c.global_context.filter((n) => n.id !== note_id);
      }
      await saveCurriculum(c);
      return json(res, 200, { ok: true });
    }

    // ---- quiz ----
    if (url.startsWith("/api/quiz") && method === "GET") {
      const u = new URL(url, "http://localhost");
      const topicId = u.searchParams.get("topic_id");
      if (!topicId) return json(res, 400, { error: "topic_id required" });
      const c = await loadCurriculum();
      const hit = findTopic(c, topicId);
      const quizzes = await loadQuizChats();
      return json(res, 200, {
        topic_id: topicId,
        history: quizzes[topicId] || [],
        strength: hit ? (hit.topic.strength ?? null) : null,
        quizzes: hit ? (hit.topic.quizzes || []) : [],
      });
    }

    if (url === "/api/quiz/start" && method === "POST") {
      const { topic_id } = await readBody(req);
      if (!topic_id) return json(res, 400, { error: "topic_id required" });
      const c = await loadCurriculum();
      const hit = findTopic(c, topic_id);
      if (!hit) return json(res, 404, { error: "topic not found" });
      let question;
      try {
        question = await quizQuestion(hit.topic, getClient());
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
      const quizzes = await loadQuizChats();
      quizzes[topic_id] = [{ role: "assistant", content: question, ts: new Date().toISOString() }];
      await saveQuizChats(quizzes);
      return json(res, 200, { question, history: quizzes[topic_id] });
    }

    if (url === "/api/quiz/message" && method === "POST") {
      const { topic_id, message } = await readBody(req);
      if (!topic_id || !message || !String(message).trim()) {
        return json(res, 400, { error: "topic_id and message required" });
      }
      const c = await loadCurriculum();
      const hit = findTopic(c, topic_id);
      if (!hit) return json(res, 404, { error: "topic not found" });
      const quizzes = await loadQuizChats();
      const history = quizzes[topic_id] || [];
      let reply;
      try {
        reply = await quizReply(hit.topic, history, String(message).trim(), getClient());
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
      history.push({ role: "user", content: String(message).trim(), ts: new Date().toISOString() });
      history.push({ role: "assistant", content: reply, ts: new Date().toISOString() });
      quizzes[topic_id] = history;
      await saveQuizChats(quizzes);
      return json(res, 200, { reply, history });
    }

    if (url === "/api/quiz/grade" && method === "POST") {
      const { topic_id } = await readBody(req);
      if (!topic_id) return json(res, 400, { error: "topic_id required" });
      const c = await loadCurriculum();
      const hit = findTopic(c, topic_id);
      if (!hit) return json(res, 404, { error: "topic not found" });
      const quizzes = await loadQuizChats();
      const history = quizzes[topic_id] || [];
      const answered = history.filter((m) => m.role === "user").length;
      if (!answered) return json(res, 400, { error: "answer at least one question before grading" });

      let grade;
      try {
        grade = await quizGrade(hit.topic, history, getClient());
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
      hit.topic.strength = grade.score;
      hit.topic.quizzes = hit.topic.quizzes || [];
      hit.topic.quizzes.push({
        date: todayIso(), score: grade.score, level: grade.level,
        hints: grade.hints_used, rationale: grade.rationale,
      });
      await saveCurriculum(c);
      return json(res, 200, { ok: true, ...grade });
    }

    if (url === "/api/quiz/clear" && method === "POST") {
      const { topic_id } = await readBody(req);
      if (!topic_id) return json(res, 400, { error: "topic_id required" });
      const quizzes = await loadQuizChats();
      delete quizzes[topic_id];
      await saveQuizChats(quizzes);
      return json(res, 200, { ok: true });
    }

    // ---- weekly layer (unchanged from v1) ----
    if (url.startsWith("/api/weekly") && method === "GET" && !url.includes("/refresh")) {
      const u = new URL(url, "http://localhost");
      const week = u.searchParams.get("week") || isoWeek(new Date());
      const data = await loadWeekly();
      const w = data.weeks[week] || { range_start: null, range_end: null, cdtm_eng: [], your_work: [], saved_moments: [] };
      const inbox = data.saved_moments_inbox || [];
      return json(res, 200, {
        week,
        ...w,
        saved_moments: [
          ...(w.saved_moments || []),
          ...inbox.filter((m) => withinWeek(m.saved_at, w.range_start, w.range_end)),
        ],
        weeks_available: Object.keys(data.weeks).sort(),
      });
    }

    if (url === "/api/weekly/refresh" && method === "POST") {
      const t0 = Date.now();
      const results = await Promise.allSettled([
        runScript("crawl-wa.mjs"),
        runScript("crawl-sessions.mjs"),
      ]);
      const summary = results.map((r, i) => ({
        script: i === 0 ? "crawl-wa.mjs" : "crawl-sessions.mjs",
        ok: r.status === "fulfilled",
        output: r.status === "fulfilled" ? r.value : String(r.reason),
      }));
      return json(res, 200, { ok: true, ms: Date.now() - t0, results: summary });
    }

    if (url === "/api/save-moment" && method === "POST") {
      const { context, topic_id_guess, topic_title_guess, source } = await readBody(req);
      if (!context || typeof context !== "string") return json(res, 400, { error: "context required" });
      const data = await loadWeekly();
      const moment = {
        id: genId("m"),
        saved_at: new Date().toISOString(),
        topic_id_guess: topic_id_guess || null,
        topic_title_guess: topic_title_guess || null,
        source: source || "chat",
        context: context.trim().slice(0, 4000),
      };
      data.saved_moments_inbox.push(moment);
      await saveWeekly(data);
      return json(res, 200, { ok: true, moment });
    }

    if ((url === "/weekly" || url === "/weekly.html") && method === "GET") {
      const html = await readFile(WEEKLY_HTML_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
      res.end(html);
      return;
    }

    // ---- app ----
    if ((url === "/" || url === "/index.html") && method === "GET") {
      let html = await readFile(APP_HTML_PATH, "utf8");
      const closeIdx = html.lastIndexOf("</body>");
      if (closeIdx !== -1) html = html.slice(0, closeIdx) + LIVE_RELOAD + "\n" + html.slice(closeIdx);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
      res.end(html);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    try { json(res, 500, { error: err.message }); } catch (e) {}
  }
});

function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [scriptName], { cwd: __dirname });
    let out = "";
    let err = "";
    proc.stdout.on("data", (b) => (out += b.toString()));
    proc.stderr.on("data", (b) => (err += b.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${scriptName} exit ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

function withinWeek(iso, start, end) {
  if (!iso || !start || !end) return false;
  const day = iso.slice(0, 10);
  return day >= start && day <= end;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Curriculum web app running at localhost:${PORT}`);
});
