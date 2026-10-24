import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import { chanThreadsFromCatalog, chanThreadPasses, chanThreadToArticle } from './4chan.mjs';
import { hnHitToArticle, hnFeedOptions, hnFetchAllPages } from './hackernews.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const FEEDS_DIR = path.join(DATA_DIR, 'feeds');
const UA = 'Mozilla/5.0 (compatible; ghrss-fetcher/1.0; +https://github.com/DarkReaperBoy/rssfeed)';
const TEXT_EXTRACT_BUDGET = 20;
const TEXT_EXTRACT_MIN_LEN = 400;
const DEFAULT_RETENTION_DAYS = 60; 
const FETCH_CONCURRENCY = 5;       
const parser = new Parser({
  headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
  customFields: { item: [['media:group', 'mediaGroup'], ['media:content', 'mediaContent', { keepArray: true }], ['media:thumbnail', 'mediaThumbnail'], ['enclosure', 'enclosures', { keepArray: true }]] },
});
const sanitizeOpts = {
  allowedTags: [...new Set(sanitizeHtml.defaults.allowedTags.concat([
    'img', 'h1', 'h2', 'figure', 'figcaption', 'picture', 'source', 'video', 'audio', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'blockquote', 'pre', 'code', 'iframe', 'span',
  ]))],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ['href', 'title', 'rel', 'target'],
    img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading', 'decoding', 'referrerpolicy'],
    source: ['src', 'type', 'srcset'],
    video: ['src', 'controls', 'width', 'height', 'poster', 'preload'],
    audio: ['src', 'controls', 'preload'],
    iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'loading', 'title'],
    div: ['data-blocked-embed'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'], iframe: ['https'], video: ['https'], audio: ['https'] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tag, attrs) => ({
      tagName: 'a',
      attribs: { ...attrs, rel: 'noopener noreferrer', target: '_blank' },
    }),
    img: (tag, attrs) => ({
      tagName: 'img',
      attribs: { ...attrs, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' },
    }),
    iframe: (tag, attrs) => {
      const src = attrs.src || '';
      const ok = /^https:\/\/(www\.)?(youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/|w\.soundcloud\.com\/player\/)/.test(src);
      return ok ? { tagName: 'iframe', attribs: attrs } : { tagName: 'div', attribs: { 'data-blocked-embed': src } };
    },
  },
};
export const sanitize = (html) => sanitizeHtml(html || '', sanitizeOpts);
export const stripTags = (html) =>
  (html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (m, dec) => { try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ' '; } })
    .replace(/&mdash;/gi, '\u2014').replace(/&ndash;/gi, '\u2013').replace(/&hellip;/gi, '\u2026')
    .replace(/&rsquo;|&lsquo;/gi, "'").replace(/&rdquo;|&ldquo;/gi, '"').replace(/&middot;/gi, '\u00b7')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
