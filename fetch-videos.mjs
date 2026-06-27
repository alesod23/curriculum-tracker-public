// Fill topic.video for every curriculum topic: the most-viewed concise
// (2-25 min) YouTube video when searching the topic term.
//
// Run: node fetch-videos.mjs              (only topics with no video yet)
//      node fetch-videos.mjs --force      (re-fetch all)
//      node fetch-videos.mjs --topic css-layout   (one topic, implies force)

import { loadCurriculum, saveCurriculum } from "./lib/store.mjs";
import { bestVideo } from "./lib/yt-search.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const onlyTopic = args.includes("--topic") ? args[args.indexOf("--topic") + 1] : null;

const curriculum = await loadCurriculum();
if (!curriculum) {
  console.error("data/curriculum.json missing — run migrate.mjs first");
  process.exit(1);
}

// Project topics ("Project: Dasmoto's...") are exercises, not concepts — a
// generic YouTube video adds nothing there.
const isProject = (t) => /^project:/i.test(t.title);

let done = 0, skipped = 0, failed = 0;
for (const phase of curriculum.phases) {
  for (const topic of phase.topics) {
    if (onlyTopic && topic.id !== onlyTopic) continue;
    if (!onlyTopic && !force && topic.video) { skipped++; continue; }
    if (isProject(topic)) { skipped++; continue; }

    const query = `${topic.title} explained`;
    try {
      const v = await bestVideo(query);
      if (v) {
        topic.video = {
          url: v.url,
          title: v.title,
          channel: v.channel,
          views: v.views,
          duration: v.duration,
          query,
          fetched_at: new Date().toISOString(),
        };
        done++;
        console.log(`[ok] ${topic.id} -> ${v.title} (${v.duration}, ${fmtViews(v.views)})`);
      } else {
        failed++;
        console.log(`[--] ${topic.id} -> no results for "${query}"`);
      }
    } catch (e) {
      failed++;
      console.log(`[!!] ${topic.id} -> ${e.message}`);
    }
    // Be polite to YouTube; also avoids rate-limit walls killing the run.
    await new Promise((r) => setTimeout(r, 1200));
  }
}

await saveCurriculum(curriculum);
console.log(`videos: ${done} fetched, ${skipped} skipped, ${failed} failed`);

function fmtViews(n) {
  if (n == null) return "? views";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M views";
  if (n >= 1e3) return Math.round(n / 1e3) + "K views";
  return n + " views";
}
