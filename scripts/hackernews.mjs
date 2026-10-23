import crypto from 'node:crypto';
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
export function hnFeedOptions(feed) {
  const minPoints = Number(feed?.minPoints) > 0 ? Number(feed.minPoints) : 0;
  const minComments = Number(feed?.minComments) > 0 ? Number(feed.minComments) : 0;
  return { minPoints, minComments };
}
export function hnApiUrl(feed, { retentionDays = 30, now = Date.now(), fromSec = 0, toSec = 0 } = {}) {
  const { minPoints, minComments } = hnFeedOptions(feed);
  const base = 'https://hn.algolia.com/api/v1';
  if (!minPoints && !minComments) {
    return `${base}/search?tags=front_page&hitsPerPage=100`;
  }
  const parts = [`created_at_i>${fromSec > 0 ? fromSec : Math.floor(now / 1000) - Math.max(1, retentionDays) * 86400}`];
  if (toSec > 0) parts.push(`created_at_i<=${toSec}`);
  if (minPoints) parts.push(`points>=${minPoints}`);
  if (minComments) parts.push(`num_comments>=${minComments}`);
  const filters = parts.map((p) => encodeURIComponent(p)).join(',');
  return `${base}/search_by_date?tags=story&numericFilters=${filters}&hitsPerPage=1000`;
}
export async function hnFetchAllPages(doFetch, feed, { retentionDays = 30, now = Date.now(), maxRequests = 6 } = {}) {
  const nowSec = Math.floor(now / 1000);
  const startSec = nowSec - Math.max(1, retentionDays) * 86400;
  const { minPoints, minComments } = hnFeedOptions(feed);
  const splittable = !!(minPoints || minComments);
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
    if (splittable && nbHits > pageHits.length && requests < maxRequests) {
      const mid = Math.floor((fromSec + (toSec || nowSec)) / 2);
      await fetchRange(mid, toSec);    
      await fetchRange(fromSec, mid);  
      return;
    }
    if (nbHits > pageHits.length) truncated = true;
    hits.push(...pageHits);
  };
  await fetchRange(startSec, 0, true);
  const seen = new Set();
  const unique = [];
  for (const h of hits) {
    if (!h?.objectID) continue;
    if (seen.has(h.objectID)) continue;
    seen.add(h.objectID);
    unique.push(h);
  }
  return { hits: unique, requests, truncated };
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
export function hnHitToArticle(hit, { now = Date.now() } = {}) {
  const oid = String(hit?.objectID || '');
  const itemUrl = `https://news.ycombinator.com/item?id=${oid}`;
  const points = Number(hit?.points) || 0;
  const comments = Number(hit?.num_comments) || 0;
  const extUrl = typeof hit?.url === 'string' && /^https?:\/\//i.test(hit.url.replace(/[\s\u0000-\u001f]+/g, '')) ? hit.url : '';
  const link = extUrl || itemUrl; 
  const title = (stripHnHtml(hit?.title) || '(untitled)').slice(0, 200);
  const storyText = typeof hit?.story_text === 'string' ? hit.story_text : '';
  const plainText = stripHnHtml(storyText);
  const parts = [
    `<p>${points} points · ${comments} comments · <a href="${itemUrl}">Discuss on Hacker News</a></p>`,
  ];
  if (storyText) parts.push(/<p[\s>]/i.test(storyText) ? storyText : `<p>${storyText}</p>`); 
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