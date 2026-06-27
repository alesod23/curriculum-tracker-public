// Shared LLM classifier. Given a list of items (each a small text chunk)
// and a list of active curriculum topics, returns matches:
//   [{ item_idx, topic_id, evidence_quote, why_it_matters }]
//
// Uses OpenAI chat completion in JSON mode with gpt-4o-mini. Batches items
// in groups of `BATCH_SIZE` to stay cheap and fast.

import OpenAI from "openai";

const BATCH_SIZE = 10;
const MODEL = process.env.CURRICULUM_CLASSIFIER_MODEL || "gpt-4o-mini";

const SYSTEM = `You are a curriculum tagger.

You will be given:
1. A list of curriculum topics (id + title + short description).
2. A numbered list of items. An item is either a single WhatsApp message
   from a tech group, or a short excerpt from one of the user's coding
   sessions.

For each item, decide which topics (if any) it ILLUSTRATES with a
concrete example, insight, gotcha, or worked-through problem.

BE CONSERVATIVE. Only match if the item directly demonstrates or
discusses the topic in a way that would teach the reader something. Pure
social chatter, scheduling, "thanks!" replies, and off-topic noise get
NO matches.

Return strict JSON of the shape:
{
  "matches": [
    { "item_idx": <0-based int>,
      "topic_id": "<topic id from the list>",
      "evidence_quote": "<short direct quote, max 240 chars>",
      "why_it_matters": "<one sentence: why this item is useful learning material for that topic>" }
  ]
}

If nothing in the batch matches anything, return {"matches": []}.`;

export async function classifyBatch(items, topics, openaiClient) {
  if (!items.length || !topics.length) return [];
  const client = openaiClient || new OpenAI();
  const out = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const slice = items.slice(i, i + BATCH_SIZE);
    const userMsg = buildPrompt(slice, topics);
    const resp = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
    });
    let parsed;
    try {
      parsed = JSON.parse(resp.choices[0].message.content);
    } catch {
      continue;
    }
    if (!parsed || !Array.isArray(parsed.matches)) continue;
    for (const m of parsed.matches) {
      if (typeof m.item_idx !== "number") continue;
      if (m.item_idx < 0 || m.item_idx >= slice.length) continue;
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

function buildPrompt(items, topics) {
  const topicLines = topics
    .map((t) => `- ${t.id} :: ${t.title} — ${t.desc}`)
    .join("\n");
  const itemLines = items
    .map((it, idx) => `[${idx}] ${it.text}`)
    .join("\n\n");
  return `Topics:\n${topicLines}\n\nItems:\n${itemLines}`;
}
