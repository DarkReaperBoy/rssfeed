(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS_READ = 'ghrss:read', LS_KEPT = 'ghrss:kept', LS_UI = 'ghrss:ui', LS_VER = 'ghrss:ver', LS_USERUNREAD = 'ghrss:userUnread';
const STORAGE_VERSION = 3; 

try {
  if (Number(localStorage.getItem(LS_VER)) !== STORAGE_VERSION) {
    localStorage.removeItem(LS_READ);
    localStorage.removeItem(LS_KEPT);
    localStorage.setItem(LS_VER, String(STORAGE_VERSION));
  }
} catch {}

const state = {
  config: null,
  index: null,
  feeds: new Map(),          
  scope: 'all',
  search: '',
  expandedId: null,
  visible: [],
  keepVisible: new Set(),    
  read: loadObj(LS_READ),    
  kept: loadObj(LS_KEPT),    
  userUnread: loadObj(LS_USERUNREAD), 
  loading: new Map(), 
  settled: new Set(), 
  failed: new Set(),
  refreshTimer: null,
  lastPollAt: 0,
  filterMarked: new Set(), 
  byId: new Map(),
};

const CONFIG_KEYS = ['theme', 'density', 'showFavicons',
  'absoluteDates', 'fontSize', 'sideFavicons', 'compactSidebar', 'countersClickable',
  'titleCounter', 'updatedOnly', 'dimRead', 'sortAZ', 'autoScroll'];
const USER_KEYS = ['status', 'sortDir', 'openFolders', 'sidebarW', 'markAgeDays', 'listW'];

const savedUi = loadObj(LS_UI); 
const ui = Object.assign({
  theme: 'auto', status: 'unread',
  openFolders: {},
  density: 'comfort', sortDir: 'oldest', markAgeDays: 7,
  updatedOnly: false, dimRead: false, sortAZ: false,
  showFavicons: true,
  autoScroll: true, absoluteDates: false, fontSize: '14.5px',
  sideFavicons: true, compactSidebar: false, countersClickable: true, titleCounter: true,
}, Object.fromEntries(USER_KEYS.filter((k) => k in savedUi).map((k) => [k, savedUi[k]])));

if (ui.status === 'read') ui.status = 'all';
if (!savedUi.sortFlip) {
  if (ui.sortDir === 'newest') ui.sortDir = 'oldest';
  try { localStorage.setItem(LS_UI, JSON.stringify(Object.assign(savedUi, { sortFlip: 1 }))); } catch {}
}

function loadObj(k) {

  const out = Object.create(null);
  try {
    const v = JSON.parse(localStorage.getItem(k));
    if (v && typeof v === 'object') for (const key of Object.keys(v)) if (key !== '__proto__') out[key] = v[key];
  } catch {}
  return out;
}
function saveObj(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function saveRead() { saveObj(LS_READ, state.read); }
function saveKept() { saveObj(LS_KEPT, state.kept); }
function saveUserUnread() { saveObj(LS_USERUNREAD, state.userUnread); }
function saveUi() { saveObj(LS_UI, Object.assign(Object.fromEntries(USER_KEYS.map((k) => [k, ui[k]])), { sortFlip: 1 })); }

const isRead = (a) => !!state.read[a.id];
const isKept = (a) => !!state.kept[a.id];
let byIdDirty = true;
const markFeedsChanged = () => { byIdDirty = true; };
const findArticle = (id) => {
  if (byIdDirty) {
    state.byId = new Map();
    for (const arts of state.feeds.values()) for (const a of arts) state.byId.set(a.id, a);
    byIdDirty = false;
  }
  return state.byId.get(id) || null;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripTags = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stripCtrl = (s) => String(s ?? '').replace(/[\s\u0000-\u001f]+/g, '');

const safeHref = (u) => (/^https?:\/\//i.test(stripCtrl(String(u ?? ''))) ? String(u) : '#');
function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  if (s < 30 * 86400) return Math.floor(s / (7 * 86400)) + 'w';
  if (s < 365 * 86400) return Math.floor(s / (30 * 86400)) + 'mo';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
const fullTime = (ts) => ts ? new Date(ts).toLocaleString() : '';
const absTime = (ts) => ts
  ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  : '';
let baseTitle = 'My RSSFeed';
function updateTitleCounter() {
  let n = 0;
  for (const arts of state.feeds.values()) for (const a of arts) if (!isRead(a)) n++;
  const prefix = n > 0 && ui.titleCounter !== false ? `(${n}) ` : '';
  const open = state.expandedId ? findArticle(state.expandedId) : null;

  document.title = open?.title
    ? `${prefix}${baseTitle} - ${String(open.title).slice(0, 100)}`
    : `${prefix}${baseTitle}`;
}
function faviconHtml(feed) {

  const initial = Array.from(String(feed?.title || '?'))[0] || '?';
  const site = feed?.site || '';
  let host = '';
  try { if (site) host = new URL(site).hostname; } catch {}
  if (!host) return `<span class="favicon-wrap" aria-hidden="true"><span class="favicon-tile" data-initial="${esc(initial)}"></span></span>`;
  return `<span class="favicon-wrap" aria-hidden="true"><img class="favicon" loading="lazy" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64" alt=""><span class="favicon-tile" data-initial="${esc(initial)}" hidden></span></span>`;
}
const feedMeta = (id) => {
  const m = state.index?.feeds?.[id];
  if (!m) return { title: id, site: '', folder: null, folders: [], status: null };
  if (!m.folders) m.folders = m.folder ? [m.folder] : [];
  if (!m.status) m.status = null;
  return m;
};
const feedTitle = (id) => feedMeta(id).title || id;

const folderDefs = () => (state.index?.folders?.length ? state.index.folders : state.config?.folders || []);

function materializeFeedFlags(feedId, articles) {
  // Filters ran in the backend (fetch.mjs); their decisions ride on the article
  // data as autoRead / keepUnread / highlight flags. Hidden articles never arrive.
  let marked = 0;
  for (const a of articles) {
    a._feed = feedId;
    if (a.autoRead && !a.keepUnread && !isKept(a) && !isRead(a) && !state.userUnread[a.id] && !state.filterMarked.has(a.id)) {
      state.read[a.id] = Date.now();
      state.filterMarked.add(a.id);
      marked++;
    }
  }
  if (marked) saveRead();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FETCH_TIMEOUT_MS = Number(window.RSS_FETCH_TIMEOUT_MS) || 10000;
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function loadFeed(feedId, force = false) {

  if (state.loading.has(feedId)) return state.loading.get(feedId);
  if (!force && state.feeds.has(feedId)) return;
  const done = (async () => {
    try {
      const data = await fetchJson(`data/feeds/${encodeURIComponent(feedId)}.json`);
      materializeFeedFlags(feedId, data.articles || []);
      state.feeds.set(feedId, data.articles || []);
      markFeedsChanged();
      state.failed.delete(feedId);
    } catch {
      state.failed.add(feedId);
    } finally {
      state.loading.delete(feedId);
      state.settled.add(feedId);
    }
  })();
  state.loading.set(feedId, done);
  await done;
}

async function loadMany(ids, onChange, force = false) {
  const queue = [...new Set(ids)];
  let renderQueued = false;
  const renderSoon = () => {
    if (renderQueued || !onChange) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; onChange(); }, 250);
  };
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      await loadFeed(id, force);
      renderSoon();
    }
  };
  const n = Math.min(6, queue.length);
  if (n > 0) await Promise.all(Array.from({ length: n }, worker));
  if (onChange) onChange();
}
function feedIdsInScope() {
  const feeds = state.index?.feeds || {};
  if (state.scope.startsWith('feed:')) return [state.scope.slice(5)];
  if (state.scope.startsWith('folder:')) {
    const fid = state.scope.slice(7);
    return Object.keys(feeds).filter((id) => {
      const m = feeds[id];
      if (Array.isArray(m.folders)) return m.folders.includes(fid);
      return m.folder === fid;
    });
  }
  return Object.keys(feeds);
}

function scopeFeedIds(scope) {
  if (scope.startsWith('feed:')) return [scope.slice(5)];
  if (scope.startsWith('folder:')) {
    const fid = scope.slice(7);
    return Object.keys(state.index?.feeds || {}).filter((id) => feedMeta(id).folders.includes(fid));
  }
  if (scope === 'all') return Object.keys(state.index?.feeds || {});
  return feedIdsInScope();
}
async function loadAllFeeds(onChange) {

  await loadConsolidatedIntoState();
  const missing = Object.keys(state.index?.feeds || {}).filter((id) => !state.feeds.has(id));
  if (missing.length) await loadMany(missing, onChange);
}

function parseQuery(q) {
  const ops = { feed: [], title: [], before: null, after: null, unread: null };
  const rest = [];

  const parseDay = (s) => {
    const t = Date.parse(s);
    if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return t;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  const re = /(\w+):("([^"]*)"|\S+)|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[1]) {
      const key = m[1].toLowerCase(), val = (m[3] ?? m[2] ?? '').toLowerCase();
      if (key === 'feed') ops.feed.push(val);
      else if (key === 'title') ops.title.push(val);
      else if (key === 'before' || key === 'until') { const t = parseDay(val); if (!isNaN(t)) ops.before = t; }
      else if (key === 'after' || key === 'since') { const t = parseDay(val); if (!isNaN(t)) ops.after = t; }
      else if (key === 'unread') ops.unread = !['false', 'no', '0'].includes(val);
      else if (key === 'is' && (val === 'read' || val === 'unread')) ops.unread = val === 'unread';
      else rest.push(m[0].toLowerCase()); 
    } else rest.push((m[4] ?? m[5] ?? '').toLowerCase());
  }
  return { ops, terms: rest.filter(Boolean) };
}
function compileSearch(q) {
  if (!q || !String(q).trim()) return null;

  const groups = String(q).split(/\s+OR\s+/).map((group) => parseQuery(group)).filter(({ ops, terms }) => ops.feed.length || ops.title.length || ops.before !== null || ops.after !== null || ops.unread !== null || terms.length);
  return groups.length ? groups : null;
}
function searchMatchesCompiled(a, groups) {
  return !groups || groups.some(({ ops, terms }) => searchGroupMatches(a, ops, terms));
}
function searchGroupMatches(a, ops, terms) {
  if (ops.feed.length && !ops.feed.some((f) => a._feed.toLowerCase().includes(f) || feedTitle(a._feed).toLowerCase().includes(f))) return false;
  if (ops.title.length && !ops.title.every((t) => (a.title || '').toLowerCase().includes(t))) return false;
  if (ops.before && !(a.date < ops.before)) return false;
  if (ops.after && !(a.date > ops.after)) return false;
  if (ops.unread !== null && isRead(a) === ops.unread) return false;
  if (terms.length) {
    a._haystack = a._haystack || `${a.title || ''} ${a.author || ''} ${a.summary || ''} ${stripTags(a.content)} ${stripTags(a.text)} ${feedTitle(a._feed)}`.toLowerCase();
    if (!terms.every((t) => a._haystack.includes(t))) return false;
  }
  return true;
}

