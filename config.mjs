// Central configuration.
//
// Every machine-specific value comes from the environment, loaded from a local
// (gitignored) .env. Defaults are neutral so a fresh clone runs without setup
// beyond an OpenAI key. See .env.example for the full list.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 1) local .env next to the repo
const localEnv = path.join(ROOT, ".env");
if (existsSync(localEnv)) loadDotenv({ path: localEnv, override: false });

// 2) optional external file holding the OpenAI key — lets you keep the key out
//    of the repo tree entirely (point OPENAI_ENV_FILE at it).
if (process.env.OPENAI_ENV_FILE && existsSync(process.env.OPENAI_ENV_FILE)) {
  loadDotenv({ path: process.env.OPENAI_ENV_FILE, override: false });
}

// Who the tutor/quiz prompts are written for.
export const LEARNER_NAME = process.env.LEARNER_NAME || "the learner";
export const LEARNER_PROFILE =
  process.env.LEARNER_PROFILE ||
  "a developer new to coding who learns by building real projects; wants short, to-the-point, first-principles explanations.";

// Optional integrations for the crawlers. Empty => that crawler is disabled.
export const WA_DAEMON_DIR = process.env.WA_DAEMON_DIR || "";
export const WA_GROUP_JID = process.env.WA_GROUP_JID || "";
export const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || "";
export const CURRICULUM_HTML_SOURCE = process.env.CURRICULUM_HTML_SOURCE || "";

// Weekly-learnings sidecar store. Defaults to a local file under data/.
export const WEEKLY_STORE_PATH =
  process.env.WEEKLY_STORE_PATH || path.join(ROOT, "data", "curriculum-weekly.json");

export const ROOT_DIR = ROOT;
