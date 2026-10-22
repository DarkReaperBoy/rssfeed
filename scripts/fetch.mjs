#!/usr/bin/env node
// Fetcher run by GitHub Actions (hourly). Keeps last 30 days of articles with no per-feed cap.
// Tracks fetch status per feed and purges feeds removed from config.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA_DIR = path.join(ROOT, 'data');
const FEEDS_DIR = path.join(DATA_DIR, 'feeds');
const UA = 'Mozilla/5.0 (compatible; ghrss-fetcher/1.0; +https://github.com/)';
const TEXT_EXTRACT_AGE_DAYS = 30;
const TEXT_EXTRACT_BUDGET = 20;
const TEXT_EXTRACT_MIN_LEN = 400;
const RETENTION_DAYS = 30;

const parser = new Parser({
  timeout: 30000,
  headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
  customFields: { item: [['media:group', 'mediaGroup'], ['media:content', 'mediaContent', { keepArray: true }], ['media:thumbnail', 'mediaThumbnail']] },
});

const sanitizeOpts = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'h1', 'h2', 'figure', 'figcaption', 'picture', 'source', 'video', 'audio', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'blockquote', 'pre', 'code', 'iframe', 'button', 'span', 'center',
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ['href', 'title', 'rel', 'target'],
    img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
    source: ['src', 'type', 'srcset'],
    video: ['src', 'controls', 'width', 'height', 'poster', 'preload'],
    audio: ['src', 'controls', 'preload'],
    iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'loading', 'title'],
    '*': ['class', 'style'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'data'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'], iframe: ['https'], video: ['https'], audio: ['https'] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tag, attrs) => ({
      tagName: 'a',
      attribs: { ...attrs, rel: 'noopener noreferrer', target: '_blank' },
    }),
    iframe: (tag, attrs) => {
      const src = attrs.src || '';
      const ok = /^https:\/\/(www\.)?(youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/|soundcloud\.com\/)/.test(src);
      return ok ? { tagName: 'iframe', attribs: attrs } : { tagName: 'div', attribs: { 'data-blocked-embed': src } };
    },
  },
};
const sanitize = (html) => sanitizeHtml(html || '', sanitizeOpts);

const stripTags = (html) =>
  (html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x[0-9a-f]+;/gi, ' ')
    .replace(/&#\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const stableId = (link, title) => (sha1(`${link}|${title}`).slice(0, 16));

async function fetchText(url, { maxBytes = 5_000_000 } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type && !/html|xml/.test(type)) return null;
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) return null;
  return buf.toString('utf8');
}