function folderCutoff(feedId) {

  if (!state.scope.startsWith('folder:')) return 0;
  const f = folderDefs().find((x) => x.id === state.scope.slice(7));
  const days = Number(f?.maxAgeDays) || 0;
  return days > 0 ? days * 864e5 : 0;
}
function computeVisible() {
  const out = [];
  const searchGroups = compileSearch(state.search);

  const feedIds = searchGroups ? Object.keys(state.index?.feeds || {}) : feedIdsInScope();
  for (const feedId of feedIds) {
    const cutoff = searchGroups ? 0 : folderCutoff(feedId);
    for (const a of state.feeds.get(feedId) || []) {
      if (cutoff && Date.now() - a.date > cutoff) continue;
      if (ui.status === 'unread' && isRead(a) && !state.keepVisible.has(a.id) && a.id !== state.expandedId) continue;
      if (searchGroups && !searchMatchesCompiled(a, searchGroups)) continue;
      out.push(a);
    }
  }
  out.sort((x, y) => (ui.sortDir === 'oldest' ? 1 : -1) * (x.date - y.date));

  if (state.expandedId && !out.some((a) => a.id === state.expandedId)) {
    const open = findArticle(state.expandedId);
    if (open && !state.search) out.push(open);

  }
  state.visible = out;
  return out;
}

function unreadCount(feedId) {
  let n = 0;
  for (const a of state.feeds.get(feedId) || []) if (!isRead(a)) n++;
  return n;
}
function renderTree() {
  const tree = $('#tree');
  const feeds = state.index?.feeds || {};
  const folders = [...folderDefs()];
  if (ui.sortAZ) folders.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)); 
  const inFolder = new Set();
  let html = '';
  let totalUnread = 0; 
  for (const arts of state.feeds.values()) {
    for (const a of arts) {
      if (isRead(a)) continue;
      totalUnread++;
    }
  }

  const feedItem = (id) => {
    inFolder.add(id);
    const meta = feedMeta(id), n = unreadCount(id);
    if (ui.updatedOnly && n === 0) return '';
    const dim = ui.dimRead && n === 0 ? 'dimmed' : '';
    const st = meta.status || {};
    const failed = st.ok === false && !st.disabled;
    const disabled = !!st.disabled;

    const warnTitle = failed
      ? `Feed fetch failed${st.error ? ': ' + st.error : ''}${st.consecutiveFailures > 1 ? ` — ${st.consecutiveFailures} consecutive failures` : ''}${st.lastSuccess ? ` — last success ${relTime(st.lastSuccess)} ago` : ''}`
      : disabled
        ? 'Feed disabled in config'
        : (meta.title || id);
    const warnIcon = failed ? '<span class="feed-warn" title="' + esc(warnTitle) + '">⚠</span>' : disabled ? '<span class="feed-warn feed-warn-dim" title="' + esc(warnTitle) + '">⚠</span>' : '';
    return `<button class="tree-item ${state.scope === 'feed:' + id ? 'active' : ''} ${n ? 'unread' : ''} ${dim}" data-scope="feed:${esc(id)}" title="${esc(warnTitle)}">
      ${faviconHtml({ title: meta.title, site: meta.site })}<span class="label">${esc(meta.title)}</span>${warnIcon}${n ? `<span class="badge" role="button" tabindex="0" data-markread="feed:${esc(id)}" title="Mark as read">${n}</span>` : ''}
    </button>`;
  };
  for (const folder of folders) {
    let kids = Object.keys(feeds).filter((id) => feedMeta(id).folders.includes(folder.id));
    if (ui.sortAZ) kids.sort((a, b) => feedTitle(a).localeCompare(feedTitle(b)));
    if (ui.updatedOnly) kids = kids.filter((id) => unreadCount(id) > 0);
    if (!kids.length) continue;
    const n = kids.reduce((s, id) => s + unreadCount(id), 0);
    if (ui.updatedOnly && n === 0) continue;
    const open = ui.openFolders[folder.id] === true;
    const dim = ui.dimRead && n === 0 ? 'dimmed' : '';
    html += `<div class="tree-folder ${open ? 'open' : ''}">
      <button class="tree-item ${state.scope === 'folder:' + folder.id ? 'active' : ''} ${n ? 'unread' : ''} ${dim}" data-folder="${esc(folder.id)}" data-scope="folder:${esc(folder.id)}" aria-expanded="${open}">
        <svg class="chev"><use href="#i-chevron"/></svg><span class="label">${esc(folder.name)}</span>${n ? `<span class="badge" role="button" tabindex="0" data-markread="folder:${esc(folder.id)}" title="Mark as read">${n}</span>` : ''}
      </button>
      <div class="tree-children">${kids.map(feedItem).join('')}</div>
    </div>`;
  }
  let loose = Object.keys(feeds).filter((id) => !inFolder.has(id));
  if (ui.sortAZ) loose.sort((a, b) => feedTitle(a).localeCompare(feedTitle(b)));
  if (ui.updatedOnly) loose = loose.filter((id) => unreadCount(id) > 0); 
  if (loose.length) html += loose.map(feedItem).join('');
  tree.innerHTML = html;

  $('#badge-all-items').textContent = totalUnread > 0 ? String(totalUnread) : '';

  $('#subscriptions_fieldset').dataset.counters = ui.countersClickable ? '1' : '0';
  $$('.parent_div > .tree-item[data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === state.scope));
}

function scopeTitle() {
  const s = state.scope;
  if (s === 'all') return 'Newsfeed';
  if (s.startsWith('feed:')) return feedTitle(s.slice(5));
  if (s.startsWith('folder:')) {
    const f = folderDefs().find((x) => x.id === s.slice(7));
    return f?.name || 'Folder';
  }
  return 'Articles';
}

