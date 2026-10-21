#!/usr/bin/env node
// Fetcher run by GitHub Actions (hourly). Reads config.json, downloads every
// enabled feed, optionally extracts clean full text (readability + sanitize),
// merges with previously stored data, applies the retention window and writes
// data/index.json + data/feeds/<id>.json. Never fails the run on a single feed.

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
const TEXT_EXTRACT_AGE_DAYS = 30;   // only extract text for articles newer than this
const TEXT_EXTRACT_BUDGET = 20;     // max page fetches per feed per run
const TEXT_EXTRACT_MIN_LEN = 400;   // don't bother extracting if the feed already gives this much text

const parser = new Parser({
  timeout: 30000,
  headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
  customFields: { item: [['media:content', 'mediaContent', { keepArray: true }], ['media:thumbnail', 'mediaThumbnail']] },
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
    .replace(/&#\d+;/g, ' ')
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
    // Neutralize scripts before readability runs.
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
  const raw = item['content:encoded'] || item.content || item.description || item.summary || item.contentSnippet || '';
  return typeof raw === 'string' ? raw : String(raw ?? '');
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
  for (const l of item.links || []) if (l.rel === 'enclosure') push(l.href, l.type);
  return out;
}

async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function main() {
  const config = await loadJson(path.join(ROOT, 'config.json'), null);
  if (!config?.feeds?.length) {
    console.error('config.json missing or has no feeds');
    process.exit(1);
  }
  const settings = config.settings || {};
  const perFeedCap = Math.max(50, Number(settings.articlesPerFeed) || 200);
  const retentionDays = Number(settings.retentionDays);
  const retainMs = retentionDays > 0 ? retentionDays * 864e5 : 0;
  const fullTextDefault = !!settings.fullTextDefault;

  await fs.mkdir(FEEDS_DIR, { recursive: true });
  const now = Date.now();
  const index = { generatedAt: now, feeds: {} };
  let failures = 0;

  for (const feed of config.feeds) {
    if (!feed.id || !feed.url) { console.warn(`skip (no id/url): ${JSON.stringify(feed)}`); continue; }
    if (feed.enabled === false) {
      const prev = await loadJson(path.join(FEEDS_DIR, `${feed.id}.json`), null);
      if (prev) index.feeds[feed.id] = summarizeFeed(feed, prev.articles, now);
      console.log(`[${feed.id}] disabled, keeping ${prev?.articles?.length ?? 0} articles`);
      continue;
    }

    const file = path.join(FEEDS_DIR, `${feed.id}.json`);
    const prev = await loadJson(file, { articles: [] });
    const prevById = new Map((prev.articles || []).map((a) => [a.id, a]));

    let xml;
    try {
      const res = await fetch(feed.url, { headers: parser.options.headers, signal: AbortSignal.timeout(35000), redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      xml = await res.text();
    } catch (err) {
      failures++;
      console.error(`[${feed.id}] FETCH FAILED: ${err.message} — keeping previous ${prev.articles?.length ?? 0} articles`);
      if (prev.articles) index.feeds[feed.id] = summarizeFeed(feed, prev.articles, now);
      continue;
    }

    let parsed;
    try {
      parsed = await parser.parseString(xml);
    } catch (err) {
      failures++;
      console.error(`[${feed.id}] PARSE FAILED: ${err.message}`);
      if (prev.articles) index.feeds[feed.id] = summarizeFeed(feed, prev.articles, now);
      continue;
    }

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
      if (wantText && !text && !feedGivesEnough && textBudget > 0 && now - date < TEXT_EXTRACT_AGE_DAYS * 864e5 && link) {
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

    // Merge with previous so ids stay stable and old-but-relevant items survive.
    const byId = new Map();
    for (const a of [...(prev.articles || []), ...articles]) byId.set(a.id, a);
    let merged = [...byId.values()].sort((a, b) => b.date - a.date);
    // Retention window: keep everything recent + the newest perFeedCap regardless of age.
    if (retainMs > 0) merged = merged.filter((a) => now - a.date < retainMs);
    if (merged.length > perFeedCap) merged = merged.slice(0, perFeedCap);

    await fs.writeFile(file, JSON.stringify({ articles: merged }));
    index.feeds[feed.id] = summarizeFeed(feed, merged, now);
    console.log(`[${feed.id}] ${merged.length} articles (${(await fs.stat(file)).size / 1024 | 0} KB) from "${parsed.title || feed.title}"`);
  }

  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(index));
  console.log(`done: ${Object.keys(index.feeds).length} feeds, ${failures} failure(s)`);
}

function summarizeFeed(feed, articles, now) {
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

main().catch((err) => { console.error(err); process.exit(1); });
