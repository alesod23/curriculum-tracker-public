// Collect curriculum-worthy material from one of your own projects:
//   - handmade SOURCE CODE files (skipping deps, build output, lockfiles,
//     minified/generated blobs), and
//   - excerpts from the Claude Code BUILD SESSION transcript(s) where you made it.
// Both are returned as { origin, text } items for the project classifier.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", ".cache", "dist", "build", "out",
  "coverage", "__pycache__", ".venv", "venv", "vendor", ".svelte-kit", "output",
  ".vercel", ".idea", ".vscode",
]);
const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".css", ".html", ".md"]);
// Config worth reading by exact basename (other .json is usually generated).
const KEEP_JSON = new Set(["package.json", "tsconfig.json", "vercel.json"]);
const SKIP_BASENAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

const MAX_FILE_BYTES = 60 * 1024;   // bigger files are usually generated
const MAX_SNIPPET_CHARS = 3500;     // truncate each file for classification

function looksGenerated(content) {
  const lines = content.split("\n");
  if (!lines.length) return true;
  const avg = content.length / lines.length;
  if (avg > 300) return true;                 // minified / single huge line
  if (/^\s*\/\/ (Generated|Auto-generated|DO NOT EDIT)/im.test(content)) return true;
  return false;
}

export function collectCodeFiles(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        // allow only non-skipped dotdirs through? simplest: skip all dotdirs
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SKIP_BASENAMES.has(e.name)) continue;
        if (e.name.endsWith(".min.js") || e.name.endsWith(".min.css")) continue;
        if (/-manifest\.(js|json)$/.test(e.name)) continue;
        const keep = CODE_EXT.has(ext) || (ext === ".json" && KEEP_JSON.has(e.name));
        if (!keep) continue;
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        let content;
        try { content = readFileSync(full, "utf8"); } catch { continue; }
        if (!content.trim() || looksGenerated(content)) continue;
        out.push({
          origin: "file: " + path.relative(root, full).replace(/\\/g, "/"),
          text: content.length > MAX_SNIPPET_CHARS ? content.slice(0, MAX_SNIPPET_CHARS) + "\n…(truncated)" : content,
        });
      }
    }
  }
  walk(root);
  return out;
}

// Pull substantive excerpts from one or more session JSONL transcripts: assistant
// messages that contain code or are real explanations, plus the user's own
// "explain / what just happened" asks. Bounded so a huge session can't blow up.
export function collectSessionSnippets(jsonlPaths, { maxSnippets = 30 } = {}) {
  const snippets = [];
  for (const p of jsonlPaths) {
    if (!existsSync(p)) continue;
    let lines;
    try { lines = readFileSync(p, "utf8").split("\n"); } catch { continue; }
    const sid = path.basename(p, ".jsonl").slice(0, 8);
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== "user" && obj.type !== "assistant") continue;
      const text = extractText(obj);
      if (!text) continue;
      const isExplanation = obj.type === "assistant" && (text.includes("```") || text.length > 500);
      const isLearningAsk = obj.type === "user" && /\b(explain|what (just|did)|how does|why does|teach me|wtf|break it down)\b/i.test(text) && text.length < 600;
      if (!isExplanation && !isLearningAsk) continue;
      snippets.push({
        origin: `session ${sid} (${obj.type})`,
        text: text.length > MAX_SNIPPET_CHARS ? text.slice(0, MAX_SNIPPET_CHARS) + "\n…(truncated)" : text,
        len: text.length,
      });
    }
  }
  // Keep the longest/most substantive, drop the len helper.
  return snippets.sort((a, b) => b.len - a.len).slice(0, maxSnippets).map(({ origin, text }) => ({ origin, text }));
}

function extractText(obj) {
  const m = obj.message;
  if (!m) return "";
  if (typeof m.content === "string") return m.content.trim();
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}