function thumbFor(a) {
  const isImgUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(stripCtrl(u));
  const enc = (a.enclosures || []).find((e) => isImgUrl(e.url) && (/^image\//.test(e.type || '') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(e.url)));
  if (enc) return enc.url;
  const m = String(a.content || '').match(/<img[^>]+src=["']([^"']+)/i);
  const url = m ? m[1] : null;
  return isImgUrl(url) ? url : null;
}
function rowHtml(a) {
  const feed = feedMeta(a._feed);
  const read = isRead(a);
  const kept = isKept(a);
  const thumb = thumbFor(a);
  const isExpanded = state.expandedId === a.id;
  const timeHtml = ui.absoluteDates ? absTime(a.date) : relTime(a.date);
  const showAuthor = a.author && a.author.toLowerCase() !== String(feed.title || '').toLowerCase();
  return `<article class="row ${read ? '' : 'unread'} ${a.highlight ? 'highlight' : ''} ${isExpanded ? 'expanded' : ''}" data-id="${esc(a.id)}">
    ${thumb ? `<img class="row-thumb" loading="lazy" src="${esc(thumb)}" alt="">` : ''}
    <div class="row-main">
      <div class="row-meta">
        ${faviconHtml(feed)}<span class="feed-name">${esc(feed.title)}</span>
        ${showAuthor ? `<span class="author">${esc(a.author)}</span>` : ''}
      </div>
      <div class="row-title">${esc(a.title)}</div>
      <span class="time" title="${esc(fullTime(a.date))}">${esc(timeHtml)}</span>
    </div>
    <div class="row-actions">
      <a class="icon-btn" href="${esc(safeHref(a.link))}" target="_blank" rel="noopener noreferrer" title="Open original in new tab" aria-label="Open original in new tab" data-act="open-original"><svg><use href="#i-external"/></svg></a>
      <button class="icon-btn" data-act="keep" title="${kept ? 'Stop keeping unread' : 'Keep unread'}" aria-pressed="${kept}" aria-label="Keep unread"><svg><use href="#i-${kept ? 'bookmark-on' : 'bookmark'}"/></svg></button>
      <button class="icon-btn" data-act="toggle-read" title="${read ? 'Mark as unread' : 'Mark as read'}" aria-label="Toggle read"><svg><use href="#i-${read ? 'read' : 'unread'}"/></svg></button>
    </div>
  </article>`;
}
function ytId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?.*?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
function articleBody(a) {

  let html = a.text || a.content || `<p>${esc(a.summary || '')}</p>`;

  if (a.link && ytId(a.link) && !html.includes(a.link)) {
    html = `<p><a href="${esc(a.link)}">${esc(a.title || '')}</a></p>` + html;
  }
  return html;
}
function readerBodyHtml(a) {
  return `<div class="reader-body">${articleBody(a)}</div>`;
}
function readerHtml(a) {
  const feed = feedMeta(a._feed);
  const idx = state.visible.indexOf(a);
  const read = isRead(a), kept = isKept(a);
  const link = safeHref(a.link); 
  const showAuthor = a.author && a.author.toLowerCase() !== String(feed.title || '').toLowerCase();
  return `<div class="reader" data-id="${esc(a.id)}">
    <div class="reader-toolbar">
      <span class="spacer"></span>
      <button class="icon-btn" data-act="keep" title="${kept ? 'Stop keeping unread' : 'Keep unread'}" aria-pressed="${kept}" aria-label="Keep unread"><svg><use href="#i-${kept ? 'bookmark-on' : 'bookmark'}"/></svg></button>
      <button class="icon-btn" data-act="toggle-read" title="${read ? 'Mark as unread' : 'Mark as read'}" aria-label="Toggle read"><svg><use href="#i-${read ? 'read' : 'unread'}"/></svg></button>
      <button class="icon-btn" data-act="prev" title="Previous article (k)" ${idx <= 0 ? 'disabled' : ''}><svg><use href="#i-prev"/></svg></button>
      <button class="icon-btn" data-act="next" title="Next article (j)" ${idx >= state.visible.length - 1 ? 'disabled' : ''}><svg><use href="#i-next"/></svg></button>
      <a class="icon-btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Open original (o)" data-act="open-original"><svg><use href="#i-external"/></svg></a>
      <button class="icon-btn" data-act="collapse" title="Close reader"><svg><use href="#i-close"/></svg></button>
    </div>
    <h2 class="reader-title">${link !== '#' ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Open original article">${esc(a.title)}</a>` : esc(a.title)}</h2>
    <div class="reader-sub">
      <span class="sub-feed" data-scope="feed:${esc(a._feed)}" title="Show this feed">${esc(feed.title)}</span>
      ${showAuthor ? `<span>by ${esc(a.author)}</span>` : ''}
      <span title="${esc(fullTime(a.date))}">${esc(ui.absoluteDates ? absTime(a.date) : relTime(a.date))}</span>
      ${readingTime(a) ? `<span>· ${esc(readingTime(a))}</span>` : ''}
    </div>
    ${readerBodyHtml(a)}
    ${attachmentsHtml(a)}

  </div>`;
}
function attachmentsHtml(a) {

  const enc = (a.enclosures || []).filter((e) => e.url && !/^image\//i.test(e.type || ''));
  const imgs = (a.enclosures || []).filter((e) => e.url && /^image\//i.test(e.type || '') && e.type !== 'image/thumbnail');
  if (!enc.length && !imgs.length) return '';
  const href = (u) => esc(safeHref(u));
  const label = (e) => {
    const kind = (e.type || '').split('/')[0];
    const raw = (e.url.split('/').pop() || '').split('?')[0] || '';
    let name = raw;
    try { name = decodeURIComponent(raw); } catch {  }
    name = name.slice(0, 90);
    return kind && kind !== 'image' ? `${kind.toUpperCase()} · ${name}` : name;
  };
  return `<div class="reader-attachments">
    ${enc.map((e) => `<a href="${href(e.url)}" target="_blank" rel="noopener noreferrer"><svg style="width:16px;height:16px"><use href="#i-external"/></svg>${esc(label(e))}</a>`).join('')}
    ${imgs.map((e) => `<a href="${href(e.url)}" target="_blank" rel="noopener noreferrer">${safeHref(e.url) === '#' ? '' : `<img src="${href(e.url)}" alt="">`}${esc(label(e))}</a>`).join('')}
  </div>`;
}
function readingTime(a) {
  try {

    if (!a.text) return '';
    const text = stripTags(a.text);
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (!words) return '';
    const mins = Math.max(1, Math.round(words / 200));
    return `${mins} min read`;
  } catch { return ''; }
}

function updateScopeCount() {
  const unread = state.visible.filter((a) => !isRead(a)).length;
  $('#scope-title').textContent = scopeTitle();
  $('#scope-info')?.classList.toggle('hidden', !state.scope.startsWith('feed:'));
  $('#scope-count').textContent = `${unread} unread`; 
}
function renderList() {
  const list = $('#list');
  const visible = computeVisible();
  list.className = `view-list density-${ui.density}${ui.showFavicons ? '' : ' no-favicons'}`;
  if (state.expandedId && !visible.some((a) => a.id === state.expandedId)) {
    const open = findArticle(state.expandedId);

    if (!open) { state.expandedId = null; clearHashArticle(); }
  }
  const keepScroll = list.scrollTop; 
  renderListHead();

  if (list.clientHeight > 0) {
    while (renderedCount < visible.length && list.scrollHeight < keepScroll + list.clientHeight + 400) appendListChunk();
  }

  const xi = state.expandedId ? visible.findIndex((a) => a.id === state.expandedId) : -1;
  if (xi >= renderedCount) renderUpTo(xi + 1);
  list.scrollTop = keepScroll;
  renderReaderPane(visible);
  updateScopeCount();
  updateTitleCounter();
  syncMarkButtons(); 
  renderEmpty(visible);
}

const LIST_CHUNK = 150;
let renderedCount = 0; 
let listAppendQueued = false;
function rowsHtml(from, toExclusive) {
  let out = '';
  const visible = state.visible;
  for (let i = from; i < toExclusive && i < visible.length; i++) out += rowHtml(visible[i]);
  return out;
}
function renderListHead() {
  const list = $('#list');
  renderedCount = Math.min(state.visible.length, LIST_CHUNK);
  list.innerHTML = rowsHtml(0, renderedCount) + (renderedCount < state.visible.length ? '<div id="list-tail" aria-hidden="true"></div>' : '');
}
function appendListChunk() {
  const list = $('#list');
  if (!list) return;
  const from = renderedCount;
  const to = Math.min(state.visible.length, from + LIST_CHUNK);
  if (to <= from) return;
  let tail = $('#list-tail');
  if (!tail) {
    list.insertAdjacentHTML('beforeend', '<div id="list-tail" aria-hidden="true"></div>');
    tail = $('#list-tail');
  }
  tail.insertAdjacentHTML('beforebegin', rowsHtml(from, to));
  renderedCount = to;
  if (renderedCount >= state.visible.length) tail.remove(); 
}
function renderUpTo(indexInclusive) { while (renderedCount < indexInclusive && renderedCount < state.visible.length) appendListChunk(); }
function maybeAppendListChunk() {
  const list = $('#list');
  if (!list) return;

  let guard = 0;
  while (renderedCount < state.visible.length && guard++ < 8
    && list.scrollTop + list.clientHeight >= list.scrollHeight - 1600) appendListChunk();
}
let readerKey = ''; 
function syncReaderControls(slot, a) {

  const i = state.visible.indexOf(a);
  const prev = slot.querySelector('[data-act="prev"]'), next = slot.querySelector('[data-act="next"]');
  if (prev) prev.disabled = i <= 0;
  if (next) next.disabled = i >= state.visible.length - 1;
  const read = isRead(a), kept = isKept(a);
  const tr = slot.querySelector('[data-act="toggle-read"]');
  if (tr) {
    tr.title = read ? 'Mark as unread' : 'Mark as read';
    const u = tr.querySelector('use');
    if (u) u.setAttribute('href', read ? '#i-read' : '#i-unread');
  }
  const k = slot.querySelector('[data-act="keep"]');
  if (k) {
    k.title = kept ? 'Stop keeping unread' : 'Keep unread';
    k.setAttribute('aria-pressed', String(kept));
    const u = k.querySelector('use');
    if (u) u.setAttribute('href', kept ? '#i-bookmark-on' : '#i-bookmark');
  }
}
function renderReaderPane(visible) {

  const slot = $('#reader-slot');
  if (!slot) return;
  const open = state.expandedId ? findArticle(state.expandedId) : null;

  const show = !!open;
  if (show) {
    const key = `${open.id}:${open.fetchedAt || 0}`;
    if (key !== readerKey) {
      readerKey = key;

      const tpl = document.createElement('template');
      tpl.innerHTML = readerHtml(open);
      tpl.content.querySelectorAll('.reader-body').forEach((el) => { sanitizeReaderDom(el); upgradeEmbeds(el, open.link); });
      slot.replaceChildren(tpl.content);
      slot.classList.remove('hidden');
      document.body.classList.add('article-open');
    } else {
      syncReaderControls(slot, open);
    }
  } else {
    readerKey = '';
    slot.innerHTML = '';
    slot.classList.add('hidden');
    document.body.classList.remove('article-open');
  }
}
function renderEmpty(visible) {
  const el = $('#empty');
  $('#list').classList.toggle('hidden', !visible.length);
  if (visible.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  if (!state.index) {
    el.innerHTML = `<h3>${navigator.onLine ? 'No data yet' : 'You look offline'}</h3><p>${navigator.onLine ? `The hourly GitHub Action builds <code>data/</code>. Trigger it once: <strong>Actions → Fetch feeds &amp; publish → Run workflow</strong>, or wait for the next hour.` : 'Reconnect and reload — the last published data loads from cache when it arrives.'}</p>`;
    return;
  }

  if (feedIdsInScope().some((id) => !state.settled.has(id))) {
    el.innerHTML = `<h3>Loading articles…</h3><p>Fetching this view's feeds — articles appear as they arrive.</p>`;
    return;
  }
  if (feedIdsInScope().some((id) => state.failed.has(id))) {
    el.innerHTML = `<h3>Couldn't load articles</h3><p>Some feeds didn't arrive${navigator.onLine ? '' : ' — you look offline'}, so this view can't be trusted yet. Your read state is safe.</p><p><button class="tool-btn tool-primary" data-retry>Try again</button></p>`;
    return;
  }
  if (state.search) {
    el.innerHTML = `<h3>No matches</h3><p>Nothing matched <code>${esc(state.search)}</code> in any feed.<br>Operators: <code>feed:name</code> <code>title:word</code> <code>before:2026-01-01</code> <code>after:2026-01-01</code> <code>unread:true</code> <code>is:read</code></p>`;
  } else if (ui.status === 'unread') {
    el.innerHTML = `<h3>All caught up 🎉</h3><p>No unread articles here.</p><p class="empty-hint">Over-marked? The ✓ button and its ▾ menu offer <em>Mark as unread</em> — everything, or articles read within the last 1–30 days.</p>`;
  } else {
    el.innerHTML = `<h3>Nothing here</h3><p>No articles in this view. New items arrive when the hourly fetch runs.</p>`;
  }
}

function upgradeEmbeds(root, articleLink) {
  if (!root) return;
  const vimeo = (url) => { const m = url.match(/vimeo\.com\/(\d+)/); return m ? m[1] : null; };
  const audioRe = /\.(mp3|m4a|oga|ogg|wav|aac)(\?|$)/i;
  const videoRe = /\.(mp4|webm|ogv|mov)(\?|$)/i;

  for (const a of $$('a[href]', root)) {
    const url = a.href;
    if (!/^https?:/.test(url)) continue;

    const bare = a.textContent.trim() === url || a.textContent.trim() === (a.getAttribute('href') || '').trim();
    if (!bare && url !== articleLink) continue;
    const wrap = document.createElement('div');
    wrap.className = 'embed';

    const stop = (fn) => (ev) => { ev.stopPropagation(); fn(); };
    const id = ytId(url);
    if (id) {
      wrap.innerHTML = `<button class="embed-facade" type="button" title="Play video" aria-label="Play video"><img loading="lazy" src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt=""></button>`;
      wrap.querySelector('button').addEventListener('click', stop(() => {
        wrap.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1" title="YouTube video" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
      }), { once: true });
      a.replaceWith(wrap); continue;
    }
    const vid = vimeo(url);
    if (vid) {
      wrap.innerHTML = `<button class="embed-facade" type="button" title="Play video" aria-label="Play video"></button>`;
      wrap.querySelector('button').addEventListener('click', stop(() => {
        wrap.innerHTML = `<iframe src="https://player.vimeo.com/video/${vid}?autoplay=1" title="Vimeo video" allowfullscreen loading="lazy"></iframe>`;
      }), { once: true });
      a.replaceWith(wrap); continue;
    }

    if (/^https?:\/\/(www\.)?soundcloud\.com\/[^/?#]+\/[^/?#]+/.test(url)) {
      wrap.innerHTML = `<button class="embed-facade embed-audio" type="button" title="Play audio" aria-label="Play audio">▶ SoundCloud</button>`;
      wrap.querySelector('button').addEventListener('click', stop(() => {
        wrap.innerHTML = `<iframe src="https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&visual=false" title="SoundCloud player" allow="encrypted-media" loading="lazy" style="height:166px"></iframe>`;
      }), { once: true });
      a.replaceWith(wrap); continue;
    }
    if (audioRe.test(url)) { const el = document.createElement('audio'); el.controls = true; el.preload = 'none'; el.src = url; wrap.appendChild(el); a.replaceWith(wrap); continue; }
    if (videoRe.test(url)) { const el = document.createElement('video'); el.controls = true; el.preload = 'none'; el.src = url; wrap.appendChild(el); a.replaceWith(wrap); continue; }
  }
}

function sanitizeReaderDom(root) {
  if (!root) return;
  root.querySelectorAll('script, style, link, meta, form, input, button, object, embed, [data-blocked-embed]').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((el) => {

    el.removeAttribute('class');
    el.removeAttribute('style');
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(attr.name);
    }
    const tag = el.tagName;
    if (tag === 'A') {
      const href = (el.getAttribute('href') || '').trim();

      const scheme = stripCtrl(href).toLowerCase();
      if (/^(javascript|data|vbscript):/.test(scheme)) el.removeAttribute('href');
      else if (/^https?:/i.test(href)) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    }
    if (tag === 'IFRAME') {
      const src = el.getAttribute('src') || '';
      if (!/^https:\/\/(www\.)?(youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/|w\.soundcloud\.com\/)/.test(src)) el.remove();
    }
  });
}

let forceAllowed = false;
const rowEl = (id) => {
  const safe = (window.CSS && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
  return $(`.row[data-id="${safe}"]`);
};
function patchRow(id) {
  const row = rowEl(id);
  const a = row ? findArticle(id) : null;
  if (!row || !a) return false;
  row.classList.toggle('unread', !isRead(a));
  const t = row.querySelector('[data-act="toggle-read"]');
  if (t) {
    t.title = isRead(a) ? 'Mark as unread' : 'Mark as read';
    const u = t.querySelector('use');
    if (u) u.setAttribute('href', isRead(a) ? '#i-read' : '#i-unread');
  }
  const k = row.querySelector('[data-act="keep"]');
  if (k) {
    k.title = isKept(a) ? 'Stop keeping unread' : 'Keep unread';
    k.setAttribute('aria-pressed', String(isKept(a)));
    const u = k.querySelector('use');
    if (u) u.setAttribute('href', isKept(a) ? '#i-bookmark-on' : '#i-bookmark');
  }
  return true;
}

function patchTreeCounts() {
  if (ui.updatedOnly) { renderTree(); return; }
  const plan = [];
  let structural = false;
  for (const row of $$('#tree .tree-item[data-scope]')) {
    const scope = row.dataset.scope || '';
    let n = null;
    if (scope.startsWith('feed:')) n = unreadCount(scope.slice(5));
    else if (scope.startsWith('folder:')) {
      const fid = scope.slice(7);
      n = Object.keys(state.index?.feeds || {}).reduce((s, id) => s + (feedMeta(id).folders.includes(fid) ? unreadCount(id) : 0), 0);
    }
    if (n === null) continue;
    if ((n > 0) !== !!row.querySelector('.badge')) { structural = true; break; } 
    plan.push([row, n]);
  }
  if (structural) { renderTree(); return; }
  for (const [row, n] of plan) {

    const badge = row.querySelector('.badge');
    if (badge) badge.textContent = String(n);
    row.classList.toggle('unread', n > 0);
    row.classList.toggle('dimmed', !!ui.dimRead && n === 0);
  }
  let total = 0;
  for (const arts of state.feeds.values()) {
    for (const a of arts) {
      if (isRead(a)) continue;
      total++;
    }
  }
  const all = $('#badge-all-items');
  if (all) all.textContent = total > 0 ? String(total) : '';
}
function markRead(id, on = true) {
  const a = findArticle(id);
  if (!on) {
    delete state.read[id];

    if (a?.autoRead) { state.userUnread[id] = Date.now(); saveUserUnread(); }
  } else {
    if (a && a.keepUnread && !forceAllowed) return;
    if (state.userUnread[id]) { delete state.userUnread[id]; saveUserUnread(); } 
    state.read[id] = Date.now();

    if (state.visible.some((v) => v.id === id)) state.keepVisible.add(id);
  }
  saveRead();
  if (patchRow(id)) {
    patchTreeCounts();
    updateScopeCount(); updateTitleCounter(); syncMarkButtons();
    const slot = $('#reader-slot');
    if (slot && state.expandedId === id) { const open = findArticle(id); if (open) syncReaderControls(slot, open); }
  } else renderList();
}
function collectScopeIds(scope, cutoff = 0) {

  const feedIds = scopeFeedIds(scope);
  const ids = [];
  for (const feedId of feedIds) {
    for (const a of state.feeds.get(feedId) || []) {
      if (isKept(a) || a.keepUnread || isRead(a)) continue;
      if (cutoff && a.date >= cutoff) continue;
      ids.push(a.id);
    }
  }
  return ids;
}

const OLDER_LABELS = { 1: 'a day', 2: 'two days', 7: 'a week' };
const cutoffFrom = (olderDays = 0) => (olderDays > 0 ? Date.now() - olderDays * 864e5 : 0);
function describeCutoff(olderDays = 0, forUnread = false) {
  const label = OLDER_LABELS[olderDays] || (olderDays > 0 ? `${olderDays} days` : '');
  return olderDays > 0 ? (forUnread ? ` from ${label} ago` : ` older than ${label}`) : '';
}

function dataStartsAt() {
  const feedsMeta = state.index?.feeds || {};
  let min = Infinity;
  for (const id of feedIdsInScope()) {
    const o = feedsMeta[id]?.oldest;
    if (typeof o === 'number' && o > 0 && o < min) min = o;
  }
  return min === Infinity ? 0 : min;
}
function boundaryHint(cutoff = 0) {
  const start = dataStartsAt();
  if (!cutoff || !start || cutoff >= start) return '';
  return ` — data goes back to ${new Date(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function viewHiddenExtra(ids) {
  if (!ids.length) return null;
  const vis = new Set(state.visible.map((a) => a.id));
  if (ids.some((id) => vis.has(id))) return null;
  if (state.search) {
    return { note: ' — hidden by the search', label: 'Clear search', cb: () => closeSearchFn() };
  }
  if (state.scope.startsWith('folder:')) {
    const f = folderDefs().find((x) => x.id === state.scope.slice(7));
    if (Number(f?.maxAgeDays) > 0) return { note: ` — older than this folder's ${f.maxAgeDays}-day view`, label: null };
  }
  return null;
}
function markScopeRead(scope, olderDays = 0) {
  const what = describeCutoff(olderDays);
  const cutoff = cutoffFrom(olderDays);
  const ids = collectScopeIds(scope, cutoff);
  if (!ids.length) {
    showToast(olderDays ? `No unread articles${what} here${boundaryHint(cutoff)}` : 'Nothing to mark — everything here is read');
    return;
  }
  const snapshot = ids.map((id) => ({ id, ts: state.read[id], guard: state.userUnread[id] || 0 }));
  for (const id of ids) {
    state.read[id] = Date.now();

    if (state.userUnread[id]) delete state.userUnread[id];
  }
  if (snapshot.some((s) => s.guard)) saveUserUnread();
  saveRead(); state.keepVisible.clear(); renderTree(); renderList();
  const extra = viewHiddenExtra(ids);
  showToast(`Marked ${ids.length} article${ids.length === 1 ? '' : 's'}${what} as read${extra?.note || ''}`, 'Undo', () => {
    for (const { id, ts, guard } of snapshot) { if (ts) state.read[id] = ts; else delete state.read[id]; if (guard) state.userUnread[id] = guard; else delete state.userUnread[id]; }
    saveRead(); saveUserUnread(); renderTree(); renderList();
  }, false, extra && extra.label ? extra : null);
}
function markAllAsReadInScope() {
  if (allReadInScope()) {

    confirmDialog('Mark as unread', `Mark every article in "${scopeTitle()}" as unread again?`, () => {
      markScopeUnread(state.scope);
    });
  } else {
    confirmDialog('Mark all as read', `Mark all articles in "${scopeTitle()}" as read? Articles kept unread are skipped.`, async () => {

      await Promise.race([ensureLoadedForScope(state.scope), sleep(11000)]);
      markScopeRead(state.scope);
    });
  }
}

function scopeUnreadCount(scope) {

  let n = 0;
  for (const feedId of scopeFeedIds(scope)) {
    for (const a of state.feeds.get(feedId) || []) {
      if (isRead(a)) continue;
      n++;
    }
  }
  return n;
}
function allReadInScope() {
  const ids = feedIdsInScope();

  if (!state.index?.feeds || !ids.length) return false;
  if (ids.some((id) => !state.settled.has(id))) return false; 
  if (ids.some((id) => state.failed.has(id))) return false;
  return scopeUnreadCount(state.scope) === 0;
}
function collectScopeReadIds(scope, cutoff = 0) {
  const ids = [];

  for (const feedId of scopeFeedIds(scope)) {
    for (const a of state.feeds.get(feedId) || []) {
      if (!isRead(a)) continue; 
      if (cutoff && a.date < cutoff) continue;
      ids.push(a.id);
    }
  }
  return ids;
}
function markScopeUnread(scope, olderDays = 0) {
  const what = describeCutoff(olderDays, true);
  const cutoff = cutoffFrom(olderDays);
  const ids = collectScopeReadIds(scope, cutoff);
  if (!ids.length) {
    showToast(olderDays ? `No read articles${what} here${boundaryHint(cutoff)}` : 'Nothing to restore — no read articles here');
    return;
  }
  const snapshot = ids.map((id) => ({ id, ts: state.read[id], guard: state.userUnread[id] || 0 }));
  for (const id of ids) {
    delete state.read[id];

    const a = findArticle(id);
    if (a?.autoRead && !state.userUnread[id]) state.userUnread[id] = Date.now();
  }
  saveUserUnread();
  state.keepVisible.clear();
  saveRead(); renderTree(); renderList();
  const extra = viewHiddenExtra(ids);
  showToast(`Marked ${ids.length} article${ids.length === 1 ? '' : 's'}${what} as unread${extra?.note || ''}`, 'Undo', () => {
    for (const { id, ts, guard } of snapshot) { if (ts) state.read[id] = ts; else delete state.read[id]; if (guard) state.userUnread[id] = guard; else delete state.userUnread[id]; }
    saveRead(); saveUserUnread(); renderTree(); renderList();
  }, false, extra && extra.label ? extra : null);
}
function scopeArticleStats(scope) {

  let unread = 0, read = 0, total = 0;
  for (const feedId of scopeFeedIds(scope)) {
    for (const a of state.feeds.get(feedId) || []) {
      total++;
      if (isRead(a)) read++; else unread++;
    }
  }
  return { unread, read, total };
}
let markAge = { dates: [], unread: false };
function buildMarkAge(unread) {
  const ids = unread ? collectScopeReadIds(state.scope, 0) : collectScopeIds(state.scope, 0);
  const dates = [];
  for (const id of ids) {
    const a = findArticle(id);
    if (a && a.date > 0) dates.push(a.date);
  }
  dates.sort((x, y) => x - y);
  markAge = { dates, unread };
}
function ageCountFor(days) {
  const cutoff = cutoffFrom(days);
  const d = markAge.dates;
  let lo = 0, hi = d.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] < cutoff) lo = mid + 1; else hi = mid;
  }
  return markAge.unread ? d.length - lo : lo;
}
function updateAgeUi(days) {
  const s = $('#mark-age-slider');
  const v = $('#mark-age-value');
  const c = $('#mark-age-count');
  if (!s || !v || !c) return;
  const label = `${days} ${days === 1 ? 'day' : 'days'}`;
  v.textContent = label;
  s.setAttribute('aria-valuetext', label);
  const n = ageCountFor(days);
  c.textContent = n > 0 ? `Will mark ${n} article${n === 1 ? '' : 's'}` : 'Nothing to mark here';
}
function syncAgeDirection(caughtUp) {
  const t = $('#mark-age-title');
  const d = $('#mark-age-desc');
  const ap = $('#mark-age-apply');
  if (!t || !d || !ap) return;
  t.textContent = caughtUp ? 'Mark as unread' : 'Mark as read';
  d.textContent = caughtUp ? 'Read articles from the last' : 'Articles older than';
  ap.textContent = caughtUp ? 'Mark as unread' : 'Mark as read';
}
function syncMarkButtons(forceReset = false) {
  const wrap = $('.btn-group-markread');
  const btn = $('#btn-mark-all');
  if (!btn || !wrap) return;
  const stats = scopeArticleStats(state.scope);
  const caughtUp = stats.unread === 0 && stats.read > 0 && allReadInScope();
  const show = stats.unread > 0 || caughtUp;
  wrap.classList.toggle('hidden', !show);
  if (!show) {
    $('#mark-menu')?.classList.add('hidden');
    return;
  }
  btn.title = caughtUp ? 'Mark all as unread' : 'Mark all as read';
  btn.setAttribute('aria-label', btn.title);
  const use = btn.querySelector('use');
  if (use) use.setAttribute('href', caughtUp ? '#i-unread' : '#i-read');
  const split = $('#btn-mark-all-split');
  if (split) split.title = caughtUp ? 'Mark as unread — more options' : 'Mark as read — more options';
  const menu = $('#mark-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (forceReset) {
    syncAgeDirection(caughtUp);
    buildMarkAge(caughtUp);
    const days = Math.min(30, Math.max(1, Math.round(Number(ui.markAgeDays) || 7)));
    const s = $('#mark-age-slider');
    if (s) s.value = String(days);
    updateAgeUi(days);
  } else {
    buildMarkAge(markAge.unread);
    updateAgeUi(Math.min(30, Math.max(1, Number($('#mark-age-slider')?.value) || 1)));
  }
}

