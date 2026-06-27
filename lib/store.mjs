// Read/write the app's JSON data files (data/curriculum.json, data/inbox.json,
// data/notes.json) with atomic writes (tmp + rename) so a crash mid-write
// never corrupts the store.

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "..", "data");
export const CURRICULUM_PATH = path.join(DATA_DIR, "curriculum.json");
export const INBOX_PATH = path.join(DATA_DIR, "inbox.json");
export const NOTES_PATH = path.join(DATA_DIR, "notes.json");
export const CHATS_PATH = path.join(DATA_DIR, "chats.json");
export const QUIZ_CHATS_PATH = path.join(DATA_DIR, "quiz-chats.json");
export const SOURCES_PATH = path.join(DATA_DIR, "sources.json");
export const UNDO_PATH = path.join(DATA_DIR, "undo.json");

mkdirSync(DATA_DIR, { recursive: true });

export async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, data) {
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

export const loadCurriculum = () => readJson(CURRICULUM_PATH, null);
export const saveCurriculum = (d) => writeJson(CURRICULUM_PATH, d);

export const loadInbox = () => readJson(INBOX_PATH, { items: [], last_crawl_at: null });
export const saveInbox = (d) => writeJson(INBOX_PATH, d);

export const loadNotes = () => readJson(NOTES_PATH, {});
export const saveNotes = (d) => writeJson(NOTES_PATH, d);

// Tutor chats, keyed by topic_id: { [topic_id]: [{ role, content, ts }] }
export const loadChats = () => readJson(CHATS_PATH, {});
export const saveChats = (d) => writeJson(CHATS_PATH, d);

// Active quiz conversations, keyed by topic_id (same shape as tutor chats).
export const loadQuizChats = () => readJson(QUIZ_CHATS_PATH, {});
export const saveQuizChats = (d) => writeJson(QUIZ_CHATS_PATH, d);

// Registry of ingested project sources: { projects: [{name, path, last_ingest_at, sessions, items, code_files}] }
export const loadSources = () => readJson(SOURCES_PATH, { projects: [] });
export const saveSources = (d) => writeJson(SOURCES_PATH, d);

// Per-topic undo stacks: { [topic_id]: [{ ts, label, lesson, context, examples, status, strength }] }
export const loadUndo = () => readJson(UNDO_PATH, {});
export const saveUndo = (d) => writeJson(UNDO_PATH, d);

// Snapshot a topic's mutable curriculum state onto its undo stack (before a
// mutation), newest last, capped. Returns the mutated undo object (caller saves).
export function pushUndo(undo, topic, label) {
  const stack = undo[topic.id] || (undo[topic.id] = []);
  stack.push({
    ts: new Date().toISOString(),
    label,
    lesson: topic.lesson ? JSON.parse(JSON.stringify(topic.lesson)) : null,
    context: JSON.parse(JSON.stringify(topic.context || [])),
    examples: JSON.parse(JSON.stringify(topic.examples || [])),
    status: topic.status,
    strength: topic.strength ?? null,
    quizzes: JSON.parse(JSON.stringify(topic.quizzes || [])),
  });
  while (stack.length > 15) stack.shift();
  return undo;
}

// Find a topic (and its phase) by id inside a loaded curriculum object.
export function findTopic(curriculum, topicId) {
  for (const phase of curriculum.phases) {
    const topic = phase.topics.find((t) => t.id === topicId);
    if (topic) return { phase, topic };
  }
  return null;
}

export function allTopics(curriculum) {
  const out = [];
  for (const phase of curriculum.phases) {
    for (const t of phase.topics) {
      out.push({ ...t, phase_id: phase.id, phase_title: phase.title });
    }
  }
  return out;
}

export function genId(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10);
}
