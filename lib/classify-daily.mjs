// Recall-oriented classifier for the daily backlog crawl.
//
// Unlike lib/classify.mjs (weekly digest, precision-tuned), the backlog has a
// human approval stage after it — so this matcher should surface anything
// plausibly relevant and let the user approve/dismiss. Same return shape:
//   [{ item, topic_id, evidence_quote, why_it_matters }]

import OpenAI from "openai";

const BATCH_SIZE = 10;
const MODEL = process.env.CURRICULUM_CLASSIFIER_MODEL || "gpt-4o-mini";

const SYSTEM = `You are tagging WhatsApp messages from a tech/engineering group
against a personal software-engineering curriculum.

You will be given:
1. The curriculum topics (id + title + short description).
2. A numbered list of messages.

For each message, pick the topic(s) it RELATES to. A message relates to a
topic when it contains a practitioner insight, opinion, experience report,
tool mention, gotcha, debate, or question that someone learning that topic
would find interesting context — it does NOT need to be a worked example or a
tutorial. Real-world discussion ("we keep our LLM provider pluggable",
"prompts are coupled to specific models") is exactly what we want.

A human reviews every match afterwards, so PREFER RECALL over precision:
when in doubt, match the single best-fitting topic. Topic descriptions are
narrow keyword hints; match on the broader concept the topic covers, not
only its literal keywords.

Only skip messages that are pure scheduling, greetings, thanks, memes,
job ads, or social chatter with no technical content at all.

At most 2 topics per message; pick the best fits.

Return strict JSON:
{
  "matches": [
    { "item_idx": <0-based int>,
      "topic_id": "<topic id from the list>",
      "evidence_quote": "<short direct quote, max 240 chars>",
      "why_it_matters": "<one sentence: what a learner of that topic takes from this message>" }
  ]
}

If nothing matches, return {"matches": []}.`;

export async function classifyDaily(items, topics, openaiClient) {
  if (!items.length || !topics.length) return [];
  const client = openaiClient || new OpenAI();
  const out = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const slice = items.slice(i, i + BATCH_SIZE);
    const resp = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(slice, topics) },
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