let toastTimer = null;
function showToast(text, actionLabel, cb, ambient = false, extra = null) {
  const el = $('#toast');
  const btn = $('#toast-action');
  const btn2 = $('#toast-action-2');
  const anyActionLive = () => !el.classList.contains('hidden')
    && ((btn && btn.style.display !== 'none') || (btn2 && btn2.style.display !== 'none'));

  if (ambient && !actionLabel && !extra && anyActionLive()) return;
  $('#toast-text').textContent = text;
  btn.textContent = actionLabel || '';
  btn.style.display = actionLabel ? '' : 'none';
  btn.onclick = () => { if (cb) cb(); hideToast(); };

  if (btn2) {
    const label2 = extra?.label || '';
    btn2.textContent = label2;
    btn2.style.display = label2 ? '' : 'none';
    btn2.onclick = () => { if (extra?.cb) extra.cb(); hideToast(); };
  }
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 7000);
}
function hideToast() { $('#toast').classList.add('hidden'); }

const HASH_PREFIX = '#article/';
const hashArticleId = () => {
  const h = location.hash || '';
  if (!h.startsWith(HASH_PREFIX)) return null;

  try { return decodeURIComponent(h.slice(HASH_PREFIX.length)); } catch { return h.slice(HASH_PREFIX.length); }
};
const canonHashKey = (s) => String(s || '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '');
function scopeHashFor(scope) {
  if (scope.startsWith('folder:')) {
    const f = folderDefs().find((x) => x.id === scope.slice(7));
    return f ? '#folder/' + encodeURIComponent(f.name || f.id) : '';
  }
  if (scope.startsWith('feed:')) {
    const t = feedTitle(scope.slice(5));
    return t ? '#feed/' + encodeURIComponent(t) : '';
  }
  return '';
}
function hashScope() {
  const m = /^#(folder|feed)\/(.+)$/i.exec(location.hash || '');
  if (!m) return null;
  let name;
  try { name = decodeURIComponent(m[2]); } catch { name = m[2]; }
  const key = canonHashKey(name);
  if (!key) return null;
  if (m[1].toLowerCase() === 'folder') {
    const f = folderDefs().find((x) => key === canonHashKey(x.name) || key === canonHashKey(x.id));
    return f ? 'folder:' + f.id : null;
  }
  const id = Object.keys(state.index?.feeds || {}).find((x) => key === canonHashKey(x) || key === canonHashKey(feedTitle(x)));
  return id ? 'feed:' + id : null;
}
function setHashArticle(id) {
  const target = HASH_PREFIX + encodeURIComponent(id);
  if ((location.hash || '') === target) return; 

  try {
    history.pushState(null, '', location.pathname + location.search + target);
  } catch {
    location.hash = target; 
    return;
  }
  syncFromHash();
}
function pushScopeHash(scope) {
  const target = scopeHashFor(scope);
  const want = location.pathname + location.search + target;
  if (location.pathname + location.search + (location.hash || '') === want) return;
  try {
    history.pushState(null, '', want);
  } catch {
    if (target) location.hash = target;
  }
}
function clearHashArticle() {
  const target = scopeHashFor(state.scope);
  const want = location.pathname + location.search + target;
  if (location.pathname + location.search + (location.hash || '') === want) return;
  try { history.replaceState(null, '', want); } catch { if (target) location.hash = target; }
}
function openArticle(id) {
  const a = findArticle(id);
  if (!a) return false;
  if (state.expandedId) {
    state.keepVisible.add(state.expandedId);
    if (state.expandedId !== id) { const prevRow = rowEl(state.expandedId); if (prevRow) prevRow.classList.remove('expanded'); }
  }
  state.expandedId = id;
  const row = rowEl(id);
  if (row) { row.classList.add('expanded'); listScrollTo(id); }
  else { renderList(); listScrollTo(id); }
  renderReaderPane(state.visible);
  if (ui.autoScroll) { const ap = $('#article_pane'); if (ap) ap.scrollTop = 0; }
  if (!isRead(a) && !isKept(a) && !a.keepUnread) markRead(a.id, true);
  updateTitleCounter();
  return true;
}
function closeArticle(keep = true) {
  if (!state.expandedId) return;
  if (keep) state.keepVisible.add(state.expandedId); 
  state.expandedId = null;
  renderList();
}
function openViaHash(id) {
  if (hashArticleId() === id) openArticle(id); 
  else setHashArticle(id);                     
}
function closeViaHash() { clearHashArticle(); closeArticle(true); }
function applyScopeHash(notify = true) {
  if (!/^#(folder|feed)\//i.test(location.hash || '')) return false;
  const scope = hashScope();
  if (!scope) {
    if (/^#feed\//i.test(location.hash) && !state.index) return true;
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    if (notify) showToast('That folder or feed link does not match anything in this reader');
    return true;
  }
  if (state.scope === scope) {
    if (state.expandedId) closeArticle(true);
    return true;
  }
  state.scope = scope;
  state.expandedId = null;
  state.keepVisible.clear();
  document.body.classList.remove('sidebar-open');
  $('#scrim').classList.add('hidden');
  renderAll();
  ensureLoadedForScope();
  return true;
}
function syncFromHash(notify = true) {
  const id = hashArticleId();
  if (id) {
    if (state.expandedId === id) return;
    if (!openArticle(id)) { 
      clearHashArticle();
      if (notify) showToast('That article is no longer available (past its retention window or filtered out server-side)');
    }
  } else if (!applyScopeHash(notify)) closeArticle(true); 
}

function dispatchAct(act, id) {
  const a = findArticle(id);
  if (!a) return;
  if (act === 'toggle-read') {
    forceAllowed = true; markRead(id, !isRead(a)); forceAllowed = false;
    if (isRead(a)) { delete state.kept[id]; saveKept(); patchRow(id); } 
  }
  else if (act === 'keep') {
    if (state.kept[id]) delete state.kept[id];
    else {
      state.kept[id] = Date.now();

      delete state.read[id];
    }
    saveKept(); saveRead();
    if (!patchRow(id)) renderList();
    patchTreeCounts(); updateScopeCount(); updateTitleCounter(); syncMarkButtons();
    const slot = $('#reader-slot');
    if (slot && state.expandedId === id) syncReaderControls(slot, a);
  }
  else if (act === 'open-original') {  }
  else if (act === 'collapse') closeViaHash(); 
  else if (act === 'prev' || act === 'next') {
    const i = state.visible.indexOf(a);
    const target = state.visible[act === 'prev' ? i - 1 : i + 1];
    if (target) openViaHash(target.id); 
  }
}

function onListClick(e) {
  const rowEl = e.target.closest('.row');
  if (!rowEl) return;
  const id = rowEl.dataset.id;
  const a = findArticle(id);
  if (!a) return;

  const sel = window.getSelection?.();
  if (sel && String(sel).trim()) return;
  const actBtn = e.target.closest('[data-act]');

  if (actBtn) {
    e.stopPropagation();
    dispatchAct(actBtn.dataset.act, id);
    return;
  }
  if (state.expandedId === id) { closeViaHash(); return; } 
  openViaHash(id); 
}
function listScrollTo(id) {
  let el = rowEl(id);
  if (!el) { 
    const i = state.visible.findIndex((a) => a.id === id);
    if (i >= 0) { renderUpTo(i + 1); el = rowEl(id); }
  }
  if (el) el.scrollIntoView?.({ block: 'nearest' });
}

function renderAll() { renderTree(); renderList(); }

const LIST_MIN_W = 260, ARTICLE_MIN_W = 320;
const paneAvail = () => {
  const pane = $('#reader_pane');
  const paneW = pane && pane.getBoundingClientRect ? pane.getBoundingClientRect().width : 0;
  return paneW > 0 ? paneW : (window.innerWidth || 0);
};
const clampListW = (w, avail) => Math.min(Math.max(LIST_MIN_W, Math.round(w)), Math.max(LIST_MIN_W, Math.round(avail - ARTICLE_MIN_W)));
const applyListW = (w) => {
  const root = document.documentElement;
  if (w > 0) {
    root.style.setProperty('--list-w', `${w}px`);
    root.style.setProperty('--article-cap', 'none');
  } else {
    root.style.removeProperty('--list-w');
    root.style.removeProperty('--article-cap');
  }
};

function bindEvents() {
  $('#list').addEventListener('click', onListClick);

  $('#list').addEventListener('scroll', () => {
    if (listAppendQueued) return;
    listAppendQueued = true;
    requestAnimationFrame(() => { listAppendQueued = false; maybeAppendListChunk(); });
  }, { passive: true });
  $('#reader-slot').addEventListener('click', (e) => {
    if (!state.expandedId) return;
    const actBtn = e.target.closest('[data-act]');
    if (!actBtn) return;
    e.stopPropagation();
    dispatchAct(actBtn.dataset.act, state.expandedId);
  });
  $('#scroll-up').addEventListener('click', () => {
    const btn = $('#reader-slot [data-act="prev"]');
    if (btn && !btn.disabled) btn.click();
  });
  $('#scroll-down').addEventListener('click', () => {
    const btn = $('#reader-slot [data-act="next"]');
    if (btn && !btn.disabled) btn.click();
  });

  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.classList.contains('favicon')) {
      img.closest?.('.favicon-wrap')?.querySelector('.favicon-tile')?.removeAttribute('hidden');
      img.remove();
    } else if (img.classList.contains('row-thumb')) img.remove();
  }, true);

  addEventListener('storage', (e) => {
    if (e.key !== LS_READ && e.key !== LS_KEPT && e.key !== LS_USERUNREAD) return;
    state.read = loadObj(LS_READ);
    state.kept = loadObj(LS_KEPT);
    state.userUnread = loadObj(LS_USERUNREAD);
    renderAll();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#header-menu') && !e.target.closest('#btn-more')) $('#header-menu')?.classList.add('hidden');
    if (!e.target.closest('#mark-menu') && !e.target.closest('#btn-mark-all-split')) $('#mark-menu')?.classList.add('hidden');
    syncMenuAria();
    const markBtn = e.target.closest('[data-markread]');
    if (markBtn) {
      e.stopPropagation();
      if (!ui.countersClickable) return;
      const scope = markBtn.dataset.markread;

      const run = async () => {
        await Promise.race([ensureLoadedForScope(scope), sleep(11000)]);
        markScopeRead(scope);
      };
      run();
      return;
    }
    const chev = e.target.closest('.tree-folder > .tree-item .chev');
    if (chev) {

      e.stopPropagation();
      const wrap = chev.closest('.tree-folder');
      const fbtn = chev.closest('.tree-item');
      if (wrap && fbtn?.dataset.folder) {
        ui.openFolders[fbtn.dataset.folder] = !wrap.classList.contains('open');
        saveUi();
        renderTree();
      }
      return;
    }
    const scopeBtn = e.target.closest('[data-scope]');
    if (scopeBtn) {
      state.scope = scopeBtn.dataset.scope;
      pushScopeHash(state.scope);
      state.expandedId = null;
      state.keepVisible.clear();
      document.body.classList.remove('sidebar-open');
      $('#scrim').classList.add('hidden'); 
      renderAll();
      ensureLoadedForScope();
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target?.closest?.('[data-markread]');
    if (t) { e.preventDefault(); t.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });

  $('#status-items').addEventListener('click', (e) => {
    const item = e.target.closest('[data-status]');
    if (!item) return;
    const v = item.dataset.status;
    ui.status = v === 'all' ? 'all' : 'unread';
    if (state.scope !== 'all' && !state.scope.startsWith('feed:') && !state.scope.startsWith('folder:')) state.scope = 'all';
    clearHashArticle();
    state.expandedId = null;
    state.keepVisible.clear(); 
    saveUi(); syncControls(); renderAll(); ensureLoadedForScope();
    $('#header-menu').classList.add('hidden');
    syncMenuAria();
  });
  $('#menu-refresh').addEventListener('click', () => { $('#header-menu').classList.add('hidden'); refresh(true); });
  $('#empty').addEventListener('click', (e) => {
    if (!e.target.closest('[data-retry]')) return;
    refresh(true);
  });
  window.addEventListener('hashchange', () => syncFromHash()); 
  window.addEventListener('popstate', () => syncFromHash());   
  $('#menu-reset-read').addEventListener('click', () => {
    $('#header-menu').classList.add('hidden');
    syncMenuAria();
    confirmDialog('Reset read state', 'Forget all read and keep-unread state? Every article goes back to unread.', () => {
      state.read = Object.create(null); state.kept = Object.create(null); state.userUnread = Object.create(null);
      state.keepVisible.clear();
      saveRead(); saveKept(); saveUserUnread(); renderTree(); renderList();
      showToast('Feed state reset — every article is unread again');
    });
  });

  let searchTimer = null;
  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.search = $('#search-input').value.trim();
      renderList();
      if (state.search) {

        const missing = Object.keys(state.index?.feeds || {}).filter((id) => !state.feeds.has(id));
        if (missing.length) { await loadAllFeeds(() => {}); renderTree(); renderList(); }
      }
    }, 200);
  });

  $('#btn-mark-all').addEventListener('click', markAllAsReadInScope);
  $('#btn-mark-all-split').addEventListener('click', (e) => {
    e.stopPropagation(); 
    const menu = $('#mark-menu');
    const opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');

    if (opening) syncMarkButtons(true);
    syncMenuAria();
  });

  const applyMark = async (fn, olderDays) => {
    const load = ensureLoadedForScope(state.scope);
    const slow = setTimeout(() => showToast('Still loading this view — marking what has arrived so far', undefined, undefined, true), 1500);
    try {
      await Promise.race([load, sleep(11000)]);
    } finally {
      clearTimeout(slow);
    }
    fn(state.scope, olderDays);
  };
  $('#mark-age-slider').addEventListener('input', () => {
    updateAgeUi(Math.min(30, Math.max(1, Number($('#mark-age-slider').value) || 1)));
  });
  $('#mark-age-slider').addEventListener('change', () => {
    ui.markAgeDays = Math.min(30, Math.max(1, Number($('#mark-age-slider').value) || 1));
    saveUi();
  });
  $('#mark-age-apply').addEventListener('click', () => {
    const days = Math.min(30, Math.max(1, Number($('#mark-age-slider').value) || 1));
    $('#mark-menu').classList.add('hidden');
    syncMenuAria();
    applyMark(markAge.unread ? markScopeUnread : markScopeRead, days);
  });
  $('#sort-items').addEventListener('click', (e) => {
    const item = e.target.closest('[data-sort]');
    if (!item) return;
    ui.sortDir = item.dataset.sort; saveUi(); syncControls(); renderList();
  });

  $('#search-open').addEventListener('click', openSearchFn);
  $('#search-close').addEventListener('click', closeSearchFn);
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearchFn(); } }); 

  $('#btn-more').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#header-menu').classList.toggle('hidden');
    syncMenuAria();
  });

  const resizer = $('#sidebar_resizer');
  if (resizer) {
    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || 242; 
      let cur = startW;
      const move = (ev) => {
        cur = Math.min(480, Math.max(210, startW + (ev.clientX - startX)));
        document.documentElement.style.setProperty('--sidebar-width', `${cur}px`);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        ui.sidebarW = cur; saveUi();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
  }

  const readerResizer = $('#reader_resizer');
  if (readerResizer) {
    readerResizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const avail = paneAvail();
      const lp = $('#list_pane');
      const rectW = lp && lp.getBoundingClientRect ? lp.getBoundingClientRect().width : 0;
      const startW = clampListW(ui.listW || Math.round(rectW || (window.innerWidth || 1024) * 0.44), avail);
      let cur = startW;
      const move = (ev) => {
        cur = clampListW(startW + (ev.clientX - startX), avail);
        applyListW(cur);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        document.body.classList.remove('reader-dragging');
        if (cur !== ui.listW) { ui.listW = cur; saveUi(); }
      };
      document.body.classList.add('reader-dragging');
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
    readerResizer.addEventListener('dblclick', () => {
      delete ui.listW;
      applyListW(0);
      saveUi();
    });
  }

  $('#scope-info')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openFeedModal();
  });
  $('#feed-modal-close')?.addEventListener('click', closeFeedModal);
  $('#feed-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeFeedModal();
  });

  $('#menu-toggle').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
    $('#scrim').classList.toggle('hidden', !document.body.classList.contains('sidebar-open'));
  });
  $('#scrim').addEventListener('click', () => { document.body.classList.remove('sidebar-open'); $('#scrim').classList.add('hidden'); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    const modal = $('#confirm-modal');
    if (modal && !modal.classList.contains('hidden')) { $('#confirm-no')?.click(); return; }
    const feedModal = $('#feed-modal');
    if (feedModal && !feedModal.classList.contains('hidden')) { closeFeedModal(); return; }
    const menuOpen = !$('#header-menu')?.classList.contains('hidden') || !$('#mark-menu')?.classList.contains('hidden');
    const sidebarOpen = document.body.classList.contains('sidebar-open');
    $('#header-menu')?.classList.add('hidden');
    $('#mark-menu')?.classList.add('hidden');
    document.body.classList.remove('sidebar-open');
    $('#scrim')?.classList.add('hidden');
    syncMenuAria();
    if (menuOpen || sidebarOpen) return;
    if (state.expandedId) closeViaHash(); 
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (document.querySelector('.modal:not(.hidden), .dropdown:not(.hidden)')) return; 
    if (e.key === 'j' || e.key === 'k') {
      if (!state.visible.length) return;
      const i = state.expandedId ? state.visible.findIndex((a) => a.id === state.expandedId) : -1;
      const target = e.key === 'j'
        ? state.visible[Math.min(state.visible.length - 1, i + 1)]
        : state.visible[Math.max(0, i - 1)];
      if (target && target.id !== state.expandedId) openViaHash(target.id);
      return;
    }
    const id = state.expandedId;
    const a = id ? findArticle(id) : null;
    if (e.key === 'm' && a) { dispatchAct('toggle-read', id); } 
    else if ((e.key === 'o' || e.key === 'v') && a) { const url = safeHref(a.link); if (url !== '#') window.open(url, '_blank', 'noopener'); }
    else if (e.key === 's' && a) { dispatchAct('keep', id); }
    else if (e.key === '/') { e.preventDefault(); openSearchFn(); }
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = ui.theme;

  try { localStorage.setItem('ghrss:theme', JSON.stringify(ui.theme)); } catch {}
}
function applySidebarMode() {
  document.body.classList.toggle('compact-sidebar', !!ui.compactSidebar);
  document.body.classList.toggle('hide-side-favicons', !ui.sideFavicons);
}
function openSearchFn() {
  $('#search-box').classList.remove('hidden');
  $('#search-open').classList.add('hidden');
  $('#search-input').focus();
}
function closeSearchFn() {
  $('#search-box').classList.add('hidden');
  $('#search-open').classList.remove('hidden');
  const inp = $('#search-input');
  if (inp) inp.value = '';
  if (state.search) { state.search = ''; renderList(); } 
}
function syncControls() {
  $$('#status-items [data-status]').forEach((c) => c.classList.toggle('on', c.dataset.status === ui.status));
  $$('#sort-items [data-sort]').forEach((c) => c.classList.toggle('on', c.dataset.sort === (ui.sortDir === 'oldest' ? 'oldest' : 'newest')));
  document.documentElement.style.setProperty('--title-size', ui.fontSize || '14.5px');
  applySidebarMode();
}

function syncMenuAria() {

  $('#btn-more')?.setAttribute('aria-expanded', String(!$('#header-menu')?.classList.contains('hidden')));
  $('#btn-mark-all-split')?.setAttribute('aria-expanded', String(!$('#mark-menu')?.classList.contains('hidden')));
}

function confirmDialog(title, text, onYes) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-modal').classList.remove('hidden');
  const yes = $('#confirm-yes'), no = $('#confirm-no');
  const prevFocus = document.activeElement;
  const done = () => {
    yes.onclick = null; no.onclick = null;
    $('#confirm-modal').classList.add('hidden');
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  yes.onclick = () => { done(); onYes(); };
  no.onclick = done;
  yes.focus();
}

const ago = (ts) => (relTime(ts) === 'now' ? 'just now' : relTime(ts) + ' ago');
function feedInfoHtml(feedId) {
  const meta = feedMeta(feedId);
  const arts = state.feeds.get(feedId) || [];
  const unread = arts.reduce((n, a) => n + (isRead(a) ? 0 : 1), 0);
  const st = meta.status || {};
  const folderNames = meta.folders.map((fid) => folderDefs().find((x) => x.id === fid)?.name || fid);
  const lastPost = meta.newest ? ago(meta.newest) : 'Never';
  const crawlTs = st.ok === false ? st.lastAttempt : (st.lastSuccess || st.lastAttempt);
  const crawlState = st.ok === false
    ? (st.disabled ? 'Disabled' : `Failed${st.error ? ` — ${st.error}` : ''}`)
    : 'Success';
  const crawl = `${crawlState} · ${crawlTs ? ago(crawlTs) : 'never'}${st.ok === false && st.lastSuccess ? ` (last success ${ago(st.lastSuccess)})` : ''}`;
  const link = (u) => (/^https?:\/\//i.test(stripCtrl(String(u))) ? String(u) : '');
  const site = link(meta.site), xml = link(meta.xml);
  const pfpImg = link(meta.image);
  const row = (k, v) => `<div class="fi-row"><span class="fi-k">${k}</span><span class="fi-v">${v}</span></div>`;
  const rowLink = (k, u) => row(k, `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`);
  return `<div class="fi-head">
    <span class="fi-pfp">${pfpImg ? `<img src="${esc(pfpImg)}" alt="">` : faviconHtml(meta)}</span>
    <span class="fi-headtext">
      <span class="fi-name">${esc(meta.title || feedId)}</span>
      <span class="fi-sub">${arts.length} article${arts.length === 1 ? '' : 's'} · ${unread} unread</span>
    </span>
    <span class="fi-dot ${st.ok === false ? 'bad' : 'good'}" title="${esc(crawlState)}"></span>
  </div>
  <div class="fi-rows">
    ${meta.origTitle ? row('Original title', esc(meta.origTitle)) : ''}
    ${site ? rowLink('Website', site) : ''}
    ${xml ? rowLink('XML address', xml) : ''}
    ${row('Folder', esc(folderNames.join(', ') || '—'))}
    ${row('Last post', esc(lastPost))}
    ${row('Last crawled', esc(crawl))}
  </div>`;
}
function openFeedModal() {
  if (!state.scope.startsWith('feed:')) return;
  const feedId = state.scope.slice(5);
  const meta = feedMeta(feedId);
  $('#feed-modal-title').textContent = meta.title || feedId;
  $('#feed-modal-body').innerHTML = feedInfoHtml(feedId);
  $('#feed-modal').classList.remove('hidden');
  $('#feed-modal-close')?.focus();
}
function closeFeedModal() {
  $('#feed-modal')?.classList.add('hidden');
}

async function refresh(manual = false) {
  state.lastPollAt = Date.now();
  try {
    const index = await fetchJson('data/index.json');
    const changed = index.generatedAt !== state.index?.generatedAt;
    state.index = index;
    if (!changed && !manual) { renderTree(); flashUpdated(); return; } 

    const beforeIds = new Set();
    for (const arts of state.feeds.values()) for (const a of arts) beforeIds.add(a.id);
    const consolidated = await loadConsolidatedIntoState();
    if (!consolidated) {

      await loadMany([...new Set([...state.feeds.keys(), ...state.failed])], null, true);
    }
    renderAll();
    flashUpdated();
    let fresh = 0;
    for (const arts of state.feeds.values()) for (const a of arts) if (!beforeIds.has(a.id)) fresh++;
    if (fresh) showToast(`${fresh} new article${fresh === 1 ? '' : 's'} synced`, undefined, undefined, true);
    else if (manual) showToast('Already up to date', undefined, undefined, true);
  } catch (err) {
    if (manual) flashUpdated('offline — showing last data');
  }
}
function flashUpdated(msg) {
  const el = $('#last-updated-text');
  if (!el) return;
  if (msg) { el.textContent = msg; el.title = ''; return; }
  const ts = state.index?.generatedAt;
  el.textContent = ts ? `Updated ${relTime(ts) === 'now' ? 'just now' : relTime(ts) + ' ago'}` : 'No data yet';
  el.title = ts ? fullTime(ts) : '';
}
function startPolling() {
  clearTimeout(state.refreshTimer);
  const period = Math.max(5, Number(state.config?.settings?.refreshMinutes) || 5) * 60000;
  const schedule = () => {
    const delay = period - (Date.now() % period) + 2500; 
    state.refreshTimer = setTimeout(async () => {
      if (document.visibilityState === 'visible') await refresh(false); 
      schedule();
    }, delay);
  };
  schedule();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.lastPollAt || Date.now() - state.lastPollAt > period) refresh(false);
  });
}
async function ensureLoadedForScope(scope = state.scope) {
  let ids = scopeFeedIds(scope).filter((id) => !state.feeds.has(id));
  if (!ids.length) return;

  if (ids.length > 8) {
    await loadConsolidatedIntoState();
    ids = scopeFeedIds(scope).filter((id) => !state.feeds.has(id));
  }
  if (ids.length) await loadMany(ids, () => { renderTree(); renderList(); });
  renderAll();
}

