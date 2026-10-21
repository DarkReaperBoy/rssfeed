/* ghrss — entire reader UI. Plain ES2020, no deps, no build step.
   Data: config.json + data/*.json from the repo (GitHub Actions refreshes hourly).
   State: localStorage (read map under ghrss:read, UI prefs under ghrss:ui). */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS_READ = 'ghrss:read', LS_KEPT = 'ghrss:kept', LS_UI = 'ghrss:ui';

const state = {
  config: null,
  index: null,
  feeds: new Map(),          // feedId -> articles[]
  feedErrors: new Map(),     // feedId -> error message
  scope: 'all',
  search: '',
  expandedId: null,
  visible: [],
  read: loadObj(LS_READ),    // {articleId: readTs}
  kept: loadObj(LS_KEPT),    // {articleId: true} — "keep unread"
  filters: [],
  markTimers: new Map(),
  loading: new Set(),
  refreshTimer: null,
  bulkSel: new Set(),
};
const ui = Object.assign({
  theme: 'auto', layout: 'list', status: 'unread', dateRange: 'all',
  showFiltered: false, openFolders: { 'tech': true }, sidebarOpen: false,
  markReadOnOpen: true, markReadAfterSeconds: 0,
  density: 'comfort', sortDir: 'newest',
  updatedOnly: false, dimRead: false, sortAZ: false, scrollTracking: false,
  titlesOnly: false, openOriginal: false, showFavicons: true, columnThumbs: true,
  bulkSelect: false, autoScroll: true, absoluteDates: false, fontSize: '14.5px',
  sideFavicons: true, compactSidebar: false, countersClickable: true, titleCounter: true,
}, loadObj(LS_UI));
// migrate pre-parity values
if (ui.layout === 'compact') { ui.layout = 'list'; ui.density = 'compact'; }

function loadObj(k) { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } }
function saveObj(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function saveRead() { saveObj(LS_READ, state.read); }
function saveKept() { saveObj(LS_KEPT, state.kept); }
function saveUi() { saveObj(LS_UI, ui); }

const isRead = (a) => !!state.read[a.id];
const isKept = (a) => !!state.kept[a.id];

/* ---------------- utils ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripTags = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
const fullTime = (ts) => ts ? new Date(ts).toLocaleString() : '';
const absTime = (ts) => ts
  ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  : '';
let baseTitle = 'My Inoreader';
function updateTitleCounter() {
  let n = 0;
  for (const arts of state.feeds.values()) for (const a of arts) if (!isRead(a) && !a._f?.hidden) n++;
  document.title = n > 0 && ui.titleCounter !== false ? `(${n}) ${baseTitle}` : baseTitle;
}
function faviconHtml(feed) {
  const site = feed?.site || '';
  if (!site) return `<span class="favicon-tile">${esc((feed?.title || '?')[0])}</span>`;
  let host = ''; try { host = new URL(site).hostname; } catch {}
  if (!host) return `<span class="favicon-tile">?</span>`;
  return `<img class="favicon" loading="lazy" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64" alt="" onerror="this.outerHTML='<span class=\\'favicon-tile\\'>${esc((feed?.title || host)[0])}</span>'">`;
}
const feedMeta = (id) => {
  const m = state.index?.feeds?.[id];
  if (!m) return { title: id, site: '', folder: null, folders: [] };
  if (!m.folders) m.folders = m.folder ? [m.folder] : [];
  return m;
};
const feedTitle = (id) => feedMeta(id).title || id;

/* ---------------- config filters (include/exclude, JSON-driven) ---------------- */
function compileMatcher(v) {
  const s = String(v);
  const m = s.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    try { return new RegExp(m[1], m[2] || 'i').test.bind(new RegExp(m[1], m[2] || 'i')); } catch { return () => false; }
  }
  const lc = s.toLowerCase();
  return (hay) => String(hay || '').toLowerCase().includes(lc);
}
function compileBlock(block) {
  const out = {};
  for (const field of ['title', 'content', 'authors', 'links']) {
    const arr = block?.[field];
    if (Array.isArray(arr) && arr.length) out[field] = arr.map(compileMatcher);
  }
  return Object.keys(out).length ? out : null;
}
function blockMatches(block, a, feedId) {
  // AND across fields, OR within a field.
  for (const [field, matchers] of Object.entries(block)) {
    let hay = '';
    if (field === 'title') hay = a.title || '';
    else if (field === 'content') hay = `${stripTags(a.content)} ${stripTags(a.text)} ${a.summary || ''}`;
    else if (field === 'authors') hay = a.author || '';
    else if (field === 'links') hay = `${a.link || ''} ${(a.enclosures || []).map((e) => e.url).join(' ')}`;
    if (!matchers.some((fn) => fn(hay))) return false;
  }
  return true;
}
function compileFilters() {
  state.filters = (state.config.filters || []).filter((f) => f.enabled !== false).map((f) => {
    const scope = Array.isArray(f.feeds) && f.feeds.length ? new Set(f.feeds) : null; // '*' or omitted = all
    return {
      id: f.id || 'filter', name: f.name || f.id || '',
      inScope: (feedId) => !scope || scope.has('*') || scope.has(feedId) || feedMeta(feedId).folders.some((f) => scope.has(f)),
      include: compileBlock(f.include), exclude: compileBlock(f.exclude),
      actions: Object.assign({ hide: true }, f.actions || {}),
    };
  });
}
function filterResult(a, feedId) {
  const res = { hidden: false, markRead: false, keepUnread: false, highlight: false };
  for (const f of state.filters) {
    if (!f.inScope(feedId)) continue;
    let matched = false;
    if (!f.exclude && !f.include) matched = true;              // no blocks: every article in scope matches
    if (f.exclude && blockMatches(f.exclude, a, feedId)) matched = true;
    if (!matched && f.include && !blockMatches(f.include, a, feedId)) matched = true; // whitelist miss
    if (!matched) continue;
    if (f.actions.hide) res.hidden = true;
    if (f.actions.markRead) res.markRead = true;
    if (f.actions.keepUnread) res.keepUnread = true;
    if (f.actions.highlight) res.highlight = true;
  }
  return res;
}
function applyFiltersToFeed(feedId, articles) {
  for (const a of articles) {
    a._f = filterResult(a, feedId);
    a._feed = feedId;
    // Inoreader-style ingest: markRead filters silently read the article once.
    if (a._f.markRead && !a._f.keepUnread && !isRead(a)) { state.read[a.id] = Date.now(); }
  }
  saveRead();
}