export const stableId = (key) => sha1(String(key)).slice(0, 16);
const isYouTubeFeed = (url) => /(?:^https?:\/\/)(?:www\.)?youtube\.com\/feeds\//i.test(url || '');
export function isShortItem(link, title, content) {
  if (/\/shorts\//i.test(link || '')) return true;
  return /(^|[\s>([\]])#shorts?(?![\w])/i.test(`${title || ''} ${stripTags(content || '')}`);
}
export function compileMatcherSrv(v) {
  const s = String(v);
  const m = s.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    let flags = (m[2] || '').replace(/g/g, '');
    if (!flags.includes('i')) flags += 'i';
    try { const re = new RegExp(m[1], flags); return (hay) => re.test(String(hay || '')); }
    catch { return () => false; }
  }
  const lc = s.toLowerCase();
  return (hay) => String(hay || '').toLowerCase().includes(lc);
}
export function compileBlockSrv(block) {
  const out = {};
  for (const [field, norm] of [['title', 'title'], ['content', 'content'], ['subject', 'subject'], ['capcode', 'capcode'], ['author', 'author'], ['authors', 'author'], ['link', 'link'], ['links', 'link']]) {
    const arr = block?.[field];
    if (Array.isArray(arr) && arr.length) {
      if (!out[norm]) out[norm] = [];
      out[norm].push(...arr.map(compileMatcherSrv));
    }
  }
  return Object.keys(out).length ? out : null;
}
function blockHay(a, field) {
  if (field === 'title') return a.title || '';
  if (field === 'content') return stripTags(a.content || '') + ' ' + (a.summary || '');
  if (field === 'subject') return a.subject || '';
  if (field === 'capcode') return a.capcode || '';
  if (field === 'author') return a.author || '';
  return a.link || '';
}
function blockMatchesSrv(block, a) {
  for (const [field, matchers] of Object.entries(block)) {
    if (!matchers.some((fn) => fn(blockHay(a, field)))) return false; 
  }
  return true;
}
const asBlockArr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
export function compileBlockArrSrv(v) {
  if (!v) return null;
  const blocks = asBlockArr(v).map(compileBlockSrv).filter(Boolean);
  return blocks.length ? blocks : null;
}
export function feedFilterDrop(a, blocks) {
  if (!blocks) return false;
  if (asBlockArr(blocks.exclude).some((b) => blockMatchesSrv(b, a))) return true;
  const inc = asBlockArr(blocks.include);
  if (inc.length && !inc.some((b) => blockMatchesSrv(b, a))) return true;
  return false;
}
function compileFeedFilter(feed) {
  if (!feed?.filter || typeof feed.filter !== 'object') return null;
  const blocks = { include: compileBlockArrSrv(feed.filter.include), exclude: compileBlockArrSrv(feed.filter.exclude) };
  return (blocks.include || blocks.exclude) ? blocks : null;
}
export function compileConfigFilters(filters) {
  return (Array.isArray(filters) ? filters : []).filter((f) => f && f.enabled !== false).map((f) => {
    const scope = Array.isArray(f.feeds) && f.feeds.length ? new Set(f.feeds.map(String)) : null;
    const actions = Object.assign({ hide: f.actions && Object.keys(f.actions).length ? false : true }, f.actions || {});
    return {
      id: f.id || 'filter',
      inScope: (feedId, folders) => !scope || scope.has('*') || scope.has(feedId) || (folders || []).some((x) => scope.has(x)),
      include: compileBlockArrSrv(f.include),
      exclude: compileBlockArrSrv(f.exclude),
      actions,
    };
  });
}
export function configFilterActions(a, feedId, folders, rules) {
  const res = { hidden: false, markRead: false, keepUnread: false, highlight: false };
  for (const f of rules) {
    if (!f.inScope(feedId, folders)) continue;
    let hideMatch, actMatch;
    if (!f.include && !f.exclude) { hideMatch = true; actMatch = true; }
    else {
      const inc = f.include ? f.include.some((b) => blockMatchesSrv(b, a)) : null;
      const exc = f.exclude ? f.exclude.some((b) => blockMatchesSrv(b, a)) : false;
      hideMatch = exc || (inc === null ? false : !inc);
      actMatch = !exc && (inc === null ? true : inc);
    }
    if (f.actions.hide && hideMatch) res.hidden = true;
    if (f.actions.markRead && actMatch) res.markRead = true;
    if (f.actions.keepUnread && actMatch) res.keepUnread = true;
    if (f.actions.highlight && actMatch) res.highlight = true;
  }
  return res;
}
const applyActions = (a, r) => {
  delete a.autoRead; delete a.keepUnread; delete a.highlight;
  if (r?.markRead) a.autoRead = true;
  if (r?.keepUnread) a.keepUnread = true;
  if (r?.highlight) a.highlight = true;
};
export function applyConfigFilters(list, feedId, folders, rules) {
  let hidden = 0;
  const out = [];
  for (const a of list) {
    const r = rules.length ? configFilterActions(a, feedId, folders, rules) : null;
    if (r?.hidden) { hidden++; continue; }
    applyActions(a, r);
    out.push(a);
  }
  return { list: out, hidden };
}
const feedFolders = (feed) => (Array.isArray(feed.folders) ? feed.folders.filter(Boolean) : feed.folder ? [feed.folder] : []);
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
  return decodeBuffer(buf, type);
}
function decodeBuffer(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) charset = /encoding=["']?([\w-]+)/i.exec(buf.subarray(0, 256).toString('latin1'))?.[1];
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
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
const LOOKS_HTML = /<\/(?:p|div|span|a|b|i|u|em|strong|li|ul|ol|h[1-6]|blockquote|pre|code|table|td|tr|figure|figcaption)\b|<(?:p|br|div|span|a|img|figure|figcaption|h[1-6]|ul|ol|li|table|tbody|tr|td|th|blockquote|pre|code|hr|em|strong|b|i|u|sub|sup|center|small|font)\b/i;
const linkify = (text) => text.replace(/https?:\/\/[^\s<]+/gi, (u0) => {
  let u = u0;
  while (/[.,;:!?'"]$/.test(u) || (/\)$/.test(u) && !/\(/.test(u))) u = u.slice(0, -1);
  if (!/^https?:\/\/.{4,}/i.test(u)) return u0; 
  const attr = u.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const trail = u0.slice(u.length);
  return `<a href="${attr}">${attr}</a>${trail}`;
});
export function pickTitle(item) {
  return stripTags(item.title || '').slice(0, 300) || '(untitled)';
}
export function pickContent(item) {
  let raw = item['content:encoded'] || item.content || item.description || item.summary || item.contentSnippet || '';
  if (!raw && item.mediaGroup) {
    const desc = item.mediaGroup['media:description'];
    raw = Array.isArray(desc) ? (desc[0] || '') : (desc?._ || desc || '');
  }
  raw = typeof raw === 'string' ? raw : String(raw ?? '');
  if (raw && !LOOKS_HTML.test(raw)) {
    raw = linkify(raw);
    raw = raw.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  }
  return raw;
}
function pickEnclosures(item) {
  const out = [];
  const seen = new Set();
  const EMBED_JUNK = /(?:youtube\.com\/(?:v|e|embed|watch)|youtu\.be\/|googlevideo\.com\/)/i;
  const push = (url, type) => {
    if (!url || !/^https?:\/\//.test(url)) return;
    if (/x-shockwave-flash/i.test(type || '')) return;
    if (EMBED_JUNK.test(url)) return;
    if (seen.has(url)) return; 
    seen.add(url);
    out.push({ url, type: (type || '').split(';')[0].trim() });
  };
  for (const e of item.enclosures || []) push(e.url ?? e.$?.url, e.type ?? e.$?.type);
  if (item.enclosure) push(item.enclosure.url, item.enclosure.type);
  for (const m of item.mediaContent || []) push(m.$?.url, m.$?.type);
  const thumb = item.mediaThumbnail?.$?.url;
  if (thumb) push(thumb, 'image/thumbnail');
  const mg = item.mediaGroup;
  if (mg) {
    for (const m of mg['media:content'] || []) push(m.$?.url, m.$?.type);
    const t = (mg['media:thumbnail'] || [])[0]?.$?.url;
    if (t) push(t, 'image/thumbnail');
  }
  for (const l of item.links || []) if (l.rel === 'enclosure') push(l.href, l.type);
  return out;
}
async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
const trimStr = (t, cap = 300) => (typeof t === 'string' && t.trim() ? t.trim().slice(0, cap) : '');
const httpOr = (u, fb = '') => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : fb);
function feedMetaFor(feed, prevMeta, parsed = null) {
  const parsedTitle = parsed ? trimStr(parsed.title) : '';
  const title = trimStr(feed.title) || parsedTitle || trimStr(prevMeta?.title) || feed.id;
  const origTitle = trimStr(feed.title)
    ? (parsed ? (parsedTitle && parsedTitle !== feed.title.trim() ? parsedTitle : null) : (trimStr(prevMeta?.origTitle) || null))
    : null;
  const site = trimStr(feed.site) || httpOr(parsed?.link) || httpOr(prevMeta?.site);
  const image = httpOr(parsed?.image?.url || parsed?.icon || parsed?.logo, httpOr(prevMeta?.image, null));
  return { title, origTitle, site, xml: feed.url || null, image };
}
function summarizeFeed(feed, articles) {
  const sorted = [...articles].sort((a, b) => b.date - a.date);
  const folders = feedFolders(feed);
  return {
    title: feed.title || feed.id,
    origTitle: feed.origTitle || null,
    site: feed.site || '',
    xml: feed.xml || null,
    image: feed.image || null,
    folder: folders[0] || null,
    folders,
    count: articles.length,
    newest: sorted[0]?.date || null,
    oldest: sorted[sorted.length - 1]?.date || null,
  };
}
const slugify = (s, fallback) => {
  const out = String(s || '')
    .toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '') 
    .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return out || fallback;
};
function parseOpml(xml) {
  const dom = new JSDOM(xml, { contentType: 'application/xml' });
  try {
    const doc = dom.window.document;
    const root = doc.getElementsByTagName('body')[0] || doc.documentElement;
    const feeds = [];
    const folders = new Map(); 
    const seenIds = new Set();
    const uniqueId = (base) => { let id = base, i = 2; while (seenIds.has(id)) id = `${base}-${i++}`; seenIds.add(id); return id; };
    const visit = (el, folderId) => {
      for (const o of [...el.children]) {
        if (String(o.nodeName || '').toLowerCase() !== 'outline') continue;
        const xmlUrl = o.getAttribute('xmlUrl') || '';
        const title = (o.getAttribute('title') || o.getAttribute('text') || '').trim();
        if (xmlUrl) {
          feeds.push({
            id: uniqueId(slugify(title, `feed-${feeds.length}`)),
            title: title || xmlUrl,
            url: xmlUrl,
            site: o.getAttribute('htmlUrl') || '',
            folder: folderId || null,
          });
        } else {
          const fid = uniqueId(slugify(title, `folder-${folders.size}`));
          folders.set(fid, { id: fid, name: title || fid });
          visit(o, fid);
        }
      }
    };
    visit(root, null);
    if (!feeds.length) throw new Error('no outlines with xmlUrl found');
    return { feeds, folders: [...folders.values()] };
  } finally {
    dom.window.close();
  }
}
const isHnFeed = (f) => f?.type === 'hackernews' || f?.type === 'hn';
const deriveFeedId = (f) => {
  if (f.id) return String(f.id);
  if (f.type === '4chan') return `4chan-${slugify(String(f.board || '').toLowerCase().replace(/\//g, ''), 'board')}`;
  if (isHnFeed(f)) return 'hackernews';
  const u = String(f.url || '');
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./i, '');
    if (/(^|\.)youtube\.com$/i.test(host)) {
      const yt = url.searchParams.get('channel_id') || url.searchParams.get('user') || url.searchParams.get('playlist_id');
      if (yt) return `yt-${String(yt).toLowerCase()}`;
    }
    const hostSlug = slugify(host, 'feed');
    const pathSlug = slugify(url.pathname.replace(/\.(xml|rss|atom|json)$/i, ''), '');
    return `${hostSlug}${pathSlug ? '-' + pathSlug : ''}`.slice(0, 64);
  } catch { return slugify(u, 'feed').slice(0, 64); }
};
async function resolveFeeds(config) {
  const feedKey = (f) => f.url || (f.type === '4chan' ? `4chan:${String(f.board || '').toLowerCase().replace(/\//g, '')}` : isHnFeed(f) ? `hackernews:${f.id || 'default'}` : `id:${f.id}`);
  const usable = (f) => f && (f.url || f.type === '4chan' || isHnFeed(f));
  const configFeeds = (config.feeds || []).filter(usable);
  for (const f of config.feeds || []) if (!usable(f)) console.warn(`skip feed (no url/board/type): ${JSON.stringify(f)}`);
  const byId = new Map(configFeeds.filter((f) => f.id).map((f) => [f.id, f]));
  const byUrl = new Map(configFeeds.filter((f) => f.url).map((f) => [f.url, f]));
  const feeds = [];
  const seenUrls = new Set();
  const seenIds = new Set();
  const addFeed = (f) => {
    const key = feedKey(f);
    if (seenUrls.has(key)) return; 
    seenUrls.add(key);
    const base = deriveFeedId(f);
    let id = base;
    let i = 2;
    while (seenIds.has(id)) id = `${base}-${i++}`;
    seenIds.add(id);
    feeds.push({ ...f, id });
  };
  let opmlFolders = [];
  try {
    const xml = await fs.readFile(path.join(ROOT, 'feeds.opml'), 'utf8');
    const parsed = parseOpml(xml);
    opmlFolders = parsed.folders;
    const consumed = new Set();
    for (const f of parsed.feeds) {
      const ov = byId.get(f.id) || (f.url ? byUrl.get(f.url) : null); 
      if (ov) { consumed.add(ov); addFeed(Object.assign({}, f, ov)); }
      else addFeed(f);
    }
    for (const f of configFeeds) if (!consumed.has(f)) addFeed(f);
    console.log(`feeds.opml: imported ${parsed.feeds.length} feeds in ${parsed.folders.length} folders (merged with config.json: ${feeds.length} feeds total)`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      for (const f of configFeeds) addFeed(f); 
    } else {
      console.warn(`feeds.opml found but unreadable (${err.message}) — ignoring it`);
      for (const f of configFeeds) addFeed(f);
    }
  }
  const folderMap = new Map();
  for (const f of opmlFolders) folderMap.set(f.id, { ...f });
  for (const f of config.folders || []) if (f && f.id) folderMap.set(f.id, Object.assign({}, folderMap.get(f.id) || { id: f.id }, f));
  return { feeds, folders: [...folderMap.values()] };
}
const CHAN_API = 'https://a.4cdn.org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chanLastReq = 0;
async function chanThrottle() {
  const wait = chanLastReq + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  chanLastReq = Date.now();
}
let chanBoardsCache = null;
async function getChanBoards() {
  if (chanBoardsCache) return chanBoardsCache;
  try {
    await chanThrottle();
    const res = await fetch(`${CHAN_API}/boards.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(35000), redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    chanBoardsCache = (await res.json())?.boards || null;
  } catch (err) {
    console.warn(`boards.json failed (${err.message}) — continuing without board metadata`);
    chanBoardsCache = null;
  }
  return chanBoardsCache;
}
async function fetchChanCatalog(board, ifModifiedSince) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;
  await chanThrottle();
  const res = await fetch(`${CHAN_API}/${encodeURIComponent(board)}/catalog.json`, {
    headers, signal: AbortSignal.timeout(35000), redirect: 'follow',
  });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { json: await res.json(), lastModified: res.headers.get('last-modified') || null };
}
export function channelKeyOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, '');
    if (!/(^|\.)youtube\.com$/i.test(host)) return null;
    const cid = u.searchParams.get('channel_id') || u.searchParams.get('user') || u.searchParams.get('playlist_id');
    return cid ? String(cid).toLowerCase() : null;
  } catch { return null; }
}
export function findPrevIdFor(feed, prevFeedMeta) {
  const ck = feed.url ? channelKeyOf(feed.url) : null;
  for (const [oldId, m] of Object.entries(prevFeedMeta || {})) {
    if (ck && typeof m?.site === 'string' && m.site.toLowerCase().includes(ck)) return oldId;
    if (feed.url && m?.xml === feed.url) return oldId;
  }
  return null;
}
async function main() {
  const config = await loadJson(path.join(ROOT, 'config.json'), null);
  if (!config) {
    console.error('config.json missing or unreadable');
    process.exit(1);
  }
  const settings = config.settings || {};
  const fullTextDefault = !!settings.fullTextDefault;
  const dropShortsDefault = settings.dropShorts !== false; 
  const retentionDays = Number(settings.retentionDays) > 0 ? Number(settings.retentionDays) : DEFAULT_RETENTION_DAYS;
  const { feeds, folders: folderDefs } = await resolveFeeds(config);
  if (!feeds.length) {
    console.error('no feeds found (config.json feeds or feeds.opml)');
    process.exit(1);
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(FEEDS_DIR, { recursive: true });
  const now = Date.now();
  const retainMs = retentionDays * 86400000;
  const prevIndex = await loadJson(path.join(DATA_DIR, 'index.json'), { generatedAt: 0, feeds: {} });
  const prevFeedMeta = prevIndex.feeds || {};
  const index = { generatedAt: now, folders: folderDefs, feeds: {} };
  let failures = 0;
  const configRules = compileConfigFilters(config.filters);
  if (configRules.length) console.log(`config filters: ${configRules.length} rule(s) applied at fetch time (server-side)`);
  const currentFeedIds = new Set();
  const written = new Map(); 
  const purgePrev = (prev, { ytShorts = false, feedBlocks = null, cf = null } = {}) => {
    let list = prev.articles || [];
    if (ytShorts) list = list.filter((a) => !isShortItem(a.link, a.title, a.content));
    if (feedBlocks) list = list.filter((a) => !feedFilterDrop(a, feedBlocks));
    if (cf) list = cf(list);
    return list.filter((a) => now - a.date < retainMs);
  };
  const processFeed = async (feed) => {
    currentFeedIds.add(feed.id);
    const file = path.join(FEEDS_DIR, `${feed.id}.json`);
    let prev = await loadJson(file, { articles: [] });
    let prevStatus = prevFeedMeta[feed.id]?.status || {};
    let prevMeta = prevFeedMeta[feed.id] || null;
    if (!(prev.articles || []).length) {
      const adoptId = findPrevIdFor(feed, prevFeedMeta);
      if (adoptId) {
        const adopted = await loadJson(path.join(FEEDS_DIR, `${adoptId}.json`), { articles: [] });
        if ((adopted.articles || []).length) {
          prev = adopted;
          prevStatus = { ...prevStatus, ...(prevFeedMeta[adoptId]?.status || {}) };
          prevMeta = prevFeedMeta[adoptId] || prevMeta;
          console.log(`[${feed.id}] adopted ${adopted.articles.length} articles from previous id "${adoptId}"`);
        }
      }
    }
    const prevById = new Map((prev.articles || []).map((a) => [a.id, a]));
    const prevIdByKey = new Map();
    for (const a of prev.articles || []) prevIdByKey.set(a.link ? `l:${a.link}` : `t:${a.title}`, a.id);
    const status = {
      ok: true,
      lastAttempt: now,
      lastSuccess: prevStatus.lastSuccess || null,
      consecutiveFailures: prevStatus.consecutiveFailures || 0,
      error: null,
      etag: prevStatus.etag || null,
      lastModified: prevStatus.lastModified || null,
    };
    const feedBlocks = compileFeedFilter(feed);
    const folders = feedFolders(feed);
    let cfgHidden = 0;
    const cList = (list) => {
      const r = applyConfigFilters(list, feed.id, folders, configRules);
      cfgHidden += r.hidden;
      return r.list;
    };
    if (feed.enabled === false) {
      const kept = purgePrev(prev, { feedBlocks, cf: cList });
      await fs.writeFile(file, JSON.stringify({ articles: kept }));
      index.feeds[feed.id] = {
        ...summarizeFeed({ ...feed, ...feedMetaFor(feed, prevMeta) }, kept),
        status: {
          ok: false,
          disabled: true,
          lastAttempt: now,
          lastSuccess: status.lastSuccess,
          consecutiveFailures: 0,
          error: 'Feed disabled in config',
        },
      };
      written.set(feed.id, kept);
      console.log(`[${feed.id}] disabled, keeping ${kept.length} articles (last ${retentionDays} days)`);
      return;
    }
    if (feed.type === '4chan') {
      const board = String(feed.board || '').toLowerCase().replace(/^\/+|\/+$/g, '');
      const boards = await getChanBoards();
      const meta = boards?.find((b) => b.board === board) || null;
      if (!board) {
        failures++;
        const keptErr = cList((prev.articles || []).filter((a) => !feedFilterDrop(a, feedBlocks)));
        await fs.writeFile(file, JSON.stringify({ articles: keptErr }));
        index.feeds[feed.id] = { ...summarizeFeed({ ...feed, site: feed.site || 'https://boards.4channel.org' }, keptErr), status: { ...status, ok: false, error: '4chan feed needs a "board"' } };
        written.set(feed.id, keptErr);
        console.error(`[${feed.id}] CONFIG ERROR: 4chan feed needs a "board" (e.g. "g")`);
        return;
      }
      if (boards && !meta) {
        failures++;
        const keptErr = cList((prev.articles || []).filter((a) => !feedFilterDrop(a, feedBlocks)));
        await fs.writeFile(file, JSON.stringify({ articles: keptErr }));
        index.feeds[feed.id] = { ...summarizeFeed({ ...feed, site: feed.site || 'https://boards.4channel.org' }, keptErr), status: { ...status, ok: false, error: `unknown board /${board}/` } };
        written.set(feed.id, keptErr);
        console.error(`[${feed.id}] FETCH FAILED: unknown 4chan board /${board}/ — keeping ${keptErr.length} threads`);
        return;
      }
      const worksafe = meta ? meta.ws_board !== 0 : true;
      const effFeed = { ...feed, title: feed.title || meta?.title || `/${board}/`, site: feed.site || `https://${worksafe ? 'boards.4channel.org' : 'boards.4chan.org'}/${board}/` };
      const cap = Number(feed.maxThreads) > 0 ? Number(feed.maxThreads) : 0;
      let res;
      try {
        res = await fetchChanCatalog(board, prevStatus.lastModified || null);
      } catch (err) {
        failures++;
        status.ok = false;
        status.error = err.message;
        status.consecutiveFailures = (prevStatus.consecutiveFailures || 0) + 1;
        const keptFail = cList((prev.articles || []).filter((a) => !feedFilterDrop(a, feedBlocks)));
        await fs.writeFile(file, JSON.stringify({ articles: keptFail }));
        index.feeds[feed.id] = { ...summarizeFeed({ ...effFeed, ...feedMetaFor(effFeed, prevMeta) }, keptFail), status };
        written.set(feed.id, keptFail);
        console.error(`[${feed.id}] FETCH FAILED: ${err.message} — keeping ${keptFail.length} threads`);
        return;
      }
      status.ok = true;
      status.lastSuccess = now;
      status.consecutiveFailures = 0;
      status.error = null;
      status.lastModified = res.lastModified || prevStatus.lastModified || null;
      if (res.notModified) {
        const keptAll = cList((prev.articles || []).filter((a) => !feedFilterDrop(a, feedBlocks)));
        const kept = cap ? keptAll.slice(0, cap) : keptAll;
        await fs.writeFile(file, JSON.stringify({ articles: kept }));
        index.feeds[feed.id] = { ...summarizeFeed({ ...effFeed, ...feedMetaFor(effFeed, prevMeta) }, kept), status };
        written.set(feed.id, kept);
        console.log(`[${feed.id}] /${board}/: not modified — keeping ${kept.length} live threads${cfgHidden ? ` (dropped ${cfgHidden} by config filter)` : ''}`);
        return;
      }
      const opts = {
        minReplies: Number(feed.minReplies) || 0,
        maxReplies: Number(feed.maxReplies) || 0,
        minImages: Number(feed.minImages) || 0,
        maxImages: Number(feed.maxImages) || 0,
      };
      const articles = [];
      let skipped = 0;
      let filtered = 0;
      for (const t of chanThreadsFromCatalog(res.json)) {
        if (!chanThreadPasses(t, opts)) { skipped++; continue; }
        const a = chanThreadToArticle(t, { board, worksafe, now });
        if (feedBlocks && feedFilterDrop(a, feedBlocks)) { filtered++; continue; }
        const r = configFilterActions(a, feed.id, folders, configRules);
        if (r.hidden) { cfgHidden++; continue; }
        applyActions(a, r);
        a.content = sanitize(a.content);
        articles.push(a);
      }
      const kept = cap ? articles.slice(0, cap) : articles;
      await fs.writeFile(file, JSON.stringify({ articles: kept }));
      index.feeds[feed.id] = { ...summarizeFeed({ ...effFeed, ...feedMetaFor(effFeed, prevMeta) }, kept), status };
      written.set(feed.id, kept);
      console.log(`[${feed.id}] /${board}/: ${kept.length} live threads${skipped ? ` (skipped ${skipped} below the reply/word filters)` : ''}${filtered ? ` (dropped ${filtered} by word filter)` : ''}${cfgHidden ? ` (dropped ${cfgHidden} by config filter)` : ''}${cap ? ` (capped at ${cap})` : ''}`);
      return;
    }
    if (isHnFeed(feed)) {
      const effFeed = { ...feed, title: feed.title || 'Hacker News', site: feed.site || 'https://news.ycombinator.com/' };
      const { minPoints, minComments } = hnFeedOptions(feed);
      let hits;
      try {
        const res = await hnFetchAllPages(
          (url) => fetch(url, {
            headers: { 'User-Agent': UA, Accept: 'application/json' },
            signal: AbortSignal.timeout(35000), redirect: 'follow',
          }),
          feed, { retentionDays, now },
        );
        hits = res.hits;
        if (res.requests > 1) console.log(`[${feed.id}] ${retentionDays}-day window needed ${res.requests} ranged requests (Algolia's 1000-hit response cap)`);
        if (res.truncated) console.log(`[${feed.id}] note: request cap hit — window partially covered, the next run heals the rest`);
      } catch (err) {
        failures++;
        status.ok = false;
        status.error = err.message;
        status.consecutiveFailures = (prevStatus.consecutiveFailures || 0) + 1;
        const keptFail = cList([...(prev.articles || [])].filter((a) => !feedFilterDrop(a, feedBlocks))).filter((a) => now - a.date < retainMs);
        await fs.writeFile(file, JSON.stringify({ articles: keptFail }));
        index.feeds[feed.id] = { ...summarizeFeed({ ...effFeed, ...feedMetaFor(effFeed, prevMeta) }, keptFail), status };
        written.set(feed.id, keptFail);
        console.error(`[${feed.id}] FETCH FAILED: ${err.message} — keeping ${keptFail.length} stories from last ${retentionDays} days`);
        return;
      }
      status.ok = true;
      status.lastSuccess = now;
      status.consecutiveFailures = 0;
      status.error = null;
      const fmeta = feedMetaFor(feed, prevMeta);
      const articles = [];
      let filtered = 0;
      for (const hit of hits) {
        if (!hit || !hit.objectID) continue;
        const a = hnHitToArticle(hit, { now });
        if (feedBlocks && feedFilterDrop(a, feedBlocks)) { filtered++; continue; }
        const r = configFilterActions(a, feed.id, folders, configRules);
        if (r.hidden) { cfgHidden++; continue; }
        applyActions(a, r);
        a.content = sanitize(a.content);
        articles.push(a);
      }
      const byId = new Map();
      const prevList = cList((prev.articles || []).filter((a) => !feedFilterDrop(a, feedBlocks)));
      for (const a of [...prevList, ...articles]) byId.set(a.id, a);
      const merged = [...byId.values()].sort((a, b) => b.date - a.date).filter((a) => now - a.date < retainMs);
      await fs.writeFile(file, JSON.stringify({ articles: merged }));
      index.feeds[feed.id] = { ...summarizeFeed({ ...effFeed, ...fmeta }, merged), status };
      written.set(feed.id, merged);
      const capsDesc = minPoints && minComments
        ? `${minPoints}+ points and ${minComments}+ comments`
        : minPoints ? `${minPoints}+ points` : minComments ? `${minComments}+ comments` : 'front page';
      console.log(`[${feed.id}] ${merged.length} stories (${capsDesc}, last ${retentionDays} days)${filtered ? ` (dropped ${filtered} by word filter)` : ''}${cfgHidden ? ` (dropped ${cfgHidden} by config filter)` : ''}`);
      return;
    }
    let xml;
    try {
      const headers = { ...parser.options.headers };
      if (prevStatus.etag) headers['If-None-Match'] = prevStatus.etag;
      else if (prevStatus.lastModified) headers['If-Modified-Since'] = prevStatus.lastModified;
      const res = await fetch(feed.url, { headers, signal: AbortSignal.timeout(35000), redirect: 'follow' });
      if (res.status === 304) {
        status.ok = true;
        status.lastSuccess = now;
        status.consecutiveFailures = 0;
        status.error = null;
        const kept = purgePrev(prev, {
          ytShorts: isYouTubeFeed(feed.url) && (feed.dropShorts ?? dropShortsDefault),
          feedBlocks,
          cf: cList,
        });
        await fs.writeFile(file, JSON.stringify({ articles: kept }));
        index.feeds[feed.id] = { ...summarizeFeed({ ...feed, ...feedMetaFor(feed, prevMeta) }, kept), status };
        written.set(feed.id, kept);
        console.log(`[${feed.id}] not modified — keeping ${kept.length} articles${cfgHidden ? ` (dropped ${cfgHidden} by config filter)` : ''}`);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5_000_000) throw new Error('feed exceeds 5 MB');
      xml = decodeBuffer(buf, res.headers.get('content-type'));
      status.etag = res.headers.get('etag') || null;
      status.lastModified = res.headers.get('last-modified') || null;
    } catch (err) {
      failures++;
      status.ok = false;
      status.error = err.message;
      status.consecutiveFailures = (prevStatus.consecutiveFailures || 0) + 1;
      const kept = cList([...(prev.articles || [])].filter((a) => !feedFilterDrop(a, feedBlocks))).filter((a) => now - a.date < retainMs);
      await fs.writeFile(file, JSON.stringify({ articles: kept }));
      index.feeds[feed.id] = {
        ...summarizeFeed({ ...feed, ...feedMetaFor(feed, prevMeta) }, kept),
        status,
      };
      written.set(feed.id, kept);
      console.error(`[${feed.id}] FETCH FAILED: ${err.message} — keeping ${kept.length} articles from last ${retentionDays} days (${status.consecutiveFailures} consecutive failures)`);
      return;
    }
    let parsed;
    try {
      parsed = await parser.parseString(xml);
    } catch (err) {
      failures++;
      status.ok = false;
      status.error = `Parse error: ${err.message}`;
      status.consecutiveFailures = (prevStatus.consecutiveFailures || 0) + 1;
      let kept = cList([...(prev.articles || [])].filter((a) => !feedFilterDrop(a, feedBlocks))).filter((a) => now - a.date < retainMs);
      await fs.writeFile(file, JSON.stringify({ articles: kept }));
      index.feeds[feed.id] = {
        ...summarizeFeed({ ...feed, ...feedMetaFor(feed, prevMeta) }, kept),
        status,
      };
      written.set(feed.id, kept);
      console.error(`[${feed.id}] PARSE FAILED: ${err.message} — keeping ${kept.length} articles from last ${retentionDays} days`);
      return;
    }
    status.ok = true;
    status.lastSuccess = now;
    status.consecutiveFailures = 0;
    status.error = null;
    const fmeta = feedMetaFor(feed, prevMeta, parsed);
    const wantText = feed.fullText ?? fullTextDefault;
    let textBudget = wantText ? TEXT_EXTRACT_BUDGET : 0;
    const ytShorts = isYouTubeFeed(feed.url) && (feed.dropShorts ?? dropShortsDefault);
    const articles = [];
    let shortsDropped = 0;
    let filterDropped = 0;
    for (const item of parsed.items || []) {
      const title = pickTitle(item);
      const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.replace(/[\s\u0000-\u001f]+/g, ''));
      const link = isHttpUrl(item.link) ? item.link : (isHttpUrl(item.guid) ? item.guid : '');
      const content = pickContent(item);
      if (ytShorts && isShortItem(link, title, content)) { shortsDropped++; continue; }
      const author = stripTags(item.creator || item.author || '').slice(0, 120) || null;
      if (feedBlocks && feedFilterDrop({ title, content, author, link, summary: '' }, feedBlocks)) { filterDropped++; continue; }
      const id = prevIdByKey.get(link ? `l:${link}` : `t:${title}`) || stableId(item.guid || item.id || link || title);
      const prevA = prevById.get(id);
      const date = pickDate(item) ?? prevA?.date ?? now;
      const plain = stripTags(content);
      const summary = plain.slice(0, 300);
      let text = prevA?.text || null;
      const feedGivesEnough = plain.length >= TEXT_EXTRACT_MIN_LEN;
      if (wantText && !text && !feedGivesEnough && textBudget > 0 && now - date < retainMs && link) {
        textBudget--;
        try {
          text = await extractFullText(link);
          if (text) console.log(`[${feed.id}] extracted text: ${title.slice(0, 60)}`);
        } catch (err) {
          console.warn(`[${feed.id}] extract failed for ${link}: ${err.message}`);
        }
      }
      const art = {
        id,
        title,
        link,
        author,
        date,
        summary,
        content: sanitize(content),
        text,
        enclosures: pickEnclosures(item),
        fetchedAt: now,
      };
      const r = configFilterActions(art, feed.id, folders, configRules);
      if (r.hidden) { cfgHidden++; continue; }
      applyActions(art, r);
      articles.push(art);
    }
    if (shortsDropped) console.log(`[${feed.id}] dropped ${shortsDropped} YouTube short(s)`);
    if (filterDropped) console.log(`[${feed.id}] dropped ${filterDropped} article(s) by the feed's word filter`);
    if (cfgHidden) console.log(`[${feed.id}] dropped ${cfgHidden} article(s) by the config filter`);
    const byId = new Map();
    const prevList = purgePrev(prev, { ytShorts, feedBlocks, cf: cList });
    for (const a of [...prevList, ...articles]) byId.set(a.id, a);
    let merged = [...byId.values()].sort((a, b) => b.date - a.date);
    merged = merged.filter((a) => now - a.date < retainMs);
    await fs.writeFile(file, JSON.stringify({ articles: merged }));
    index.feeds[feed.id] = {
      ...summarizeFeed({ ...feed, ...fmeta }, merged),
      status,
    };
    written.set(feed.id, merged);
    console.log(`[${feed.id}] ${merged.length} articles (last ${retentionDays} days, no cap) from "${fmeta.origTitle || fmeta.title}"`);
  };
  const chanFeeds = feeds.filter((f) => f.type === '4chan');
  const poolFeeds = feeds.filter((f) => f.type !== '4chan');
  const runOne = async (feed) => {
    try { await processFeed(feed); }
    catch (err) { failures++; console.error(`[${feed.id}] FAILED: ${err.message}`); }
  };
  const chanChain = (async () => { for (const feed of chanFeeds) await runOne(feed); })();
  const pool = Array.from({ length: Math.min(FETCH_CONCURRENCY, poolFeeds.length) }, async () => {
    while (poolFeeds.length) await runOne(poolFeeds.shift());
  });
  await Promise.all([...pool, chanChain]);
  for (const [oldId] of Object.entries(prevFeedMeta)) {
    if (!currentFeedIds.has(oldId)) {
      try {
        await fs.unlink(path.join(FEEDS_DIR, `${oldId}.json`));
        console.log(`[${oldId}] removed from config - purged feed data`);
      } catch {}
    }
  }
  try {
    for (const name of await fs.readdir(FEEDS_DIR)) {
      if (!name.endsWith('.json')) continue;
      const fid = name.slice(0, -5);
      if (currentFeedIds.has(fid) || fid in prevFeedMeta) continue;
      try {
        await fs.unlink(path.join(FEEDS_DIR, name));
        console.log(`[${fid}] orphan feed data swept`);
      } catch {}
    }
  } catch {}
  const allArticles = [];
  for (const feed of feeds) {
    for (const a of written.get(feed.id) || []) allArticles.push({ ...a, _feed: feed.id });
  }
  await fs.writeFile(path.join(DATA_DIR, 'all-feeds.json'), JSON.stringify({ articles: allArticles }));
  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(index));
  console.log(`done: ${Object.keys(index.feeds).length} feeds, ${failures} failure(s), keeping last ${retentionDays} days (no per-feed cap; 4chan feeds are live)`);
}
const invokedAsCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsCli) {
  main().catch((err) => { console.error(err); process.exit(1); });
}