function pruneReadState() {
  if (!state.index?.feeds) return;
  const retention = Number(state.config?.settings?.retentionDays) > 0 ? Number(state.config.settings.retentionDays) : 60;
  const cutoff = Date.now() - (retention + 14) * 864e5;
  const Y2K = 946684800000; 
  let dropped = false;
  for (const k of Object.keys(state.read)) {
    const ts = state.read[k];
    if (typeof ts === 'number' ? (ts >= Y2K && ts < cutoff) : !ts) { delete state.read[k]; dropped = true; }
  }
  if (dropped) saveRead();
}
async function loadConsolidatedIntoState() {
  try {
    const allData = await fetchJson('data/all-feeds.json');

    if (!Array.isArray(allData?.articles) || !state.index?.feeds) return false;

    const prevById = new Map();
    for (const arts of state.feeds.values()) for (const a of arts) prevById.set(a.id, a);
    const grouped = new Map();
    for (const a of allData.articles) {
      const feedId = a._feed;
      if (!feedId) continue;
      const old = prevById.get(a.id);
      if (old && old.content === a.content && old.title === a.title && old.link === a.link
        && old.summary === a.summary && (old.enclosures || []).length === (a.enclosures || []).length) {
        a.fetchedAt = old.fetchedAt || a.fetchedAt;
      }
      if (!grouped.has(feedId)) grouped.set(feedId, []);
      grouped.get(feedId).push(a);
    }
    state.feeds = new Map();
    for (const [feedId, arts] of grouped.entries()) {
      materializeFeedFlags(feedId, arts);
      state.feeds.set(feedId, arts);
    }
    for (const id of Object.keys(state.index.feeds)) {
      if (!state.feeds.has(id)) state.feeds.set(id, []); 
      state.settled.add(id);
    }
    markFeedsChanged();
    const feedsMeta = { ...state.index.feeds };
    for (const [feedId, arts] of state.feeds.entries()) {
      const meta = feedsMeta[feedId];
      if (meta) {
        const sorted = [...arts].sort((x, y) => y.date - x.date);
        meta.count = arts.length;
        meta.newest = sorted[0]?.date || meta.newest;
        meta.oldest = sorted[sorted.length - 1]?.date || meta.oldest;
      }
    }
    state.index = { ...state.index, feeds: feedsMeta };
    state.failed.clear();
    pruneReadState();
    return true;
  } catch {
    return false;
  }
}

