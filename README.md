# Curriculum Tracker

A local, single-machine web app that turns **your own coding projects** and
day-to-day learning into a personal software-engineering curriculum. It holds a
phased topic tree (HTML/CSS → JS → backend → security → LLMs …), a per-topic
**tutor chat**, an open-ended **quiz** that scores how well you actually know a
topic, and a **backlog** fed by capturing real projects you've built.

Everything runs on `localhost` against plain JSON files. No accounts, no cloud.

---

## Capture a project into your curriculum — `/sde`

The whole point of the tool: feed it the real code you write so your curriculum
is grounded in your own work. That capture step is a Claude Code skill, **`/sde`**.

Run it inside Claude Code, pointing at a project you built:

```
/sde            # then name/point at the project, or
/sde source this project
```

What it does:

1. Resolves the project directory.
2. Finds the Claude Code build-session transcript(s) for that project.
3. Mines **both** the handmade source code and the build session, classifying
   every substantive excerpt against the curriculum topics.
4. Appends the matches as **pending** items (tagged with the project name) to
   `data/inbox.json`, and registers the project in `data/sources.json`.

Nothing lands in the curriculum automatically — captured items show up in the
**Backlog tab** under a `Project: <name>` section (new / weak topics flagged
first). You review and approve there; approved items attach to a topic as
examples and populate the **Projects tab**.

Re-running is idempotent (dedup on project + origin + topic), so re-capturing
after adding files only pulls the new matches.

The skill definition is bundled in [`claude-skill/sde/SKILL.md`](claude-skill/sde/SKILL.md).
To install it, copy that folder into your Claude Code skills directory
(`~/.claude/skills/sde/`).

> Companion command: **`/btw`** ("by the way") is the *teaching* counterpart — it
> explains a topic and writes the lesson back into the curriculum. `/sde` is the
> *capture* counterpart that sources your own projects. This repo ships `/sde`.

---

## Run it

```bash
npm install
cp .env.example .env          # add your OPENAI_API_KEY
cp data/curriculum.example.json data/curriculum.json   # first-run seed
npm start                     # serves http://localhost:4117
```

On Windows you can use the helper: `./start.ps1`.

- **App:** http://localhost:4117 (`app.html`)
- **Weekly learnings view:** http://localhost:4117/weekly (`weekly.html`)

The app auto-creates any missing data files; the curriculum itself starts from
the seed you copied in (or stays empty until you teach/capture topics).

### Environment / configuration

All machine-specific values live in a local, gitignored `.env` (see
`.env.example`). A fresh clone only needs an OpenAI key; everything else has a
neutral default.

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | yes* | tutor chat, quiz grading, classifiers |
| `OPENAI_ENV_FILE` | no | path to an external file that defines the key (alternative to putting it in `.env`) |
| `CURRICULUM_CHAT_MODEL` / `CURRICULUM_QUIZ_MODEL` | no | model overrides (default `gpt-4o`) |
| `LEARNER_NAME` | no | name the tutor/quiz address (default "the learner") |
| `LEARNER_PROFILE` | no | one-line description of the learner, woven into prompts |
| `WEEKLY_STORE_PATH` | no | where the weekly-learnings JSON lives (default `data/curriculum-weekly.json`) |
| `WA_DAEMON_DIR`, `WA_GROUP_JID` | no | enable the WhatsApp-group crawlers |
| `CLAUDE_PROJECTS_DIR`, `CURRICULUM_HTML_SOURCE` | no | enable the session crawler |

\* Either set `OPENAI_API_KEY` directly or point `OPENAI_ENV_FILE` at a file that defines it.

The `crawl-*.mjs` scripts are **optional integrations**: they no-op with a clear
error unless their paths are set. The core app (server, tutor chat, quiz, `/sde`
capture) needs only the OpenAI key.

---

## Layout

| Path | What |
|------|------|
| `server.mjs` | HTTP server + JSON API (port 4117) |
| `app.html` / `weekly.html` | the UI (vanilla JS, no build step) |
| `lib/` | store, classifiers, tutor chat, quiz, YT search, topic tree |
| `ingest-project.mjs` | the engine behind `/sde` (code + session mining) |
| `crawl-*.mjs` | optional crawlers (daily notes, sessions, WhatsApp) |
| `fetch-videos.mjs` | attaches a YouTube video per topic |
| `data/` | **gitignored** runtime state (only the example seed is tracked) |

## Privacy

`data/` and `logs/` are gitignored on purpose: they hold your real learning
state, tutor conversations, and crawled third-party message text. Only
`data/curriculum.example.json` is committed. Keep it that way — never force-add
anything under `data/` except the example seed.
