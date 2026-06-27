// YouTube search without yt-dlp or an API key: fetch the public results page
// and parse the ytInitialData JSON blob it embeds. Returns videos with view
// counts and durations so callers can pick "most viewed, concise".

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function searchYouTube(query) {
  const url =
    "https://www.youtube.com/results?search_query=" + encodeURIComponent(query) + "&hl=en";
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`youtube search HTTP ${res.status}`);
  const html = await res.text();
  const marker = "var ytInitialData = ";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("ytInitialData not found (layout change or consent wall)");
  const jsonStart = start + marker.length;
  const end = html.indexOf(";</script>", jsonStart);
  if (end < 0) throw new Error("ytInitialData terminator not found");
  const data = JSON.parse(html.slice(jsonStart, end));

  const videos = [];
  walk(data, (node) => {
    const v = node.videoRenderer;
    if (!v || !v.videoId) return;
    videos.push({
      id: v.videoId,
      url: "https://www.youtube.com/watch?v=" + v.videoId,
      title: textOf(v.title),
      channel: textOf(v.ownerText) || textOf(v.longBylineText),
      views: parseViews(textOf(v.viewCountText)),
      duration_sec: parseDuration(v.lengthText?.simpleText),
      duration: v.lengthText?.simpleText || null,
    });
  });
  return videos;
}

// Most-viewed video between minSec and maxSec for a query. Falls back to the
// most-viewed of any length if nothing fits the duration window.
export async function bestVideo(query, { minSec = 120, maxSec = 1500 } = {}) {
  const videos = await searchYouTube(query);
  if (!videos.length) return null;
  const ranked = [...videos].sort((a, b) => (b.views || 0) - (a.views || 0));
  const concise = ranked.find(
    (v) => v.duration_sec != null && v.duration_sec >= minSec && v.duration_sec <= maxSec
  );
  return concise || ranked[0];
}

function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const key of Object.keys(node)) walk(node[key], fn);
}

function textOf(t) {
  if (!t) return "";
  if (t.simpleText) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join("");
  return "";
}

// "1,234,567 views" / "1.2M views" -> number
function parseViews(s) {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/([\d.]+)\s*([KMB])?\s*views/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2]) n *= { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()];
  return Math.round(n);
}

// "12:34" / "1:02:03" -> seconds
function parseDuration(s) {
  if (!s) return null;
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  return parts.reduce((a, p) => a * 60 + p, 0);
}
