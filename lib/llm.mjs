// Shared OpenAI client for the app's in-process LLM calls (tutor chat, commit
// distillation, quiz). Importing config.mjs loads the API key from the local
// .env (or OPENAI_ENV_FILE) into process.env before the client is created.

import OpenAI from "openai";
import "../config.mjs";

// Tutor chat wants a stronger model than the cheap classifier.
export const CHAT_MODEL = process.env.CURRICULUM_CHAT_MODEL || "gpt-4o";

let client = null;
export function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY not set. Add it to .env, or point OPENAI_ENV_FILE at a file that defines it (see .env.example)."
    );
  }
  if (!client) client = new OpenAI();
  return client;
}