async function extractFullText(link) {
  if (!/^https?:\/\//.test(link || '')) return null;
  const html = await fetchText(link);
  if (!html) return null;
  const dom = new JSDOM(html, { url: link, runScripts: 'outside-only' });
  try {
    for (const s of [...dom.window.document.querySelectorAll('script, noscript, iframe[src*="doubleclick"], ins')]) s.remove();
    const reader = new Readability(dom.window.document);
    const parsed = reader.parse();
    if (!parsed || !parsed.content) return null;
    const clean = sanitize(parsed.content);
    return stripTags(clean).length >= 120 ? clean : null;
  } finally {
    dom.window.close();
  }
}

function pickDate(item) {
  for (const v of [item.isoDate, item.pubDate, item.published, item.updated, item.created]) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function pickContent(item) {
  let raw = item['content:encoded'] || item.content || item.description || item.summary || item.contentSnippet || '';
  if (!raw && item.mediaGroup) {
    const desc = item.mediaGroup['media:description'];
    raw = Array.isArray(desc) ? (desc[0] || '') : (desc?._ || desc || '');
  }
  raw = typeof raw === 'string' ? raw : String(raw ?? '');
  // Linkify bare URLs so embeds (YouTube etc.) can be upgraded client-side.
  if (raw && !/<a\s/i.test(raw)) {
    raw = raw.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  }
  return raw;
}

function pickEnclosures(item) {
  const out = [];
  const push = (url, type) => {
    if (url && /^https?:\/\//.test(url)) out.push({ url, type: (type || '').split(';')[0].trim() });
  };
  for (const e of item.enclosures || []) push(e.url, e.type);
  for (const m of item.mediaContent || []) push(m.$?.url, m.$?.['media:content'] || m.$?.type);
  const thumb = item.mediaThumbnail?.$?.url;
  if (thumb) push(thumb, 'image/thumbnail');
  // YouTube Atom feeds nest media inside media:group.
  const mg = item.mediaGroup;
  if (mg) {
    for (const m of mg['media:content'] || []) push(m.$?.url, m.$?.type);
    const t = (mg['media:thumbnail'] || [])[0]?.$?.url;
    if (t) push(t, 'image/thumbnail');
    const desc = mg['media:description'];
    // nothing to push
  }
  for (const l of item.links || []) if (l.rel === 'enclosure') push(l.href, l.type);
  return out;
}

async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

function summarizeFeed(feed, articles) {
  const sorted = [...articles].sort((a, b) => b.date - a.date);
  const folders = Array.isArray(feed.folders) ? feed.folders.filter(Boolean) : (feed.folder ? [feed.folder] : []);
  return {
    title: feed.title || feed.id,
    site: feed.site || '',
    folder: folders[0] || null,
    folders,
    count: articles.length,
    newest: sorted[0]?.date || null,
    oldest: sorted[sorted.length - 1]?.date || null,
  };
}

async function main() {
  const config = await loadJson(path.join(ROOT, 'config.json'), null);
  if (!config?.feeds?.length) {
    console.error('config.json missing or has no feeds');
    process.exit(1);
  }
  const settings = config.settings || {};
  const fullTextDefault = !!settings.fullTextDefault;
  const retentionDays = Number(settings.retentionDays) > 0 ? Number(settings.retentionDays) : RETENTION_DAYS;

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(FEEDS_DIR, { recursive: true });

  const now = Date.now();
  const retainMs = retentionDays * 86400000;

  // Load previous index for status/history
  const prevIndex = await loadJson(path.join(DATA_DIR, 'index.json'), { generatedAt: 0, feeds: {} });
  const prevFeedMeta = prevIndex.feeds || {};

  const index = { generatedAt: now, feeds: {} };
  let failures = 0;

  const currentFeedIds = new Set();

  for (const feed of config.feeds) {
    if (!feed.id || !feed.url) {
      console.warn(`skip (no id/url): ${JSON.stringify(feed)}`);
      continue;
    }
    currentFeedIds.add(feed.id);

    const file = path.join(FEEDS_DIR, `${feed.id}.json`);
    const prev = await loadJson(file, { articles: [] });
    const prevById = new Map((prev.articles || []).map((a) => [a.id, a]));

    const prevStatus = prevFeedMeta[feed.id]?.status || {};
    const status = {
      ok: true,
      lastAttempt: now,
      lastSuccess: prevStatus.lastSuccess || null,
      consecutiveFailures: prevStatus.consecutiveFailures || 0,
      error: null,
    };

    if (feed.enabled === false) {
      // Keep existing articles but filter to 30 days
      let kept = [...(prev.articles || [])].filter((a) => now - a.date < retainMs);
      await fs.writeFile(file, JSON.stringify({ articles: kept }));
      index.feeds[feed.id] = {
        ...summarizeFeed(feed, kept),
        status: {
          ok: false,
          disabled: true,
          lastAttempt: now,
          lastSuccess: status.lastSuccess,
          consecutiveFailures: 0,
          error: 'Feed disabled in config',
        },
      };
      console.log(`[${feed.id}] disabled, keeping ${kept.length} articles (last 30 days)`);
      continue;
    }

    let xml;
    try {
      const res = await fetch(feed.url, { headers: parser.options.headers, signal: AbortSignal.timeout(35000), redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      xml = await res.text();
    } catch (err) {
      failures++;
      status.ok = false;
      status.error = err.message;
      status.consecutiveFailures = (prevStatus.consecutiveFailures || 0) + 1;
      // Keep previous articles, filter to 30 days
      let kept = [...(prev.articles || [])].filter((a) => now - a.date < retainMs);
      await fs.writeFile(file, JSON.stringify({ articles: kept }));
      index.feeds[feed.id] = {
        ...summarizeFeed(feed, kept),
        status,
      };
      console.error(`[${feed.id}] FETCH FAILED: ${err.message} — keeping ${kept.length} articles from last 30 days (${status.consecutiveFailures} consecutive failures)`);
      continue;
    }

    let parsed;
    try {
      parsed = await parser.parseString(xml);
    } catch (err) {
      failures++;
      status.ok = false;
      status.error = `Parse error: ${err.message}`;
      status.consecutiveFailures = (prevStatus.consecutiveFailures || 0) + 1;
      let kept = [...(prev.articles || [])].filter((a) => now - a.date < retainMs);
      await fs.writeFile(file, JSON.stringify({ articles: kept }));
      index.feeds[feed.id] = {
        ...summarizeFeed(feed, kept),
        status,
      };
      console.error(`[${feed.id}] PARSE FAILED: ${err.message} — keeping ${kept.length} articles from last 30 days`);
      continue;
    }

    // Success
    status.ok = true;
    status.lastSuccess = now;
    status.consecutiveFailures = 0;
    status.error = null;

    const wantText = feed.fullText ?? fullTextDefault;
    let textBudget = wantText ? TEXT_EXTRACT_BUDGET : 0;
    const articles = [];
    for (const item of parsed.items || []) {
      const title = stripTags(item.title || '(untitled)') || '(untitled)';
      const link = item.link || item.guid || '';
      const id = stableId(link || title, title);
      const date = pickDate(item) || now;
      const content = pickContent(item);
      const prevA = prevById.get(id);
      const summary = stripTags(content).slice(0, 300);
      let text = prevA?.text || null;
      const feedGivesEnough = stripTags(content).length >= TEXT_EXTRACT_MIN_LEN;
      if (wantText && !text && !feedGivesEnough && textBudget > 0 && now - date < retentionDays * 86400000 && link) {
        textBudget--;
        try {
          text = await extractFullText(link);
          if (text) console.log(`[${feed.id}] extracted text: ${title.slice(0, 60)}`);
        } catch (err) {
          console.warn(`[${feed.id}] extract failed for ${link}: ${err.message}`);
        }
      }
      articles.push({
        id,
        title,
        link,
        author: stripTags(item.creator || item.author || '').slice(0, 120) || null,
        date,
        summary,
        content: sanitize(content),
        text,
        enclosures: pickEnclosures(item),
        fetchedAt: now,
      });
    }

    // Merge with previous so ids stay stable
    const byId = new Map();
    for (const a of [...(prev.articles || []), ...articles]) byId.set(a.id, a);
    let merged = [...byId.values()].sort((a, b) => b.date - a.date);
    // Keep only last 30 days, NO article limit
    merged = merged.filter((a) => now - a.date < retainMs);

    await fs.writeFile(file, JSON.stringify({ articles: merged }));
    index.feeds[feed.id] = {
      ...summarizeFeed(feed, merged),
      status,
    };
    console.log(`[${feed.id}] ${merged.length} articles (last 30 days, no cap) from "${parsed.title || feed.title}"`);
  }

  // Purge removed sources
  for (const [oldId] of Object.entries(prevFeedMeta)) {
    if (!currentFeedIds.has(oldId)) {
      try {
        await fs.unlink(path.join(FEEDS_DIR, `${oldId}.json`));
        console.log(`[${oldId}] removed from config - purged feed data`);
      } catch {}
    }
  }

  // Consolidated single-file payload for the frontend (fast initial load)
  const allArticles = [];
  for (const id of currentFeedIds) {
    const d = await loadJson(path.join(FEEDS_DIR, `${id}.json`), { articles: [] });
    for (const a of (d.articles || [])) allArticles.push({ ...a, _feed: id });
  }
  await fs.writeFile(path.join(DATA_DIR, 'all-feeds.json'), JSON.stringify({ articles: allArticles }));

  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(index));
  console.log(`done: ${Object.keys(index.feeds).length} feeds, ${failures} failure(s), keeping last ${retentionDays} days (no per-feed cap)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