async function boot() {
  applyTheme();
  bindEvents();
  try {
    state.config = await fetchJson('config.json');
    const s = state.config.settings || {};

    for (const k of CONFIG_KEYS) if (k in s) ui[k] = s[k];

    baseTitle = s.siteName || 'My RSSFeed';
    document.title = baseTitle;
    applyTheme(); 

    if (ui.sidebarW) {
      const w = Math.min(480, Math.max(210, Number(ui.sidebarW) || 242));
      ui.sidebarW = w;
      document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
    }
    if (ui.listW) {
      const raw = Math.round(Number(ui.listW) || 0);
      if (raw > 0) {
        const lw = clampListW(raw, paneAvail());
        ui.listW = lw;
        applyListW(lw);
      } else delete ui.listW;
    }
  } catch (err) {
    $('#empty').classList.remove('hidden');
    $('#empty').innerHTML = `<h3>Could not load config.json</h3><p>${esc(err.message)}. Make sure the repo is published to GitHub Pages and config.json exists at the root.</p>`;
    return;
  }
  try {
    state.index = await fetchJson('data/index.json');
    await loadConsolidatedIntoState();
  } catch {
    state.index = null;
  }
  applyScopeHash();
  syncControls();
  renderAll();
  flashUpdated();
  await ensureLoadedForScope();
  startPolling();

  const hid = hashArticleId();
  if (hid && !openArticle(hid)) {
    clearHashArticle();
    showToast('That article is no longer available (past its retention window or filtered out server-side)');
  }
}

document.addEventListener('DOMContentLoaded', boot);
})();