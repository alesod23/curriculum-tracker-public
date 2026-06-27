// Open-ended, chat-based quiz for a topic + grading.
//
// The quiz is a short conversation: the tutor asks one open question, the user
// answers in free text, can ask for hints, and the tutor probes concisely. When
// they're done, quizGrade() reviews the whole transcript and scores their
// understanding — weighting correctness, depth, first-principles reasoning, and
// how many hints they needed (more hints -> lower independence). The score becomes
// topic.strength, which the project-review flow uses to prioritize weak topics.

import { CHAT_MODEL } from "./llm.mjs";
import { LEARNER_NAME } from "../config.mjs";

const QUIZ_MODEL = process.env.CURRICULUM_QUIZ_MODEL || CHAT_MODEL;

function lessonRef(topic) {
  const l = topic.lesson;
  if (!l) return `Topic: ${topic.title}. (No written explanation; use general knowledge.)`;
  let s = `Topic: ${topic.title}\nDefinition: ${l.def || "(none)"}`;
  if (l.fp?.length) s += `\nKey points:\n` + l.fp.map((p) => `- ${p.q} ${p.a}`).join("\n");
  return s;
}

export async function quizQuestion(topic, client) {
  const resp = await client.chat.completions.create({
    model: QUIZ_MODEL,
    temperature: 0.6,
    messages: [
      {
        role: "system",
        content: `You are quizzing ${LEARNER_NAME} on a software-engineering topic to
gauge real understanding, not recall trivia.

Reference (ground truth):
${lessonRef(topic)}

Ask exactly ONE open-ended question that makes them explain or reason from first
principles (e.g. "why", "when would you", "what breaks if"). Keep it to 1-2
sentences. Output ONLY the question.`,
      },
      { role: "user", content: "Give me the question." },
    ],
  });
  return resp.choices[0].message.content.trim();
}

export async function quizReply(topic, history, userMsg, client) {
  const system = `You are running an open-ended quiz on "${topic.title}".

Reference (ground truth, do NOT paste it verbatim to him):
${lessonRef(topic)}

Rules:
- Respond CONCISELY (1-3 sentences). Simple markdown only (**bold**, \`code\`).
- If he asks for a hint or is clearly stuck, give a SMALL nudge — never the full
  answer.
- If his answer is partial, probe with one short follow-up.
- If his answer is solid, acknowledge briefly and you may push one level deeper.
- Do NOT announce a grade or score here; grading happens separately.`;

  const messages = [{ role: "system", content: system }];
  for (const m of history) messages.push({ role: m.role, content: m.content });
  messages.push({ role: "user", content: userMsg });

  const resp = await client.chat.completions.create({
    model: QUIZ_MODEL,
    temperature: 0.4,
    messages,
  });
  return resp.choices[0].message.content.trim();
}

const GRADE_SYSTEM = `You grade an open-ended quiz conversation about ONE topic.
Judge the LEARNER's understanding from the whole transcript.

Weigh:
- correctness and completeness of his reasoning,
- depth / first-principles thinking vs surface recall,
- INDEPENDENCE: how many hints he needed (count the tutor's hints/nudges; more
  hints => lower independence => lower score),
- whether he self-corrected.

Return STRICT JSON:
{ "score": <int 0-100>,
  "level": "weak" | "developing" | "solid" | "strong",
  "hints_used": <int>,
  "rationale": "<=2 sentences, direct, second person>",
  "gaps": [ "<short specific gap>", ... ] }

Bands: weak 0-39, developing 40-64, solid 65-84, strong 85-100.`;

export async function quizGrade(topic, history, client) {
  const convo = history.map((m) => `${m.role === "user" ? LEARNER_NAME : "Tutor"}: ${m.content}`).join("\n\n");
  const resp = await client.chat.completions.create({
    model: QUIZ_MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: GRADE_SYSTEM },
      { role: "user", content: `Reference:\n${lessonRef(topic)}\n\nTranscript:\n---\n${convo}\n---\n\nGrade it.` },
    ],
  });
  let p;
  try {
    p = JSON.parse(resp.choices[0].message.content);
  } catch {
    return { score: null, level: "developing", hints_used: 0, rationale: "Could not grade (parse error).", gaps: [] };
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(p.score) || 0)));
  const levels = ["weak", "developing", "solid", "strong"];
  return {
    score,
    level: levels.includes(p.level) ? p.level : (score >= 85 ? "strong" : score >= 65 ? "solid" : score >= 40 ? "developing" : "weak"),
    hints_used: Math.max(0, Math.round(Number(p.hints_used) || 0)),
    rationale: String(p.rationale || "").slice(0, 400),
    gaps: Array.isArray(p.gaps) ? p.gaps.map((g) => String(g).slice(0, 200)).slice(0, 6) : [],
  };
}
