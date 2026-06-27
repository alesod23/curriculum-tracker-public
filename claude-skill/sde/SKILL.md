---
name: sde
description: >
  SDE curriculum source — mark one of your own Claude-Code-built tools as a
  source for your software-engineering learning curriculum. Mines BOTH the
  project's handmade source code AND the Claude Code build-session transcript,
  classifies every excerpt against the curriculum topics, and drops the matches
  into the curriculum app's backlog in that project's own section (NOT straight
  into the curriculum — you review/approve them there). Use when the user says
  "/sde", "sde", "source this project", "add this to my curriculum sources",
  "curriculum source", "make this a curriculum source", or points at a project/tool
  they built and want it to feed their learning tracker.
---

# SDE Curriculum Source (`/sde`)

Ingest one of your own projects into the curriculum app's backlog as
project-tagged example material. The curriculum app lives in the
`curriculum-server` repo and serves `localhost:4117`.

This is the "drop into a Raw folder" step for your OWN tools (distinct from the
optional daily WhatsApp-group crawl). It mines **both** the code and the build
session.

## Steps

1. **Resolve the project.** Determine the project directory:
   - If the user named a project/path, use it.
   - If ambiguous, list the plausible candidates and ask which (one short question).
   - The project `--name` defaults to the directory's basename; keep it stable
     across re-ingests (dedup keys on it).

2. **Find the build session(s).** The build-session transcripts are JSONL files
   in your Claude Code projects directory (the same path you set as
   `CLAUDE_PROJECTS_DIR`). Find the ones that actually built this project by
   searching for the project path or name:
   - Use a content search over that directory for the project folder name
     (and/or an absolute path fragment). Collect the matching `*.jsonl` files.
   - If the project is being built right now, the active session counts too —
     include the most recent matching transcript(s). Pass up to ~3; more just
     adds noise.
   - If none match, proceed code-only (omit `--session`) and say so.

3. **Make sure the server is up** (the script doesn't need it, but the review UI
   does): check whether something is listening on port 4117; if not, run
   `start.ps1` (or `npm start`).

4. **Run the ingest** from the `curriculum-server` dir:
   ```
   node ingest-project.mjs --path "<project dir>" --name "<name>" --session "<jsonl1>" --session "<jsonl2>"
   ```
   (Drop `--session` entirely for code-only.) It walks handmade source (skipping
   node_modules/.next/dist/build/lockfiles/minified/generated), pulls substantive
   build-session excerpts, classifies both against all topics, and appends PENDING
   items tagged `kind:"project"`, `project:"<name>"` to `data/inbox.json`, and
   registers the project in `data/sources.json`.

5. **Report** the counts (files, session excerpts, matches, new items) and point
   to:
   - **Backlog tab** → the `Project: <name>` section, where new/weak-topic items
     are flagged and sorted first ("suggested first"), and
   - **Projects tab** → the per-project view of topics you've enriched.

## Notes
- Re-running is idempotent: dedup is on `(project, origin, topic)`, so
  re-ingesting after adding files only adds the new matches.
- Approving a project item attaches it to the topic as an example with
  `project:"<name>"`, which is what populates the Projects view.
- The review itself (deciding which items to approve, prioritizing new/weak
  topics) happens in the app; the app already pre-sorts and flags. For a "project
  review", read `data/inbox.json` + `data/curriculum.json` and recommend the
  project items whose target topic is `untouched` or low `strength` first.
