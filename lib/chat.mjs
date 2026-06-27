// Per-topic tutor chat + "send to curriculum" commit.
//
// The web app shows a short explanation per topic. The user can't always say
// up front how they want it, and the explanation sometimes has gaps. This chat
// is where they correct/steer ("too long", "idk what this means", "could we
// say X is like Y?"). Two things come out of a conversation:
//
//   1. an optionally revised explanation for THAT topic, and
//   2. durable CONTEXT — preferences/instructions saved and replayed into every
//      future tutor turn and every /btw, scoped to the topic or to all topics.
//
// chatReply()   -> the tutor's next message (no persistence here; caller saves)
// commitChat()  -> distills the conversation into { updated_lesson?, context_notes[], summary }

import { CHAT_MODEL } from "./llm.mjs";
import { LEARNER_NAME, LEARNER_PROFILE } from "../config.mjs";

const LEARNER = `${LEARNER_NAME} is ${LEARNER_PROFILE} They are the sole user;
"you" in their messages means you, the tutor.`;

// Render the durable context the tutor must honor every turn.
function contextBlock(topicContext, globalContext) {
  const lines = [];
  if (globalContext?.length) {
    lines.push("Instructions that apply to ALL topics (highest priority):");
    for (const c of globalContext) lines.push(`- ${c.text}`);
  }
  if (topicContext?.length) {
    lines.push("Instructions specific to THIS topic:");
    for (const c of topicContext) lines.push(`- ${c.text}`);
  }
  return lines.length
    ? lines.join("\n")
    : "(No saved instructions yet — infer their preferences from this conversation.)";
}

function lessonBlock(topic) {
  const l = topic.lesson;
  if (!l) return "(This topic has no written explanation yet.)";
  let s = `Definition:\n${l.def || "(none)"}`;
  if (l.example?.code) s += `\n\nExample:\n${l.example.code}\n${l.example.purpose || ""}`;
  if (l.fp?.length) s += `\n\nFirst principles:\n` + l.fp.map((p) => `Q: ${p.q}\nA: ${p.a}`).join("\n");
  return s;
}

// Real-world examples attached to this topic (approved WhatsApp messages, and
// later his own projects). He may want to deep-dive any of them.
function examplesBlock(topic) {
  const ex = topic.examples || [];
  if (!ex.length) return "(No real-world examples attached yet.)";
  return ex
    .map((e, i) => {
      const tag = e.project ? `project ${e.project}` : (e.from || e.source || "example");
      return `[${i + 1}] (${tag}) ${e.text}${e.why ? ` — ${e.why}` : ""}`;
    })
    .join("\n");
}

export async function chatReply(topic, history, userMsg, topicContext, globalContext, client) {
  const system = `You are ${LEARNER_NAME}'s personal software-engineering tutor inside
their curriculum app. You are discussing one topic: "${topic.title}".

${LEARNER}

The explanation currently shown for this topic:
---
${lessonBlock(topic)}
---

Real-world examples attached to this topic:
---
${examplesBlock(topic)}
---

Durable instructions he has already given you:
${contextBlock(topicContext, globalContext)}

Your job in this chat:
- Answer his questions about the topic and iterate on the explanation with him.
- He can also ask to go DEEPER on any attached example or project ("tell me more
  about this project", "how did that work"). Engage fully; deep dives are welcome —
  that is the ONE case where a longer reply is fine.
- When he points out a gap, a wrong assumption, or wants a change, propose the
  exact revised wording (or the analogy/clarification) so it can be saved.
- When he expresses a preference ("too long", "use analogies", "assume I know X"),
  acknowledge it briefly; it will be saved as durable context on commit.
- Do not restate these instructions back to him. Just help.

DEFAULT FORMAT (unless he asks for a deep dive or his saved instructions say
otherwise):
- BE BRIEF: aim for ~150 words max. Lead with the single core idea in one line,
  then a few short bullets. Cut everything that isn't load-bearing.
- Use simple MARKDOWN: **bold** for key terms, \`backticks\` for code/identifiers/
  literals, "- " for bullets, a blank line between blocks. No headings. No walls
  of prose. Prefer a tight bulleted structure over paragraphs.`;

  const messages = [{ role: "system", content: system }];
  for (const m of history) messages.push({ role: m.role, content: m.content });
  messages.push({ role: "user", content: userMsg });

  const resp = await client.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.4,
    messages,
  });
  return resp.choices[0].message.content.trim();
}

const COMMIT_SYSTEM = `You distill a tutor<->learner conversation about ONE
curriculum topic into a structured commit. Two outputs:

1. updated_lesson — ONLY if the conversation reached an agreed change to the
   explanation (he said something like "add that", "yes use that", "rewrite it
   that way"). Otherwise null. When present, include only the fields that
   changed; keep the others null so the app preserves them. Shape:
   { "def": <string|null>, "example": {"code": <string>, "purpose": <string>}|null, "fp": [{"q","a"}]|null }
   def MUST be MARKDOWN and SHORT (~120 words max, first-principles): a one-line
   core idea then a few "- " bullets; **bold** key terms, \`backticks\` for code/
   identifiers, no headings, no HTML tags. Do not invent changes he didn't agree to.

2. context_notes — durable preferences/instructions to remember for the future,
   each an imperative sentence written to the tutor (e.g. "Keep this topic's
   explanation under 3 sentences", "He already knows what an API is, don't
   re-explain it", "Prefer concrete analogies over formal definitions").
   scope is "all" if he said it should apply to every topic / "apply to all" /
   it is clearly a general style preference; otherwise "topic". Empty array if
   the chat produced no durable preference.

Return STRICT JSON:
{ "updated_lesson": <object|null>,
  "context_notes": [ { "text": <string>, "scope": "topic"|"all" } ],
  "summary": "<=1 sentence describing what is being committed" }`;

export async function commitChat(topic, history, client, instruction = "") {
  const convo = history.map((m) => `${m.role === "user" ? LEARNER_NAME : "Tutor"}: ${m.content}`).join("\n\n");
  const scope = instruction && instruction.trim()
    ? `\nCOMMIT SCOPE — commit ONLY this, ignore the rest of the conversation:\n"${instruction.trim()}"\n`
    : "";
  const user = `Topic: "${topic.title}"

Current explanation:
---
${lessonBlock(topic)}
---

Conversation:
---
${convo}
---
${scope}
Produce the commit JSON.`;

  const resp = await client.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: COMMIT_SYSTEM },
      { role: "user", content: user },
    ],
  });

  let parsed;
  try {
    parsed = JSON.parse(resp.choices[0].message.content);
  } catch {
    return { updated_lesson: null, context_notes: [], summary: "Nothing committed (parse error)." };
  }
  return {
    updated_lesson: parsed.updated_lesson || null,
    context_notes: Array.isArray(parsed.context_notes)
      ? parsed.context_notes
          .filter((c) => c && typeof c.text === "string" && c.text.trim())
          .map((c) => ({ text: c.text.trim(), scope: c.scope === "all" ? "all" : "topic" }))
      : [],
    summary: String(parsed.summary || "Committed.").slice(0, 300),
  };
}
