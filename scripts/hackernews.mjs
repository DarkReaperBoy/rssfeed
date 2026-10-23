// Hacker News → reader articles, via the HN Search API on Algolia
// (https://hn.algolia.com/api — the API HN's own search box uses, no key).
// Pure functions only — fetch.mjs owns all network I/O and the sanitize-html
// pipeline these articles pass through, exactly like RSS bodies.
//
// Endpoint shapes used here:
//   /api/v1/search?tags=front_page&hitsPerPage=100
//       → the actual HN front page (~30 items), used when no caps are configured
//   /api/v1/search_by_date?tags=story&numericFilters=created_at_i>…,points>=…,num_comments>=…
//       → newest-first within the retention window, server-side AND caps
// Hit fields we consume: objectID, title, url, author, points, num_comments,
// created_at (ISO), story_text (self-post HTML, Ask HN etc.).

import crypto from 'node:crypto';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Feed caps: minPoints / minComments, both optional.
//   both set  → a story must meet BOTH (AND)
//   one set   → only that one applies
//   none set  → no filtering: mirror the live front page instead
export function hnFeedOptions(feed) {
  const minPoints = Number(feed?.minPoints) > 0 ? Number(feed.minPoints) : 0;
  const minComments = Number(feed?.minComments) > 0 ? Number(feed.minComments) : 0;
  return { minPoints, minComments };
}

export function hnApiUrl(feed, { retentionDays = 30, now = Date.now(), fromSec = 0, toSec = 0 } = {}) {
  const { minPoints, minComments } = hnFeedOptions(feed);
  const base = 'https://hn.algolia.com/api/v1';
  if (!minPoints && !minComments) {
    // No caps configured: serve the real HN front page (what HN itself shows).
    return `${base}/search?tags=front_page&hitsPerPage=100`;
  }
  // Cap mode: newest-first within the retention window. numericFilters entries
  // are comma-joined = AND on the server, matching the both-caps semantics;
  // a single cap simply omits the other condition. The created_at window keeps
  // the response to recent stories (Algolia's index covers all of history).
  // fromSec/toSec override the window bounds (<= on the upper edge) — that is
  // how hnFetchAllPages slices a window too wide for one response.
  const parts = [`created_at_i>${fromSec > 0 ? fromSec : Math.floor(now / 1000) - Math.max(1, retentionDays) * 86400}`];
  if (toSec > 0) parts.push(`created_at_i<=${toSec}`);
  if (minPoints) parts.push(`points>=${minPoints}`);
  if (minComments) parts.push(`num_comments>=${minComments}`);
  const filters = parts.map((p) => encodeURIComponent(p)).join(',');
  return `${base}/search_by_date?tags=story&numericFilters=${filters}&hitsPerPage=1000`;
}

// Algolia's search index truncates at 1000 hits AND reports nbPages: 1 while
// doing it (verified live: nbHits 1388, 1000 hits returned, &page=1 → empty),
// so page offsets can never reach a window wider than ~5 weeks at the shipped
// caps. Instead: fetch the whole window; when nbHits exceeds what came back,
// split the range into two date halves and fetch both — recursively, so any
// story density resolves. `doFetch` is injected so tests drive this without
// network: it receives a URL and returns { ok, status, json }.
//   root request failing   → throws (the feed reports failure, old data kept)
//   a half failing         → soft miss (the merge holds stored stories; the
//                           next hourly run heals the gap)
//   maxRequests exhausted  → stops splitting, sets truncated (self-heals)
export async function hnFetchAllPages(doFetch, feed, { retentionDays = 30, now = Date.now(), maxRequests = 6 } = {}) {
  const nowSec = Math.floor(now / 1000);
  const startSec = nowSec - Math.max(1, retentionDays) * 86400;
  const hits = [];
  let requests = 0;
  let truncated = false;
  const fetchRange = async (fromSec, toSec = 0, root = false) => {
    if (requests >= maxRequests) { truncated = true; return; }
    requests++;
    let json;
    try {
      const res = await doFetch(hnApiUrl(feed, { now, fromSec, toSec }));
      if (!res.ok) {
        if (root) { const err = new Error(`HTTP ${res.status}`); err.code = 'HTTP'; throw err; }
        return;
      }
      json = await res.json();
    } catch (err) {
      if (root) throw err;
      return;
    }
    const pageHits = Array.isArray(json?.hits) ? json.hits : [];
    const nbHits = Number(json?.nbHits) || 0;
    if (nbHits > pageHits.length && requests < maxRequests) {
      // Truncated at the 1000-hit cap: cover this exact range via two halves.
      const mid = Math.floor((fromSec + (toSec || nowSec)) / 2);
      await fetchRange(mid, toSec);    // newer half: (mid, toSec]
      await fetchRange(fromSec, mid);  // older half: (fromSec, mid]
      return;
    }
    if (nbHits > pageHits.length) truncated = true;
    hits.push(...pageHits);
  };
  await fetchRange(startSec, 0, true);
  return { hits, requests, truncated };
}

const stripHnHtml = (html) =>
  String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

// One Algolia hit → one reader article. Content comes back UNSANITIZED —
// fetch.mjs runs it through the same sanitize-html pipeline as RSS bodies.
// objectID is HN's item number: it never changes (title edits don't rekey),
// so sha1("hn|<objectID>") is the most stable id any source can offer.
export function hnHitToArticle(hit, { now = Date.now() } = {}) {
  const oid = String(hit?.objectID || '');
  const itemUrl = `https://news.ycombinator.com/item?id=${oid}`;
  const points = Number(hit?.points) || 0;
  const comments = Number(hit?.num_comments) || 0;
  const link = hit?.url || itemUrl; // Ask HN / polls have no external url
  const title = (stripHnHtml(hit?.title) || '(untitled)').slice(0, 200);
  const storyText = typeof hit?.story_text === 'string' ? hit.story_text : '';
  const plainText = stripHnHtml(storyText);
  const parts = [
    `<p>${points} points · ${comments} comments · <a href="${itemUrl}">Discuss on Hacker News</a></p>`,
  ];
  if (storyText) parts.push(`<p>${storyText}</p>`);
  return {
    id: sha1(`hn|${oid}`).slice(0, 16),
    title,
    link,
    author: hit?.author || null,
    date: Date.parse(hit?.created_at) || now,
    summary: (plainText || `${points} points · ${comments} comments on Hacker News`).slice(0, 300),
    content: parts.join('\n'),
    text: null,
    enclosures: [],
    fetchedAt: now,
  };
}