/* ---------------- data loading ---------------- */
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
async function loadFeed(feedId) {
  if (state.feeds.has(feedId) || state.loading.has(feedId)) return;
  state.loading.add(feedId);
  try {
    const data = await fetchJson(`data/feeds/${encodeURIComponent(feedId)}.json`);
    applyFiltersToFeed(feedId, data.articles || []);
    state.feeds.set(feedId, data.articles || []);
    state.feedErrors.delete(feedId);
  } catch (err) {
    state.feedErrors.set(feedId, err.message);
  } finally {
    state.loading.delete(feedId);
  }
}
let loadChain = Promise.resolve();
function loadFeedQueued(feedId, onChange) {
  loadChain = loadChain.then(() => loadFeed(feedId)).then(onChange);
  return loadChain;
}
function feedIdsInScope() {
  const feeds = state.index?.feeds || {};
  if (state.scope.startsWith('feed:')) return [state.scope.slice(5)];
  if (state.scope.startsWith('folder:')) return Object.keys(feeds).filter((id) => feeds[id].folder === state.scope.slice(7));
  return Object.keys(feeds);
}
async function loadAllFeeds(onChange) {
  for (const id of Object.keys(state.index?.feeds || {})) await loadFeedQueued(id, onChange);
}

/* ---------------- search ---------------- */
function parseQuery(q) {
  const ops = { feed: [], title: [], before: null, after: null, unread: null };
  const rest = [];
  const re = /(\w+):("([^"]*)"|\S+)|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[1]) {
      const key = m[1].toLowerCase(), val = (m[3] ?? m[2] ?? '').toLowerCase();
      if (key === 'feed') ops.feed.push(val);
      else if (key === 'title') ops.title.push(val);
      else if (key === 'before' || key === 'until') { const t = Date.parse(val); if (!isNaN(t)) ops.before = t; }
      else if (key === 'after' || key === 'since') { const t = Date.parse(val); if (!isNaN(t)) ops.after = t; }
      else if (key === 'unread') ops.unread = val !== 'false';
      else if (key === 'is' && val === 'read') ops.unread = false;
      else rest.push(val);
    } else rest.push((m[4] ?? m[5] ?? '').toLowerCase());
  }
  return { ops, terms: rest.filter(Boolean) };
}
function searchMatches(a, q) {
  // OR-groups: "a b OR c" → (a AND b) OR (c). Operators apply inside a group.
  return String(q).split(/\s+or\s+/i).some((group) => searchGroupMatches(a, group));
}
function searchGroupMatches(a, q) {
  const { ops, terms } = parseQuery(q);
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

/* ---------------- list pipeline ---------------- */
function scopeFilter(a) {
  if (state.scope === 'today') return a.date >= startOfToday();
  if (state.scope === 'recently-read') return isRead(a);
  return true;
}
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
function dateRangeFilter(a) {
  const now = Date.now();
  switch (ui.dateRange) {
    case 'today': return a.date >= startOfToday();
    case '3d': return a.date >= now - 3 * 864e5;
    case 'week': return a.date >= now - 7 * 864e5;
    case 'month': return a.date >= now - 30 * 864e5;
    default: return true;
  }
}
function folderCutoff(feedId) {
  // Inoreader Pro's "unread duration" per folder: when viewing that folder,
  // only show articles newer than maxAgeDays.
  if (!state.scope.startsWith('folder:')) return 0;
  const f = (state.config?.folders || []).find((x) => x.id === state.scope.slice(7));
  const days = Number(f?.maxAgeDays) || 0;
  return days > 0 ? days * 864e5 : 0;
}
function computeVisible() {
  const out = [];
  for (const feedId of feedIdsInScope()) {
    const cutoff = folderCutoff(feedId);
    for (const a of state.feeds.get(feedId) || []) {
      if (cutoff && Date.now() - a.date > cutoff) continue;
      if (!scopeFilter(a)) continue;
      if (!dateRangeFilter(a)) continue;
      if (a._f.hidden && !ui.showFiltered) continue;
      const read = isRead(a);
      if (state.scope !== 'recently-read') {
        if (ui.status === 'unread' && read) continue;
        if (ui.status === 'read' && !read) continue;
      }
      if (state.search && !searchMatches(a, state.search)) continue;
      out.push(a);
    }
  }
  out.sort((x, y) => {
    const dir = ui.sortDir === 'oldest' ? 1 : -1;
    return state.scope === 'recently-read'
      ? dir * ((state.read[x.id] || 0) - (state.read[y.id] || 0))
      : dir * (x.date - y.date);
  });
  // The currently open article stays visible even once it stops matching
  // (e.g. marked read under the "Unread" filter) until it is collapsed.
  if (state.expandedId && !out.some((a) => a.id === state.expandedId)) {
    const open = findArticle(state.expandedId);
    if (open && !open._f?.hidden && scopeFilter(open) && dateRangeFilter(open)) out.push(open);
    else if (!open) state.expandedId = null;
  }
  state.visible = out;
  return out;
}

/* ---------------- rendering: sidebar ---------------- */
function unreadCount(feedId) {
  let n = 0;
  for (const a of state.feeds.get(feedId) || []) if (!isRead(a) && !a._f.hidden) n++;
  return n;
}
function renderTree() {
  const tree = $('#tree');
  const feeds = state.index?.feeds || {};
  const folders = [...(state.config?.folders || [])];
  if (ui.sortAZ) folders.sort((a, b) => a.name.localeCompare(b.name));
  const inFolder = new Set();
  let html = '';
  const sysItem = (scope, icon, label, count) => `
    <button class="tree-item ${state.scope === scope ? 'active' : ''} ${count ? 'unread' : ''}" data-scope="${scope}">
      <svg><use href="#i-${icon}"/></svg><span class="label">${esc(label)}</span>${count ? `<span class="badge">${count}</span>` : ''}
    </button>`;
  const totalUnread = Object.keys(feeds).reduce((n, id) => n + unreadCount(id), 0);
  html += sysItem('all', 'all', 'Newsfeed', 0);
  html += sysItem('unread', 'unread', 'Unread', totalUnread);
  html += sysItem('today', 'today', 'Today', 0);
  html += sysItem('recently-read', 'read', 'Recently read', 0);
  html += '<div style="height:10px"></div>';

  const feedItem = (id) => {
    inFolder.add(id);
    const meta = feedMeta(id), n = unreadCount(id);
    if (ui.updatedOnly && n === 0) return '';
    const dim = ui.dimRead && n === 0 ? 'dimmed' : '';
    return `<button class="tree-item ${state.scope === 'feed:' + id ? 'active' : ''} ${n ? 'unread' : ''} ${dim}" data-scope="feed:${esc(id)}" title="${esc(meta.title)}">
      ${faviconHtml({ title: meta.title, site: meta.site })}<span class="label">${esc(meta.title)}</span>${n ? `<span class="badge" data-markread="feed:${esc(id)}" title="Mark as read">${n}</span>` : ''}
    </button>`;
  };
  for (const folder of folders) {
    let kids = Object.keys(feeds).filter((id) => feedMeta(id).folders.includes(folder.id));
    if (ui.sortAZ) kids.sort((a, b) => feedTitle(a).localeCompare(feedTitle(b)));
    if (ui.updatedOnly) kids = kids.filter((id) => unreadCount(id) > 0);
    if (!kids.length) continue;
    const n = kids.reduce((s, id) => s + unreadCount(id), 0);
    if (ui.updatedOnly && n === 0) continue;
    const open = ui.openFolders[folder.id] !== false;
    const dim = ui.dimRead && n === 0 ? 'dimmed' : '';
    html += `<div class="tree-folder ${open ? 'open' : ''}">
      <button class="tree-item ${state.scope === 'folder:' + folder.id ? 'active' : ''} ${n ? 'unread' : ''} ${dim}" data-folder="${esc(folder.id)}" data-scope="folder:${esc(folder.id)}">
        <svg class="chev"><use href="#i-chevron"/></svg><span class="label">${esc(folder.name)}</span>${n ? `<span class="badge" data-markread="folder:${esc(folder.id)}" title="Mark as read">${n}</span>` : ''}
      </button>
      <div class="tree-children">${kids.map(feedItem).join('')}</div>
    </div>`;
  }
  const loose = Object.keys(feeds).filter((id) => !inFolder.has(id));
  if (ui.sortAZ) loose.sort((a, b) => feedTitle(a).localeCompare(feedTitle(b)));
  if (ui.updatedOnly) { for (const id of [...loose]) if (unreadCount(id) === 0) loose.splice(loose.indexOf(id), 1); }
  if (loose.length) html += loose.map(feedItem).join('');
  tree.innerHTML = html;

  const total = $('#rail-unread-count');
  total.textContent = totalUnread > 999 ? '999+' : totalUnread ? String(totalUnread) : '';
  $$('#rail .rail-btn[data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === state.scope));
}

function scopeTitle() {
  const s = state.scope;
  if (s === 'all') return 'Newsfeed';
  if (s === 'unread') return 'Unread';
  if (s === 'today') return 'Today';
  if (s === 'recently-read') return 'Recently read';
  if (s.startsWith('feed:')) return feedTitle(s.slice(5));
  if (s.startsWith('folder:')) {
    const f = (state.config?.folders || []).find((x) => x.id === s.slice(7));
    return f?.name || 'Folder';
  }
  return 'Articles';
}

/* ---------------- rendering: list ---------------- */
function thumbFor(a) {
  const enc = (a.enclosures || []).find((e) => /^image\//.test(e.type || '') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(e.url));
  if (enc) return enc.url;
  const m = String(a.content || '').match(/<img[^>]+src=["']([^"']+)/i);
  return m ? m[1] : null;
}
function rowHtml(a) {
  const feed = feedMeta(a._feed);
  const read = isRead(a);
  const f = a._f || {};
  const thumbLayout = ['cards', 'column', 'magazine'].includes(state.layout);
  const thumb = thumbLayout && (state.layout !== 'column' || ui.columnThumbs) ? thumbFor(a) : null;
  const showDot = !thumbLayout && state.layout !== 'magazine';
  const isExpanded = state.expandedId === a.id && ui.layout !== 'expanded';
  const timeHtml = ui.absoluteDates ? absTime(a.date) : relTime(a.date);
  return `<article class="row ${read ? '' : 'unread'} ${f.highlight ? 'highlight' : ''} ${isExpanded ? 'expanded' : ''}" data-id="${esc(a.id)}">
    ${showDot ? '<span class="dot"></span>' : ''}
    ${ui.bulkSelect ? `<input type="checkbox" class="row-check" ${state.bulkSel.has(a.id) ? 'checked' : ''} title="Select">` : ''}
    ${thumb ? `<img class="row-thumb" loading="lazy" src="${esc(thumb)}" alt="" onerror="this.remove()">` : ''}
    <div class="row-main">
      <div class="row-meta">
        ${faviconHtml(feed)}<span class="feed-name">${esc(feed.title)}</span>
        ${a.author ? `<span class="author">— ${esc(a.author)}</span>` : ''}
        ${f.hidden ? '<span class="author" title="Filtered">[filtered]</span>' : ''}
        <span class="time" title="${esc(fullTime(a.date))}">${esc(timeHtml)}</span>
      </div>
      <div class="row-title">${esc(a.title)}</div>
      ${state.layout !== 'compact' && !ui.titlesOnly ? `<div class="row-snippet">${esc(a.summary || stripTags(a.content).slice(0, 220))}</div>` : ''}
    </div>
    <div class="row-actions">
      <button class="icon-btn" data-act="hide-read" title="Mark as read and hide"><svg><use href="#i-close"/></svg></button>
      <button class="icon-btn" data-act="toggle-read" title="${read ? 'Mark unread' : 'Mark read'}"><svg><use href="#i-${read ? 'unread' : 'read'}"/></svg></button>
      <button class="icon-btn" data-act="keep" title="${isKept(a) ? 'Allow auto mark-read' : 'Keep unread'}"><svg><use href="#i-${isKept(a) ? 'eye' : 'eyeoff'}"/></svg></button>
      <a class="icon-btn" href="${esc(a.link || '#')}" target="_blank" rel="noopener noreferrer" title="Open original" data-act="open-original" onclick="event.stopPropagation()"><svg><use href="#i-external"/></svg></a>
    </div>
  </article>`;
}
function articleBody(a) {
  const hasText = !!a.text;
  return a._viewText && hasText ? a.text : (a.content || a.text || `<p>${esc(a.summary || '')}</p>`);
}
function readerHtml(a) {
  const feed = feedMeta(a._feed);
  const hasText = !!a.text;
  const body = articleBody(a);
  const idx = state.visible.indexOf(a);
  return `<div class="reader" data-id="${esc(a.id)}">
    <div class="reader-head">
      ${faviconHtml(feed)}<strong>${esc(feed.title)}</strong>
      <div class="reader-nav">
        <button class="icon-btn" data-act="prev" title="Previous" ${idx <= 0 ? 'disabled' : ''}><svg><use href="#i-prev"/></svg></button>
        <button class="icon-btn" data-act="next" title="Next" ${idx >= state.visible.length - 1 ? 'disabled' : ''}><svg><use href="#i-next"/></svg></button>
        <a class="icon-btn" href="${esc(a.link || '#')}" target="_blank" rel="noopener noreferrer" title="Open original"><svg><use href="#i-external"/></svg></a>
        <button class="icon-btn" data-act="collapse" title="Close"><svg><use href="#i-close"/></svg></button>
      </div>
    </div>
    <h2 class="reader-title">${esc(a.title)}</h2>
    <div class="reader-sub">
      ${a.author ? `<span>${esc(a.author)}</span>` : ''}
      <span title="${esc(fullTime(a.date))}">${esc(new Date(a.date).toLocaleString())}</span>
      ${hasText ? `<button class="chip ${a._viewText ? 'active' : ''}" data-act="toggle-view">${a._viewText ? 'Text view' : 'Original view'}</button>` : ''}
      <a href="${esc(a.link || '#')}" target="_blank" rel="noopener noreferrer">${esc(shortHost(a.link))}</a>
    </div>
    <div class="reader-body">${body}</div>
    <div class="reader-actions">
      <button class="tool-btn" data-act="toggle-read"><svg><use href="#i-${isRead(a) ? 'unread' : 'read'}"/></svg>${isRead(a) ? 'Mark unread' : 'Mark read'}</button>
      <button class="tool-btn" data-act="keep"><svg><use href="#i-${isKept(a) ? 'eye' : 'eyeoff'}"/></svg>${isKept(a) ? 'Allow auto mark-read' : 'Keep unread'}</button>
    </div>
    ${attachmentsHtml(a)}
  </div>`;
}
function attachmentsHtml(a) {
  const enc = (a.enclosures || []).filter((e) => e.url && !/^image\/(?!.*thumbnail)/.test(e.type || ''));
  const imgs = (a.enclosures || []).filter((e) => /^image\//.test(e.type || ''));
  if (!enc.length && !imgs.length) return '';
  const label = (e) => {
    const kind = (e.type || '').split('/')[0];
    const name = decodeURIComponent(e.url.split('/').pop().split('?')[0] || '').slice(0, 90);
    return kind && kind !== 'image' ? `${kind.toUpperCase()} · ${name}` : name;
  };
  return `<div class="reader-attachments">
    ${enc.map((e) => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer"><svg style="width:16px;height:16px"><use href="#i-external"/></svg>${esc(label(e))}</a>`).join('')}
    ${imgs.map((e) => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(e.url)}" alt="">${esc(label(e))}</a>`).join('')}
  </div>`;
}
function shortHost(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'original'; } }

function renderList() {
  const list = $('#list');
  const visible = computeVisible();
  list.className = `view-${ui.layout}${ui.layout === 'list' ? ` density-${ui.density}` : ''}${ui.showFavicons ? '' : ' no-favicons'}`;
  document.body.classList.toggle('bulk-mode', !!ui.bulkSelect);
  updateBulkBar();
  if (state.expandedId && !visible.some((a) => a.id === state.expandedId)) state.expandedId = null;
  list.innerHTML = visible.map((a) => {
    let row = rowHtml(a);
    if (state.expandedId === a.id) row = row.replace('</article>', `${readerHtml(a)}</article>`);
    else if (ui.layout === 'expanded') row = row.replace('</article>', `<div class="row-body-inline">${articleBody(a)}</div></article>`);
    return row;
  }).join('');
  list.querySelectorAll('.reader-body, .row-body-inline').forEach((el) => { sanitizeReaderDom(el); upgradeEmbeds(el); });
  setupScrollTracking();
  const unread = visible.filter((a) => !isRead(a)).length;
  $('#scope-title').textContent = scopeTitle();
  $('#scope-count').textContent = `${unread} unread`; // their header: "Newsfeed" + "81 unread"
  updateTitleCounter();
  renderEmpty(visible);
}
function renderEmpty(visible) {
  const el = $('#empty');
  if (visible.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  if (!state.index) {
    el.innerHTML = `<h3>No data yet</h3><p>The hourly GitHub Action builds <code>data/</code>. Trigger it once: <strong>Actions → Fetch feeds → Run workflow</strong>, or wait for the next hour.</p>`;
  } else if (state.search) {
    el.innerHTML = `<h3>No matches</h3><p>Nothing matched <code>${esc(state.search)}</code> in this view.<br>Operators: <code>feed:name</code> <code>title:word</code> <code>before:2026-01-01</code> <code>after:2026-01-01</code> <code>unread:true</code> <code>is:read</code></p>`;
  } else if (ui.status === 'unread') {
    el.innerHTML = `<h3>All caught up 🎉</h3><p>No unread articles here${ui.dateRange !== 'all' ? ' for this time range' : ''}.</p>`;
  } else {
    el.innerHTML = `<h3>Nothing here</h3><p>No articles in this view. New items arrive when the hourly fetch runs.</p>`;
  }
}

/* ---------------- embeds (YouTube/Vimeo/SoundCloud/audio/video) ---------------- */
function upgradeEmbeds(root) {
  if (!root) return;
  const yt = (url) => {
    const m = url.match(/(?:youtube\.com\/(?:watch\?.*?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  };
  const vimeo = (url) => { const m = url.match(/vimeo\.com\/(\d+)/); return m ? m[1] : null; };
  const audioRe = /\.(mp3|m4a|oga|ogg|wav|aac)(\?|$)/i;
  const videoRe = /\.(mp4|webm|ogv|mov)(\?|$)/i;

  for (const a of $$('a[href]', root)) {
    const url = a.href;
    if (/^https?:/.test(url) === false) continue;
    const wrap = document.createElement('div');
    wrap.className = 'embed';
    const id = yt(url);
    if (id) {
      wrap.innerHTML = `<button class="embed-facade" title="Play video"><img loading="lazy" src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="Play video"></button>`;
      wrap.querySelector('button').addEventListener('click', () => {
        wrap.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1" title="YouTube video" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
      }, { once: true });
      a.replaceWith(wrap); continue;
    }
    const vid = vimeo(url);
    if (vid) {
      wrap.innerHTML = `<button class="embed-facade" title="Play video"></button>`;
      wrap.querySelector('button').addEventListener('click', () => {
        wrap.innerHTML = `<iframe src="https://player.vimeo.com/video/${vid}" title="Vimeo video" allowfullscreen loading="lazy"></iframe>`;
      }, { once: true });
      a.replaceWith(wrap); continue;
    }
    if (/soundcloud\.com\//.test(url)) {
      wrap.innerHTML = `<button class="embed-facade" title="Play audio" style="aspect-ratio:auto;height:120px;display:flex;align-items:center;justify-content:center;color:#fff">▶ SoundCloud</button>`;
      wrap.querySelector('button').addEventListener('click', () => {
        wrap.innerHTML = `<iframe src="https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&visual=false" title="SoundCloud player" allow="encrypted-media" loading="lazy" style="height:166px"></iframe>`;
      }, { once: true });
      a.replaceWith(wrap); continue;
    }
    if (audioRe.test(url)) { const el = document.createElement('audio'); el.controls = true; el.preload = 'none'; el.src = url; wrap.appendChild(el); a.replaceWith(wrap); continue; }
    if (videoRe.test(url)) { const el = document.createElement('video'); el.controls = true; el.preload = 'none'; el.src = url; wrap.appendChild(el); a.replaceWith(wrap); continue; }
  }
}

/* ---------------- client-side sanitization (defense in depth) ---------------- */
function sanitizeReaderDom(root) {
  if (!root) return;
  root.querySelectorAll('script, style, link, meta, form, input, button[data-blocked], object, embed').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || (name === 'href' && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'IFRAME') {
      const src = el.getAttribute('src') || '';
      if (!/^https:\/\/(www\.)?(youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/|w\.soundcloud\.com\/)/.test(src)) el.remove();
    }
  });
}

/* ---------------- read state actions ---------------- */
function markRead(id, on = true) {
  const a = findArticle(id);
  if (!on) delete state.read[id];
  else if (a && a._f?.keepUnread && !forceAllowed) return;
  else state.read[id] = Date.now();
  saveRead(); renderTree(); renderList();
}
let forceAllowed = false; // explicit user clicks override keepUnread
function findArticle(id) {
  for (const arts of state.feeds.values()) { const a = arts.find((x) => x.id === id); if (a) return a; }
  return null;
}
function scheduleMarkRead(a) {
  clearTimeout(state.markTimers.get(a.id));
  state.markTimers.delete(a.id);
  const delay = (Number(ui.markReadOnOpen ? ui.markReadAfterSeconds : 0) || 0) * 1000;
  const run = () => {
    state.markTimers.delete(a.id);
    if (!isRead(a) && !isKept(a) && !a._f?.keepUnread) { state.read[a.id] = Date.now(); saveRead(); renderTree(); renderList(); }
  };
  if (delay <= 0) run();
  else state.markTimers.set(a.id, setTimeout(run, delay));
}
function collectScopeIds(scope) {
  let feedIds;
  if (scope.startsWith('feed:')) feedIds = [scope.slice(5)];
  else if (scope.startsWith('folder:')) {
    const fid = scope.slice(7);
    feedIds = Object.keys(state.index?.feeds || {}).filter((id) => feedMeta(id).folders.includes(fid));
  } else feedIds = feedIdsInScope();
  const ids = [];
  for (const feedId of feedIds) {
    for (const a of state.feeds.get(feedId) || []) {
      if (a._f?.hidden || isKept(a) || a._f?.keepUnread || isRead(a)) continue;
      if (scope === 'today' && a.date < startOfToday()) continue;
      ids.push(a.id);
    }
  }
  return ids;
}
function markScopeRead(scope) {
  const ids = collectScopeIds(scope);
  if (!ids.length) { showToast('Nothing to mark — everything here is read'); return; }
  const snapshot = ids.map((id) => ({ id, ts: state.read[id] }));
  for (const id of ids) state.read[id] = Date.now();
  saveRead(); state.expandedId = null; renderTree(); renderList();
  showToast(`Marked ${ids.length} article${ids.length === 1 ? '' : 's'} as read`, 'Undo', () => {
    for (const { id, ts } of snapshot) { if (ts) state.read[id] = ts; else delete state.read[id]; }
    saveRead(); renderTree(); renderList();
  });
}
function markAllAsReadInScope() {
  confirmDialog('Mark all as read', `Mark all articles in "${scopeTitle()}" as read? Articles kept unread or hidden by filters are skipped.`, () => {
    markScopeRead(state.scope);
  });
}

function updateBulkBar() {
  const bar = $('#bulk-bar');
  if (!ui.bulkSelect || !state.bulkSel.size) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#bulk-count').textContent = String(state.bulkSel.size);
}
function bulkMark(on) {
  if (!state.bulkSel.size) return;
  const ids = [...state.bulkSel];
  const snapshot = ids.map((id) => ({ id, ts: state.read[id] }));
  let n = 0;
  for (const id of ids) {
    if (on) state.read[id] = Date.now(); else delete state.read[id];
    n++;
  }
  state.bulkSel.clear();
  saveRead(); renderTree(); renderList();
  showToast(`${on ? 'Marked' : 'Unmarked'} ${n} article${n === 1 ? '' : 's'}${on ? ' as read' : ' as unread'}`, 'Undo', () => {
    for (const { id, ts } of snapshot) { if (ts) state.read[id] = ts; else delete state.read[id]; }
    saveRead(); renderTree(); renderList();
  });
}

let toastTimer = null;
function showToast(text, actionLabel, cb) {
  const el = $('#toast');
  $('#toast-text').textContent = text;
  const btn = $('#toast-action');
  btn.textContent = actionLabel || '';
  btn.style.display = actionLabel ? '' : 'none';
  btn.onclick = () => { if (cb) cb(); hideToast(); };
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 7000);
}
function hideToast() { $('#toast').classList.add('hidden'); }

/* ---------------- interactions ---------------- */
function onListClick(e) {
  const rowEl = e.target.closest('.row');
  if (!rowEl) return;
  const id = rowEl.dataset.id;
  const a = findArticle(id);
  if (!a) return;

  if (e.target.classList?.contains('row-check')) {
    e.stopPropagation();
    if (state.bulkSel.has(id)) state.bulkSel.delete(id); else state.bulkSel.add(id);
    updateBulkBar();
    return;
  }
  const actBtn = e.target.closest('[data-act]');

  if (actBtn) {
    const act = actBtn.dataset.act;
    e.stopPropagation();
    if (act === 'toggle-read') { forceAllowed = true; markRead(id, !isRead(a)); forceAllowed = false; }
    else if (act === 'hide-read') {
      forceAllowed = true; markRead(id, true); forceAllowed = false;
      if (state.expandedId === id) state.expandedId = null;
      renderList();
    }
    else if (act === 'keep') { if (state.kept[id]) delete state.kept[id]; else state.kept[id] = true; saveKept(); renderList(); }
    else if (act === 'open-original') { /* anchor handles it */ }
    else if (act === 'collapse') { state.expandedId = null; renderList(); }
    else if (act === 'toggle-view') { a._viewText = !a._viewText; renderList(); }
    else if (act === 'prev' || act === 'next') {
      const i = state.visible.indexOf(a);
      const target = state.visible[act === 'prev' ? i - 1 : i + 1];
      if (target) { state.expandedId = target.id; renderList(); scheduleMarkRead(target); listScrollTo(target.id); }
    }
    return;
  }
  if (rowEl.classList.contains('expanded')) return; // clicking inside reader body does nothing
  if (ui.layout === 'expanded') { // expanded view: content always visible; click just marks read
    if (!isRead(a) && !isKept(a) && !a._f?.keepUnread) scheduleMarkRead(a);
    return;
  }
  if (ui.openOriginal && a.link) { // "Open original webpages directly"
    window.open(a.link, '_blank', 'noopener');
    scheduleMarkRead(a);
    return;
  }
  if (state.expandedId === id) { state.expandedId = null; renderList(); return; }
  state.expandedId = id;
  renderList();
  listScrollTo(id);
  if (ui.autoScroll) $('.reader')?.scrollIntoView?.({ block: 'start' });
  scheduleMarkRead(a);
}
function listScrollTo(id) {
  const safe = (window.CSS && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
  const el = $(`.row[data-id="${safe}"]`);
  if (el) el.scrollIntoView?.({ block: 'nearest' });
}

function renderAll() { renderTree(); renderList(); }

function bindEvents() {
  $('#list').addEventListener('click', onListClick);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#sidebar-menu') && !e.target.closest('#btn-sidebar-menu')) $('#sidebar-menu')?.classList.add('hidden');
    const markBtn = e.target.closest('[data-markread]');
    if (markBtn) {
      e.stopPropagation();
      if (ui.countersClickable) markScopeRead(markBtn.dataset.markread);
      return;
    }
    const scopeBtn = e.target.closest('[data-scope]');
    if (scopeBtn) {
      state.scope = scopeBtn.dataset.scope;
      state.expandedId = null;
      document.body.classList.remove('sidebar-open');
      if (scopeBtn.dataset.folder) { // folder click also toggles expansion
        ui.openFolders[scopeBtn.dataset.folder] = !scopeBtn.parentElement.classList.contains('open');
        saveUi();
      }
      renderAll();
      ensureScopeLoaded();
      return;
    }
  });

  $('#status-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    ui.status = chip.dataset.status; saveUi(); syncControls(); renderList();
  });
  $('#date-range').addEventListener('change', (e) => { ui.dateRange = e.target.value; saveUi(); renderList(); });
  $('#layouts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-layout]');
    if (!btn) return;
    ui.layout = btn.dataset.layout; saveUi(); syncControls(); renderList();
  });
  $('#btn-show-filtered').addEventListener('click', () => {
    ui.showFiltered = !ui.showFiltered; saveUi(); syncControls(); renderList();
  });

  let searchTimer = null;
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.search = e.target.value.trim();
      renderList();
      if (state.search) {
        // search everything: load remaining feeds, then re-render
        const missing = Object.keys(state.index?.feeds || {}).filter((id) => !state.feeds.has(id));
        if (missing.length) { await loadAllFeeds(() => renderList()); renderTree(); }
        renderList();
      }
    }, 200);
  });

  $('#btn-mark-all').addEventListener('click', markAllAsReadInScope);
  $('#btn-mark-all-split')?.addEventListener('click', markAllAsReadInScope);
  $('#btn-sort').addEventListener('click', () => {
    ui.sortDir = ui.sortDir === 'oldest' ? 'newest' : 'oldest';
    saveUi(); syncControls(); renderList();
  });
  $('#btn-sidebar-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#sidebar-menu').classList.toggle('hidden');
    syncSidebarMenu();
  });
  $('#sidebar-menu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-opt]');
    if (!item) return;
    ui[item.dataset.opt] = !ui[item.dataset.opt];
    saveUi(); syncSidebarMenu(); renderTree();
  });
  $('#btn-refresh').addEventListener('click', () => refresh(true));
  $('#menu-toggle').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
    $('#scrim').classList.toggle('hidden', !document.body.classList.contains('sidebar-open'));
  });
  $('#scrim').addEventListener('click', () => { document.body.classList.remove('sidebar-open'); $('#scrim').classList.add('hidden'); });

  $('#btn-theme').addEventListener('click', () => {
    ui.theme = ui.theme === 'dark' ? 'light' : ui.theme === 'light' ? 'auto' : 'dark';
    saveUi(); applyTheme(); syncControls();
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('.modal-close').addEventListener('click', closeModals);
  $('#settings-modal').addEventListener('click', (e) => { if (e.target.id === 'settings-modal') closeModals(); });

  $('#set-theme').addEventListener('change', (e) => { ui.theme = e.target.value; saveUi(); applyTheme(); });
  $('#set-layout').addEventListener('change', (e) => { ui.layout = e.target.value; saveUi(); syncControls(); renderList(); });
  $('#set-markread').addEventListener('change', (e) => { ui.markReadOnOpen = e.target.checked; saveUi(); });
  $('#set-markread-delay').addEventListener('change', (e) => { ui.markReadAfterSeconds = Math.max(0, Number(e.target.value) || 0); saveUi(); });
  $('#set-density').addEventListener('change', (e) => { ui.density = e.target.value; saveUi(); renderList(); });
  $('#set-scroll-tracking').addEventListener('change', (e) => { ui.scrollTracking = e.target.checked; saveUi(); setupScrollTracking(); });
  const bindBool = (sel, key, after) => $(sel).addEventListener('change', (e) => {
    ui[key] = e.target.checked; saveUi(); syncControls(); (after || renderList)();
  });
  bindBool('#set-titles-only', 'titlesOnly');
  bindBool('#set-open-original', 'openOriginal');
  bindBool('#set-show-favicons', 'showFavicons');
  bindBool('#set-column-thumbs', 'columnThumbs');
  bindBool('#set-auto-scroll', 'autoScroll');
  bindBool('#set-absolute-dates', 'absoluteDates');
  bindBool('#set-side-favicons', 'sideFavicons', applySidebarMode);
  bindBool('#set-compact-sidebar', 'compactSidebar', applySidebarMode);
  bindBool('#set-counters-clickable', 'countersClickable');
  $('#set-bulk-select').addEventListener('change', (e) => {
    ui.bulkSelect = e.target.checked; saveUi(); state.bulkSel.clear(); syncControls(); renderList();
  });
  $('#set-font-size').addEventListener('change', (e) => { ui.fontSize = e.target.value; saveUi(); syncControls(); });

  $('#bulk-read').addEventListener('click', () => bulkMark(true));
  $('#bulk-unread').addEventListener('click', () => bulkMark(false));
  $('#bulk-clear').addEventListener('click', () => { state.bulkSel.clear(); renderList(); });
  $('#btn-clear-read').addEventListener('click', () => {
    confirmDialog('Clear read state', 'Reset every article back to unread in this browser?', () => {
      state.read = {}; saveRead(); renderAll();
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModals(); if (state.expandedId) { state.expandedId = null; renderList(); } }
  });
}

function applyTheme() { document.documentElement.dataset.theme = ui.theme; }
function applySidebarMode() {
  document.body.classList.toggle('compact-sidebar', !!ui.compactSidebar);
  document.body.classList.toggle('hide-side-favicons', !ui.sideFavicons);
}
function syncSidebarMenu() {
  $$('#sidebar-menu [data-opt]').forEach((el) => el.classList.toggle('on', !!ui[el.dataset.opt]));
}
function syncControls() {
  $$('#status-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.status === ui.status));
  $$('#layouts [data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === ui.layout));
  $('#date-range').value = ui.dateRange;
  $('#btn-show-filtered').classList.toggle('active', ui.showFiltered);
  $('#btn-show-filtered svg use').setAttribute('href', ui.showFiltered ? '#i-eye' : '#i-eyeoff');
  $('#btn-sort').classList.toggle('active', ui.sortDir === 'oldest');
  $('#btn-sort').title = ui.sortDir === 'oldest' ? 'Sort: oldest first' : 'Sort: newest first';
  $('#set-theme').value = ui.theme;
  $('#set-layout').value = ui.layout;
  $('#set-density').value = ui.density || 'comfort';
  $('#set-markread').checked = !!ui.markReadOnOpen;
  $('#set-markread-delay').value = ui.markReadAfterSeconds || 0;
  $('#set-scroll-tracking').checked = !!ui.scrollTracking;
  const bools = {
    '#set-titles-only': 'titlesOnly', '#set-open-original': 'openOriginal',
    '#set-show-favicons': 'showFavicons', '#set-column-thumbs': 'columnThumbs',
    '#set-bulk-select': 'bulkSelect', '#set-auto-scroll': 'autoScroll',
    '#set-absolute-dates': 'absoluteDates', '#set-side-favicons': 'sideFavicons',
    '#set-compact-sidebar': 'compactSidebar', '#set-counters-clickable': 'countersClickable',
    '#set-title-counter': 'titleCounter',
  };
  for (const [sel, key] of Object.entries(bools)) { const el = $(sel); if (el) el.checked = !!ui[key]; }
  $('#set-font-size').value = ui.fontSize || '14.5px';
  document.documentElement.style.setProperty('--title-size', ui.fontSize || '14.5px');
  applySidebarMode();
  syncSidebarMenu();
}

/* Inoreader "scroll tracking": mark items read when scrolled past (opt-in) */
let scrollObserver = null;
function setupScrollTracking() {
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
  if (!ui.scrollTracking || typeof IntersectionObserver === 'undefined') return;
  let dirty = false;
  scrollObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting || en.boundingClientRect.top >= 0) continue;
      const a = findArticle(en.target.dataset.id);
      if (!a || isRead(a) || isKept(a) || a._f?.keepUnread || a._f?.hidden) continue;
      state.read[a.id] = Date.now(); dirty = true;
    }
    if (dirty) { saveRead(); renderTree(); renderList(); }
  }, { threshold: 0 });
  $$('#list .row').forEach((r) => scrollObserver.observe(r));
}

/* ---------------- settings / stats ---------------- */
function openSettings() {
  syncControls();
  const feeds = state.index?.feeds || {};
  let rows = '';
  for (const [id, meta] of Object.entries(feeds)) {
    const arts = state.feeds.get(id) || [];
    const unread = arts.filter((a) => !isRead(a) && !a._f?.hidden).length;
    rows += `<tr><td>${esc(meta.title)}</td><td>${meta.count ?? arts.length}</td><td>${unread}</td><td>${esc(relTime(meta.newest))}</td></tr>`;
  }
  $('#stats-table').innerHTML = rows
    ? `<table><thead><tr><th>Feed</th><th>Kept</th><th>Unread</th><th>Newest</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="hint">No data loaded yet.</p>';
  $('#settings-modal').classList.remove('hidden');
}
function closeModals() { $$('.modal').forEach((m) => m.classList.add('hidden')); }
function confirmDialog(title, text, onYes) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-modal').classList.remove('hidden');
  const yes = $('#confirm-yes'), no = $('#confirm-no');
  const done = () => { yes.onclick = null; no.onclick = null; $('#confirm-modal').classList.add('hidden'); };
  yes.onclick = () => { done(); onYes(); };
  no.onclick = done;
}

/* ---------------- refresh / polling ---------------- */
async function refresh(manual = false) {
  try {
    const index = await fetchJson('data/index.json');
    const changed = index.generatedAt !== state.index?.generatedAt;
    state.index = index;
    // reload loaded feeds (new articles), keep the rest lazy
    const loaded = [...state.feeds.keys()];
    for (const id of loaded) { state.feeds.delete(id); await loadFeed(id); }
    if (changed || manual) { renderAll(); flashUpdated(); }
  } catch (err) {
    if (manual) flashUpdated('offline — showing last data');
  }
}
function flashUpdated(msg) {
  const el = $('#last-updated');
  el.textContent = msg || `Updated ${relTime(state.index?.generatedAt || Date.now())} ago`;
  el.title = fullTime(state.index?.generatedAt);
}
function startPolling() {
  clearInterval(state.refreshTimer);
  const mins = Math.max(5, Number(state.config?.settings?.refreshMinutes) || 60);
  state.refreshTimer = setInterval(() => refresh(false), mins * 60000);
}
async function ensureScopeLoaded() {
  const ids = feedIdsInScope().filter((id) => !state.feeds.has(id));
  if (!ids.length) return;
  for (const id of ids) await loadFeedQueued(id, () => { renderTree(); renderList(); });
  renderAll();
}

/* ---------------- boot ---------------- */
async function boot() {
  applyTheme();
  bindEvents();
  try {
    state.config = await fetchJson('config.json');
    const s = state.config.settings || {};
    if (!localStorage.getItem(LS_UI)) { // seed defaults from config on first run
      if (s.theme) ui.theme = s.theme;
      if (s.view) ui.layout = s.view;
      ui.markReadOnOpen = s.markReadOnOpen !== false;
      ui.markReadAfterSeconds = Number(s.markReadAfterSeconds) || 0;
      saveUi();
    }
    baseTitle = state.config.settings?.siteName || 'My Inoreader';
    document.title = baseTitle;
    compileFilters();
  } catch (err) {
    $('#empty').classList.remove('hidden');
    $('#empty').innerHTML = `<h3>Could not load config.json</h3><p>${esc(err.message)}. Make sure the repo is published to GitHub Pages and config.json exists at the root.</p>`;
    return;
  }
  try {
    state.index = await fetchJson('data/index.json');
  } catch {
    state.index = null;
  }
  syncControls();
  renderAll();
  flashUpdated();
  ensureScopeLoaded();
  startPolling();
}

document.addEventListener('DOMContentLoaded', boot);
})();
