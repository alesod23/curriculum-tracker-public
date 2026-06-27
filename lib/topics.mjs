// Extract the curriculum topic catalog from fullstack-curriculum.html.
//
// The HTML embeds a `const PHASES = [...]` literal that uses helper functions
// (introTT, lsn) and constants (TODAY, SESSION, TT). We stub those helpers,
// snip the array literal, and evaluate it in a vm sandbox.
//
// Each topic ends up with:
//   { id, title, desc, phase_id, phase_title, status, history }
// where status ∈ "untouched" | "introduced" | "mastered".

import { readFileSync } from "node:fs";
import vm from "node:vm";

export function loadPhases(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const start = html.indexOf("const PHASES = [");
  if (start < 0) throw new Error("PHASES const not found in HTML");
  const arrayStart = html.indexOf("[", start);
  let depth = 0;
  let i = arrayStart;
  let inStr = false;
  let strCh = "";
  let inTpl = false;
  let escape = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === strCh) { inStr = false; }
      continue;
    }
    if (inTpl) {
      if (c === "\\") { escape = true; continue; }
      if (c === "`") { inTpl = false; }
      continue;
    }
    if (c === "\"" || c === "'") { inStr = true; strCh = c; continue; }
    if (c === "`") { inTpl = true; continue; }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const literal = html.slice(arrayStart, i);
  const helpers = {
    introTT: (file, note) => ({ date: null, action: "introduced", file, note }),
    masterTT: (file, note) => ({ date: null, action: "mastered", file, note }),
    lsn: () => null,
  };
  // Any bare identifier in the source array (status tokens, project tags, etc.)
  // resolves to null instead of throwing, so the parser is source-agnostic.
  const sandbox = new Proxy(helpers, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : null),
  });
  vm.createContext(sandbox);
  return vm.runInContext(`(${literal})`, sandbox, { timeout: 1000 });
}

export function flatTopics(htmlPath) {
  const phases = loadPhases(htmlPath);
  const out = [];
  for (const phase of phases) {
    for (const t of phase.topics) {
      const history = Array.isArray(t.history) ? t.history : [];
      let status = "untouched";
      if (history.length > 0) {
        const last = history[history.length - 1];
        status = last && last.action === "mastered" ? "mastered" : "introduced";
      }
      out.push({
        id: t.id,
        title: t.title,
        desc: t.desc || "",
        phase_id: phase.id,
        phase_title: phase.title,
        status,
        history,
      });
    }
  }
  return out;
}

export function activeTopics(htmlPath) {
  return flatTopics(htmlPath).filter((t) => t.status !== "untouched");
}
