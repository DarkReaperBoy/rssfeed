// 4chan read-only JSON API (https://github.com/4chan/4chan-API) → reader articles.
// Pure functions only — fetch.mjs owns all network I/O, the 1-request/second
// throttle, If-Modified-Since and the sanitize-html pipeline that these
// articles pass through, exactly like RSS bodies.
//
// Endpoint shapes used here:
//   https://a.4cdn.org/boards.json           → { boards: [{ board: "g", title: "/g/ - Technology", ws_board: 1 }] }
//   https://a.4cdn.org/<board>/catalog.json  → [ { threads: [ ... ] }, ... ]  (pages, bump order)
// Thread (OP) fields we consume: no, sub, com, name, time, replies, images,
// sticky, closed, tim, ext.

import crypto from 'node:crypto';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// OP comments are HTML-ish: <br> line breaks, <span class="quote"> greentext,
// <wbr> inside long words, HTML entities. Flatten to plain text.
export function stripChanHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Catalog JSON = array of pages, each page has `threads`. Flatten, drop junk.
export function chanThreadsFromCatalog(catalog) {
  const out = [];
  for (const page of Array.isArray(catalog) ? catalog : []) {
    for (const t of page?.threads || []) if (t && t.no) out.push(t);
  }
  return out;
}

// Per-board reply/image window + liveness rules (all optional in the feed config):
//   minReplies / maxReplies, minImages / maxImages — count window
//   includeSticky / includeClosed — stickies & closed threads are skipped by
//   default (page-1 sticky is the board rules post, not content)
export function chanThreadPasses(t, o = {}) {
  if (!t || !t.no) return false;
  const reps = Number(t.replies) || 0;
  const imgs = Number(t.images) || 0;
  if (o.minReplies > 0 && reps < o.minReplies) return false;
  if (o.maxReplies > 0 && reps > o.maxReplies) return false;
  if (o.minImages > 0 && imgs < o.minImages) return false;
  if (o.maxImages > 0 && imgs > o.maxImages) return false;
  if (t.sticky && !o.includeSticky) return false;
  if (t.closed && !o.includeClosed) return false;
  return true;
}

const cdn = (board, tail) => `https://i.4cdn.org/${board}/${tail}`;

// One catalog thread → one reader article. Content comes back UNSANITIZED —
// fetch.mjs runs it through the same sanitize-html pipeline as RSS bodies.
// Thread numbers never change, so sha1(link) is a stable deep-link id (same
// random-looking 16-hex scheme as RSS articles).
export function chanThreadToArticle(t, { board, worksafe = true, now = Date.now() } = {}) {
  const host = worksafe ? 'boards.4channel.org' : 'boards.4chan.org';
  const link = `https://${host}/${board}/thread/${t.no}`;
  const plain = stripChanHtml(t.com || '');
  const firstLine = plain.split('\n').map((s) => s.trim()).filter(Boolean)[0] || `Thread #${t.no}`;
  const title = (t.sub ? stripChanHtml(t.sub) : firstLine).slice(0, 140);
  const name = stripChanHtml(t.name || '');
  const replies = Number(t.replies) || 0;
  const images = Number(t.images) || 0;
  const parts = [];
  if (t.tim && t.ext) {
    // small square thumb in the body, linking to the full OP image
    parts.push(`<p><a href="${cdn(board, `${t.tim}${t.ext}`)}"><img src="${cdn(board, `${t.tim}s.jpg`)}" alt="OP image"></a></p>`);
  }
  if (t.com) parts.push(`<p>${t.com}</p>`);
  parts.push(`<p>${replies} replies · ${images} images · <a href="${link}">Open the thread</a></p>`);
  return {
    id: sha1(link).slice(0, 16),
    title,
    link,
    author: name && name !== 'Anonymous' ? name.slice(0, 120) : null,
    date: (Number(t.time) || Math.floor(now / 1000)) * 1000,
    summary: plain.slice(0, 300),
    content: parts.join('\n'),
    text: null,
    enclosures: t.tim ? [{ url: cdn(board, `${t.tim}s.jpg`), type: 'image/thumbnail' }] : [],
    fetchedAt: now,
  };
}
