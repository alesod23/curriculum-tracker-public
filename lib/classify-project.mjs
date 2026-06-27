// Classify snippets from one of your own projects (code files +
// build-session excerpts) against the curriculum. Recall-oriented like the
// daily crawl: a human reviews every match in the project backlog, so surface
// generously and let the reviewer approve. Same return shape as the other classifiers.

import OpenAI from "openai";

const BATCH_SIZE = 6;
const MODEL = process.env.CURRICULUM_CLASSIFIER_MODEL || "gpt-4o-mini";

const SYSTEM = `You tag excerpts from a software project the learner BUILT
(his own code files and excerpts from the Claude Code session where he built it)
against his software-engineering curriculum.

You get:
1. Curriculum topics (id + title + short description).
2. Numbered excerpts. Each is either a CODE FILE (or part of one) or a snippet
   from the build conversation.

For each excerpt, pick the topic(s) it concretely DEMONSTRATES or TEACHES — a
real example of that concept in his own work (a pattern used, an API called, a
bug fixed, a design decision, a technique explained). This is example material
to attach to that topic.

PREFER RECALL (a human approves each match): match the best 1-3 topics when the
excerpt genuinely shows the concept. Skip pure boilerplate, lockfiles, generated
output, and config with no teaching value.

For the evidence_quote, quote the most illustrative 1-3 lines from the excerpt.

Return STRICT JSON:
{ "matches": [
  { "item_idx": <0-based int>,
    "topic_id": "<topic id>",
    "evidence_quote": "<<=240 chars, a real line/snippet from the excerpt>",
    "why_it_matters": "<one sentence: what this shows about the topic>" } ] }
If nothing matches, return {"matches": []}.`;

export async function classifyProject(items, topics, openaiClient) {
  if (!items.length || !topics.length) return [];
  const client = openaiClient || new OpenAI();
  const out = [];
  const topicLines = topics.map((t) => `- ${t.id} :: ${t.title} — ${t.desc}`).join("\n");
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const slice = items.slice(i, i + BATCH_SIZE);
    const itemLines = slice
      .map((it, idx) => `[${idx}] (${it.origin})\n${it.text}`)
      .join("\n\n---\n\n");
    let parsed;
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Topics:\n${topicLines}\n\nExcerpts:\n${itemLines}` },
        ],
      });
      parsed = JSON.parse(resp.choices[0].message.content);
    } catch {
      continue;
    }
    if (!parsed || !Array.isArray(parsed.matches)) continue;
    for (const m of parsed.matches) {
      if (typeof m.item_idx !== "number" || m.item_idx < 0 || m.item_idx >= slice.length) continue;
      if (!m.topic_id || !topics.find((t) => t.id === m.topic_id)) continue;
      out.push({
        item: slice[m.item_idx],
        topic_id: m.topic_id,
        evidence_quote: String(m.evidence_quote || "").slice(0, 240),
        why_it_matters: String(m.why_it_matters || "").slice(0, 400),
      });
    }
  }
  return out;
}
