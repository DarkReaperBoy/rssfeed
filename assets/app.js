/* ghrss — entire reader UI. Plain ES2020, no deps, no build step.
   Data: config.json + data/*.json from the repo (GitHub Actions refreshes hourly).
   State: read/kept maps + your UI toggles in localStorage (ghrss:read/kept/ui);
   every other preference is owned by config.json and re-read on each load. */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS_READ = 'ghrss:read', LS_KEPT = 'ghrss:kept', LS_UI = 'ghrss:ui', LS_VER = 'ghrss:ver';
const STORAGE_VERSION = 2; // bump = one-time reset of the stored feed state (read + kept); UI prefs survive
// One-time feed-storage reset: a browser that last visited before this version
// starts fresh — read/keep-unread state is wiped once, then the version is recorded.
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
  feeds: new Map(),          // feedId -> articles[]
  scope: 'all',
  search: '',
  expandedId: null,
  visible: [],
  keepVisible: new Set(),    // rows the user just read stay in the Unread view until they move on
  read: loadObj(LS_READ),    // {articleId: readTs}
  kept: loadObj(LS_KEPT),    // {articleId: true} — "keep unread"
  filters: [],
  markTimers: new Map(),
  loading: new Set(),
  refreshTimer: null,
  bulkSel: new Set(),
};

/* Preferences come in two groups:
   - CONFIG_KEYS have no in-UI toggle: config.json owns them and they are
     re-applied on EVERY load (edit config.json, reload, done).
   - USER_KEYS are changed with the UI's own controls (layout, status, sort…)
     and persist per browser; config.json only seeds a brand-new visitor. */
const CONFIG_KEYS = ['theme', 'density', 'markReadOnOpen', 'markReadAfterSeconds',
  'titlesOnly', 'openOriginal', 'showFavicons', 'columnThumbs', 'scrollTracking',
  'absoluteDates', 'fontSize', 'sideFavicons', 'compactSidebar', 'countersClickable',
  'titleCounter', 'showToday', 'updatedOnly', 'dimRead', 'sortAZ', 'autoScroll'];
const USER_KEYS = ['layout', 'status', 'dateRange', 'sortDir', 'showFiltered', 'bulkSelect', 'openFolders', 'sidebarW'];
const savedUi = loadObj(LS_UI); // older blobs may carry more keys — only USER_KEYS are honored
const ui = Object.assign({
  theme: 'auto', layout: 'list', status: 'unread', dateRange: 'all',
  showFiltered: false, openFolders: {},
  markReadOnOpen: true, markReadAfterSeconds: 0,
  density: 'comfort', sortDir: 'oldest',
  updatedOnly: false, dimRead: false, sortAZ: false, scrollTracking: false,
  titlesOnly: false, openOriginal: false, showFavicons: true, columnThumbs: true,
  bulkSelect: false, autoScroll: true, absoluteDates: false, fontSize: '14.5px',
  sideFavicons: true, compactSidebar: false, countersClickable: true, titleCounter: true, showToday: false,
}, Object.fromEntries(USER_KEYS.filter((k) => k in savedUi).map((k) => [k, savedUi[k]])));
// migrate pre-parity values
if (ui.layout === 'compact') { ui.layout = 'list'; ui.density = 'compact'; }

function loadObj(k) {
  // Null-prototype objects: feed GUIDs like "constructor"/"__proto__" can't
  // fake lookups (isRead) or pollute prototypes through state maps.
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
function saveUi() { saveObj(LS_UI, Object.fromEntries(USER_KEYS.map((k) => [k, ui[k]]))); }

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
  if (s < 30 * 86400) return Math.floor(s / (7 * 86400)) + 'w';
  if (s < 365 * 86400) return Math.floor(s / (30 * 86400)) + 'mo';
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
  if (!m) return { title: id, site: '', folder: null, folders: [], status: null };
  if (!m.folders) m.folders = m.folder ? [m.folder] : [];
  if (!m.status) m.status = null;
  return m;
};
const feedTitle = (id) => feedMeta(id).title || id;
// Folder registry: generated by the fetcher (config.json + feeds.opml merged), config as fallback.
const folderDefs = () => (state.index?.folders?.length ? state.index.folders : state.config?.folders || []);

/* ---------------- config filters (include/exclude, JSON-driven) ---------------- */
function compileMatcher(v) {
  const s = String(v);
  const m = s.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    try { const re = new RegExp(m[1], (m[2] || 'i').replace('g', '')); return (hay) => re.test(hay); } catch { return () => false; }
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
    // fetch failures surface through index.json feed status (sidebar warning icon)
  } catch {
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
      else if (key === 'is' && (val === 'read' || val === 'unread')) ops.unread = val === 'unread';
      else rest.push(m[0].toLowerCase()); // unknown operator: treat the whole token as a term
    } else rest.push((m[4] ?? m[5] ?? '').toLowerCase());
  }
  return { ops, terms: rest.filter(Boolean) };
}
function compileSearch(q) {
  if (!q || !String(q).trim()) return null;
  // OR-groups: "a b OR c" → (a AND b) OR (c). Parsed once per render, not per article.
  return String(q).split(/\s+or\s+/i).map((group) => parseQuery(group));
}
function searchMatchesCompiled(a, groups) {
  return groups.some(({ ops, terms }) => searchGroupMatches(a, ops, terms));
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
  const f = folderDefs().find((x) => x.id === state.scope.slice(7));
  const days = Number(f?.maxAgeDays) || 0;
  return days > 0 ? days * 864e5 : 0;
}
function computeVisible() {
  const out = [];
  const searchGroups = compileSearch(state.search);
  for (const feedId of feedIdsInScope()) {
    const cutoff = folderCutoff(feedId);
    for (const a of state.feeds.get(feedId) || []) {
      if (cutoff && Date.now() - a.date > cutoff) continue;
      if (!scopeFilter(a)) continue;
      if (!dateRangeFilter(a)) continue;
      if (a._f.hidden && !ui.showFiltered) continue;
      const read = isRead(a);
      if (state.scope !== 'recently-read') {
        if (ui.status === 'unread' && read && !state.keepVisible.has(a.id) && a.id !== state.expandedId) continue;
        if (ui.status === 'read' && !read) continue;
      }
      if (state.search && !searchMatchesCompiled(a, searchGroups)) continue;
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
    // a vanished or hidden open article is dropped — renderList clears it + the URL hash
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
  const folders = [...folderDefs()];
  if (ui.sortAZ) folders.sort((a, b) => a.name.localeCompare(b.name));
  const inFolder = new Set();
  let html = '';
  const totalUnread = Object.keys(feeds).reduce((n, id) => n + unreadCount(id), 0);

  const feedItem = (id) => {
    inFolder.add(id);
    const meta = feedMeta(id), n = unreadCount(id);
    if (ui.updatedOnly && n === 0) return '';
    const dim = ui.dimRead && n === 0 ? 'dimmed' : '';
    const st = meta.status || {};
    const failed = st.ok === false && !st.disabled;
    const disabled = !!st.disabled;
    const warnTitle = failed
      ? `Scrape failed (last hour attempt unsuccessful)${st.error ? ': ' + st.error : ''}${st.consecutiveFailures ? ' — ' + st.consecutiveFailures + ' consecutive failures' : ''}${st.lastSuccess ? ' — last success: ' + relTime(st.lastSuccess) + ' ago' : ''}`
      : disabled
        ? 'Feed disabled in config'
        : esc(meta.title);
    const warnIcon = failed ? '<span class="feed-warn" title="' + esc(warnTitle) + '">⚠</span>' : disabled ? '<span class="feed-warn feed-warn-dim" title="' + esc(warnTitle) + '">⚠</span>' : '';
    return `<button class="tree-item ${state.scope === 'feed:' + id ? 'active' : ''} ${n ? 'unread' : ''} ${dim} ${failed ? 'feed-failed' : ''}" data-scope="feed:${esc(id)}" title="${esc(warnTitle)}">
      ${faviconHtml({ title: meta.title, site: meta.site })}<span class="label">${esc(meta.title)}</span>${warnIcon}${n ? `<span class="badge" data-markread="feed:${esc(id)}" title="Mark as read">${n}</span>` : ''}
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

  // System rows (their #subscriptions_fieldset): Today (opt-in) + Newsfeed only.
  // Unread/Recently read live in the header ⋯ menu, not duplicated in the tree.
  $('#pdinner_today').classList.toggle('hidden', !ui.showToday);
  let todayN = 0;
  for (const arts of state.feeds.values()) for (const a of arts) if (!isRead(a) && !a._f.hidden && a.date >= startOfToday()) todayN++;
  $('#badge-today').textContent = todayN > 0 ? String(todayN) : '';
  $('#badge-all-items').textContent = totalUnread > 0 ? String(totalUnread) : '';
  // The badge ✓-hover only advertises "click to mark read" when counters are clickable.
  $('#subscriptions_fieldset').dataset.counters = ui.countersClickable ? '1' : '0';
  $$('.parent_div > .tree-item[data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === state.scope));
}

function scopeTitle() {
  const s = state.scope;
  if (s === 'all') return 'Newsfeed';
  if (s === 'today') return 'Today';
  if (s === 'recently-read') return 'Recently read';
  if (s.startsWith('feed:')) return feedTitle(s.slice(5));
  if (s.startsWith('folder:')) {
    const f = folderDefs().find((x) => x.id === s.slice(7));
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
  const stacked = ['cards', 'column', 'magazine'].includes(ui.layout);
  const listLike = ui.layout === 'list';
  const thumbWanted = (stacked || listLike) && (ui.layout !== 'column' || ui.columnThumbs);
  const thumb = thumbWanted ? thumbFor(a) : null;
  const isExpanded = state.expandedId === a.id && ui.layout !== 'expanded';
  const timeHtml = ui.absoluteDates ? absTime(a.date) : relTime(a.date);
  return `<article class="row ${read ? '' : 'unread'} ${f.highlight ? 'highlight' : ''} ${isExpanded ? 'expanded' : ''}" data-id="${esc(a.id)}">
    ${ui.bulkSelect ? `<input type="checkbox" class="row-check" ${state.bulkSel.has(a.id) ? 'checked' : ''} title="Select">` : ''}
    ${thumb ? `<img class="row-thumb" loading="lazy" src="${esc(thumb)}" alt="" onerror="this.remove()">` : ''}
    <div class="row-main">
      <div class="row-meta">
        ${faviconHtml(feed)}<span class="feed-name">${esc(feed.title)}</span>
        ${a.author ? `<span class="author">${esc(a.author)}</span>` : ''}
        ${f.hidden ? '<span class="author" title="Filtered">[filtered]</span>' : ''}
      </div>
      <div class="row-title">${esc(a.title)}</div>
      ${!ui.titlesOnly && !listLike ? `<div class="row-snippet">${esc(a.summary || stripTags(a.content).slice(0, 220))}</div>` : ''}
      <span class="time" title="${esc(fullTime(a.date))}">${esc(timeHtml)}</span>
    </div>
    <div class="row-actions">
      <a class="icon-btn" href="${esc(a.link || '#')}" target="_blank" rel="noopener noreferrer" title="Open original in new tab" data-act="open-original" onclick="event.stopPropagation()"><svg><use href="#i-external"/></svg></a>
      <button class="icon-btn" data-act="keep" title="Keep unread"><svg><use href="#i-${isKept(a) ? 'eye' : 'eyeoff'}"/></svg></button>
      <button class="icon-btn" data-act="toggle-read" title="Mark read/unread"><svg><use href="#i-${isRead(a) ? 'unread' : 'read'}"/></svg></button>
    </div>
  </article>`;
}
function ytId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?.*?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
function articleBody(a) {
  let html = a.content || a.text || `<p>${esc(a.summary || '')}</p>`;
  // Ensure the main video is embeddable for YouTube articles.
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
  return `<div class="reader" data-id="${esc(a.id)}">
    <div class="reader-toolbar">
      <span class="spacer"></span>
      <button class="icon-btn" data-act="prev" title="Previous article" ${idx <= 0 ? 'disabled' : ''}><svg><use href="#i-prev"/></svg></button>
      <button class="icon-btn" data-act="next" title="Next article" ${idx >= state.visible.length - 1 ? 'disabled' : ''}><svg><use href="#i-next"/></svg></button>
      <a class="icon-btn" href="${esc(a.link || '#')}" target="_blank" rel="noopener noreferrer" title="Open original" data-act="open-original"><svg><use href="#i-external"/></svg></a>
      <button class="icon-btn" data-act="collapse" title="Close reader"><svg><use href="#i-close"/></svg></button>
    </div>
    <h2 class="reader-title">${a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer" title="Open original article">${esc(a.title)}</a>` : esc(a.title)}</h2>
    <div class="reader-sub">
      <span class="sub-feed" data-scope="feed:${esc(a._feed)}" title="Show this feed">${esc(feed.title)}</span>
      ${a.author ? `<span>by ${esc(a.author)}</span>` : ''}
      <span title="${esc(fullTime(a.date))}">${esc(relTime(a.date))}</span>
      ${readingTime(a) ? `<span>· ${esc(readingTime(a))}</span>` : ''}
    </div>
    ${readerBodyHtml(a)}
    ${attachmentsHtml(a)}

  </div>`;
}
function attachmentsHtml(a) {
  // Non-image enclosures as links; standalone images below (skip image/thumbnail —
  // that one is already used as the row thumb, don't list it twice).
  const enc = (a.enclosures || []).filter((e) => e.url && !/^image\//i.test(e.type || ''));
  const imgs = (a.enclosures || []).filter((e) => e.url && /^image\//i.test(e.type || '') && e.type !== 'image/thumbnail');
  if (!enc.length && !imgs.length) return '';
  const label = (e) => {
    const kind = (e.type || '').split('/')[0];
    const raw = (e.url.split('/').pop() || '').split('?')[0] || '';
    let name = raw;
    try { name = decodeURIComponent(raw); } catch { /* malformed percent-encoding — keep raw */ }
    name = name.slice(0, 90);
    return kind && kind !== 'image' ? `${kind.toUpperCase()} · ${name}` : name;
  };
  return `<div class="reader-attachments">
    ${enc.map((e) => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer"><svg style="width:16px;height:16px"><use href="#i-external"/></svg>${esc(label(e))}</a>`).join('')}
    ${imgs.map((e) => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(e.url)}" alt="">${esc(label(e))}</a>`).join('')}
  </div>`;
}
function readingTime(a) {
  try {
    const text = stripTags(a.text || a.content || a.summary || '');
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (!words) return '';
    const mins = Math.max(1, Math.round(words / 200));
    return `${mins} min read`;
  } catch { return ''; }
}

function renderList() {
  const list = $('#list');
  const visible = computeVisible();
  list.className = `view-${ui.layout}${ui.layout === 'list' ? ` density-${ui.density}` : ''}${ui.showFavicons ? '' : ' no-favicons'}`;
  document.body.classList.toggle('bulk-mode', !!ui.bulkSelect);
  updateBulkBar();
  if (state.expandedId && !visible.some((a) => a.id === state.expandedId)) { state.expandedId = null; clearHashArticle(); }
  const keepScroll = list.scrollTop; // rebuilding the list must not yank it back to the top
  list.innerHTML = visible.map((a) => {
    let row = rowHtml(a);
    if (ui.layout === 'expanded') row = row.replace('</article>', `<div class="row-body-inline">${articleBody(a)}</div></article>`);
    return row;
  }).join('');
  list.scrollTop = keepScroll;
  list.querySelectorAll('.row-body-inline').forEach((el) => { sanitizeReaderDom(el); upgradeEmbeds(el); });
  renderReaderPane(visible);
  setupScrollTracking();
  const unread = visible.filter((a) => !isRead(a)).length;
  $('#scope-title').textContent = scopeTitle();
  $('#scope-count').textContent = state.scope === 'recently-read'
    ? `${visible.length} recently read`
    : `${unread} unread`; // their header: "Newsfeed" + "81 unread"
  updateTitleCounter();
  renderEmpty(visible);
}
let readerKey = ''; // article id:fetchedAt — rebuild the reader pane only when the open article changes
function renderReaderPane(visible) {
  // Split frame (ss1/ss3): list stays put, the article opens in the right pane.
  const slot = $('#reader-slot');
  if (!slot) return;
  const open = state.expandedId ? findArticle(state.expandedId) : null;
  const show = !!(open && visible.includes(open) && !open._f?.hidden);
  if (show) {
    const key = `${open.id}:${open.fetchedAt || 0}`;
    if (key !== readerKey) {
      readerKey = key;
      slot.innerHTML = readerHtml(open);
      slot.classList.remove('hidden');
      document.body.classList.add('article-open');
      slot.querySelectorAll('.reader-body').forEach((el) => { sanitizeReaderDom(el); upgradeEmbeds(el); });
    } else {
      // Same article: don't nuke playing embeds — only sync control state.
      const i = state.visible.indexOf(open);
      const prev = slot.querySelector('[data-act="prev"]'), next = slot.querySelector('[data-act="next"]');
      if (prev) prev.disabled = i <= 0;
      if (next) next.disabled = i >= state.visible.length - 1;
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
  const vimeo = (url) => { const m = url.match(/vimeo\.com\/(\d+)/); return m ? m[1] : null; };
  const audioRe = /\.(mp3|m4a|oga|ogg|wav|aac)(\?|$)/i;
  const videoRe = /\.(mp4|webm|ogv|mov)(\?|$)/i;

  for (const a of $$('a[href]', root)) {
    const url = a.href;
    if (/^https?:/.test(url) === false) continue;
    const wrap = document.createElement('div');
    wrap.className = 'embed';
    const id = ytId(url);
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
  root.querySelectorAll('script, style, link, meta, form, input, button, object, embed, [data-blocked-embed]').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((el) => {
    // Feed-supplied classes/styles could hijack app CSS (.hidden, .row, fixed overlays…)
    el.removeAttribute('class');
    el.removeAttribute('style');
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(attr.name);
    }
    const tag = el.tagName;
    if (tag === 'A') {
      const href = (el.getAttribute('href') || '').trim();
      if (/^(javascript|data|vbscript):/i.test(href)) el.removeAttribute('href');
      else if (/^https?:/i.test(href)) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    }
    if (tag === 'IFRAME') {
      const src = el.getAttribute('src') || '';
      if (!/^https:\/\/(www\.)?(youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/|w\.soundcloud\.com\/)/.test(src)) el.remove();
    }
  });
}

/* ---------------- read state actions ---------------- */
let forceAllowed = false; // explicit user clicks override keepUnread
function markRead(id, on = true) {
  const a = findArticle(id);
  if (!on) delete state.read[id];
  else if (a && a._f?.keepUnread && !forceAllowed) return;
  else {
    state.read[id] = Date.now();
    // A row the user just marked read lingers in the Unread view (tick flips to ✓)
    // until they move on — it never vanishes mid-click.
    if (state.visible.some((v) => v.id === id)) state.keepVisible.add(id);
  }
  saveRead(); renderTree(); renderList();
}
function findArticle(id) {
  for (const arts of state.feeds.values()) { const a = arts.find((x) => x.id === id); if (a) return a; }
  return null;
}
function scheduleMarkRead(a) {
  clearTimeout(state.markTimers.get(a.id));
  state.markTimers.delete(a.id);
  if (!ui.markReadOnOpen) return; // opening does not mark read when disabled
  const delay = (Number(ui.markReadAfterSeconds) || 0) * 1000;
  const run = () => {
    state.markTimers.delete(a.id);
    if (delay > 0 && state.expandedId !== a.id) return; // article was closed before the delay elapsed
    if (!isRead(a) && !isKept(a) && !a._f?.keepUnread) {
      state.read[a.id] = Date.now();
      state.keepVisible.add(a.id); // linger, don't vanish (open-original mode included)
      saveRead(); renderTree(); renderList();
    }
  };
  if (delay <= 0) run();
  else state.markTimers.set(a.id, setTimeout(run, delay));
}
function collectScopeIds(scope, olderDays = 0) {
  let feedIds;
  const cutoff = olderDays ? Date.now() - olderDays * 864e5 : 0;
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
      if (cutoff && a.date >= cutoff) continue;
      ids.push(a.id);
    }
  }
  return ids;
}
const OLDER_LABELS = { 1: 'a day', 2: 'two days', 3: 'three days', 7: 'a week', 14: 'two weeks', 21: 'three weeks', 28: 'four weeks' };
function markScopeRead(scope, olderDays = 0) {
  const ids = collectScopeIds(scope, olderDays);
  if (!ids.length) {
    showToast(olderDays ? 'Nothing older than that — everything here is read' : 'Nothing to mark — everything here is read');
    return;
  }
  const snapshot = ids.map((id) => ({ id, ts: state.read[id] }));
  for (const id of ids) state.read[id] = Date.now();
  saveRead(); clearHashArticle(); state.expandedId = null; state.keepVisible.clear(); renderTree(); renderList();
  const what = olderDays ? ` older than ${OLDER_LABELS[olderDays] || olderDays + ' days'}` : '';
  showToast(`Marked ${ids.length} article${ids.length === 1 ? '' : 's'}${what} as read`, 'Undo', () => {
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
    const a = findArticle(id);
    if (on && (isKept(a) || a?._f?.keepUnread)) continue;
    if (on) state.read[id] = Date.now(); else delete state.read[id];
    n++;
  }
  state.bulkSel.clear();
  state.keepVisible.clear();
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

/* ---------------- open/close article — URL-driven (#article/<id>) ----------------
   The open article lives in the URL hash, so a refresh reopens it and the
   browser Back/Forward buttons walk through opened articles (misclick → Back).
   Opening pushes a history entry; closing replaces it (no "closed" spam). */
const HASH_PREFIX = '#article/';
const hashArticleId = () => {
  const h = location.hash || '';
  return h.startsWith(HASH_PREFIX) ? decodeURIComponent(h.slice(HASH_PREFIX.length)) : null;
};
function setHashArticle(id) {
  const target = HASH_PREFIX + encodeURIComponent(id);
  if ((location.hash || '') !== target) location.hash = target; // the assignment pushes a history entry
}
function clearHashArticle() {
  if (!location.hash) return;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { location.hash = ''; }
}
function openArticle(id) {
  const a = findArticle(id);
  if (!a || a._f?.hidden) return false;
  state.keepVisible.clear(); // opening another article re-filters rows read before it
  state.expandedId = id;
  renderList();
  listScrollTo(id);
  if (ui.autoScroll) { const ap = $('#article_pane'); if (ap) ap.scrollTop = 0; }
  scheduleMarkRead(a);
  return true;
}
function closeArticle(keep = true) {
  if (!state.expandedId) return;
  clearTimeout(state.markTimers.get(state.expandedId));
  state.markTimers.delete(state.expandedId);
  if (keep) state.keepVisible.add(state.expandedId); // closing keeps the just-read row in place
  state.expandedId = null;
  renderList();
}
function openViaHash(id) {
  if (hashArticleId() === id) openArticle(id); // hash already points here (e.g. re-click after Back)
  else setHashArticle(id);                     // hashchange opens it — one path for every open
}
function closeViaHash() { clearHashArticle(); closeArticle(true); }
function syncFromHash(notify = true) {
  const id = hashArticleId();
  if (id) {
    if (state.expandedId === id) return;
    if (!openArticle(id)) { // left the retention window or hidden by a config filter
      clearHashArticle();
      if (notify) showToast('That article is no longer available (filtered or past the retention window)');
    }
  } else closeArticle(true); // Back from #article/<id> to the list closes the reader, row lingers
}

/* ---------------- interactions ---------------- */
function dispatchAct(act, id, el, e) {
  const a = findArticle(id);
  if (!a) return;
  if (act === 'toggle-read') { forceAllowed = true; markRead(id, !isRead(a)); forceAllowed = false; }
  else if (act === 'keep') { if (state.kept[id]) delete state.kept[id]; else state.kept[id] = true; saveKept(); renderList(); }
  else if (act === 'open-original') { /* anchor handles it */ }
  else if (act === 'collapse') closeViaHash(); // closing keeps the row — read, ticked, in place
  else if (act === 'prev' || act === 'next') {
    const i = state.visible.indexOf(a);
    const target = state.visible[act === 'prev' ? i - 1 : i + 1];
    if (target) openViaHash(target.id); // openArticle clears keepVisible — moving on refilters
  }
}


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
    e.stopPropagation();
    dispatchAct(actBtn.dataset.act, id, actBtn, e);
    return;
  }
  if (ui.bulkSelect) { // bulk mode: clicking anywhere on the row toggles selection
    if (state.bulkSel.has(id)) state.bulkSel.delete(id); else state.bulkSel.add(id);
    rowEl.classList.toggle('selected', state.bulkSel.has(id));
    const chk = rowEl.querySelector('.row-check');
    if (chk) chk.checked = state.bulkSel.has(id);
    updateBulkBar();
    return;
  }
  if (ui.openOriginal && a.link) { // "Open original webpages directly"
    window.open(a.link, '_blank', 'noopener');
    scheduleMarkRead(a);
    return;
  }
  if (state.expandedId === id) { closeViaHash(); return; } // collapse — the read row stays put
  openViaHash(id); // expand — the one URL-driven path (hashchange opens it)
}
function listScrollTo(id) {
  const safe = (window.CSS && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
  const el = $(`.row[data-id="${safe}"]`);
  if (el) el.scrollIntoView?.({ block: 'nearest' });
}

function renderAll() { renderTree(); renderList(); }

function bindEvents() {
  $('#list').addEventListener('click', onListClick);
  $('#reader-slot').addEventListener('click', (e) => {
    if (!state.expandedId) return;
    const actBtn = e.target.closest('[data-act]');
    if (!actBtn) return;
    e.stopPropagation();
    dispatchAct(actBtn.dataset.act, state.expandedId, actBtn, e);
  });
  $('#scroll-up').addEventListener('click', () => {
    const btn = $('#reader-slot [data-act="prev"]');
    if (btn && !btn.disabled) btn.click();
  });
  $('#scroll-down').addEventListener('click', () => {
    const btn = $('#reader-slot [data-act="next"]');
    if (btn && !btn.disabled) btn.click();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#header-menu') && !e.target.closest('#btn-more')) $('#header-menu')?.classList.add('hidden');
    if (!e.target.closest('#mark-menu') && !e.target.closest('#btn-mark-all-split')) $('#mark-menu')?.classList.add('hidden');
    const markBtn = e.target.closest('[data-markread]');
    if (markBtn) {
      e.stopPropagation();
      if (ui.countersClickable) markScopeRead(markBtn.dataset.markread);
      return;
    }
    const scopeBtn = e.target.closest('[data-scope]');
    if (scopeBtn) {
      state.scope = scopeBtn.dataset.scope;
      clearHashArticle();
      state.expandedId = null;
      state.keepVisible.clear();
      document.body.classList.remove('sidebar-open');
      $('#scrim').classList.add('hidden'); // don't leave a stuck overlay after picking a feed (mobile)
      if (scopeBtn.dataset.folder) { // folder click also toggles expansion
        ui.openFolders[scopeBtn.dataset.folder] = !scopeBtn.parentElement.classList.contains('open');
        saveUi();
      }
      renderAll();
      ensureScopeLoaded();
      return;
    }
  });

  // ⋯ menu → article list status (their dropdown: All/Unread/Today/Recently read)
  $('#status-items').addEventListener('click', (e) => {
    const item = e.target.closest('[data-status]');
    if (!item) return;
    const v = item.dataset.status;
    if (v === 'today') state.scope = 'today';
    else if (v === 'recently-read') state.scope = 'recently-read';
    else { ui.status = v; if (state.scope !== 'all' && !state.scope.startsWith('feed:') && !state.scope.startsWith('folder:')) state.scope = 'all'; }
    clearHashArticle();
    state.expandedId = null;
    state.keepVisible.clear(); // view change: lingering read rows re-filter out
    saveUi(); syncControls(); renderAll(); ensureScopeLoaded();
    $('#header-menu').classList.add('hidden');
  });
  $('#date-range').addEventListener('change', (e) => { ui.dateRange = e.target.value; state.keepVisible.clear(); saveUi(); renderList(); });
  $('#layouts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-layout]');
    if (!btn) return;
    ui.layout = btn.dataset.layout; saveUi(); syncControls(); renderList();
  });
  $('#btn-show-filtered').addEventListener('click', () => {
    ui.showFiltered = !ui.showFiltered; saveUi(); syncControls(); renderList();
  });
  $('#menu-select-mode').addEventListener('click', () => {
    ui.bulkSelect = !ui.bulkSelect; state.bulkSel.clear(); saveUi(); syncControls(); renderList();
  });
  $('#menu-refresh').addEventListener('click', () => { $('#header-menu').classList.add('hidden'); refresh(true); });
  window.addEventListener('hashchange', () => syncFromHash()); // Back/Forward between articles
  $('#menu-reset-read').addEventListener('click', () => {
    $('#header-menu').classList.add('hidden');
    confirmDialog('Reset read state', 'Forget all read and keep-unread state? Every article goes back to unread.', () => {
      state.read = Object.create(null); state.kept = Object.create(null);
      state.keepVisible.clear(); state.bulkSel.clear();
      saveRead(); saveKept(); renderTree(); renderList();
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
        // search everything: load remaining feeds, then re-render once
        const missing = Object.keys(state.index?.feeds || {}).filter((id) => !state.feeds.has(id));
        if (missing.length) { await loadAllFeeds(() => {}); renderTree(); renderList(); }
      }
    }, 200);
  });

  $('#btn-mark-all').addEventListener('click', markAllAsReadInScope);
  $('#btn-mark-all-split').addEventListener('click', (e) => {
    e.stopPropagation(); // their ▾ opens the "Mark as read articles" menu (ss2)
    $('#mark-menu').classList.toggle('hidden');
  });
  $('#mark-menu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-older]');
    if (!item) return;
    $('#mark-menu').classList.add('hidden');
    markScopeRead(state.scope, Number(item.dataset.older));
  });
  $('#sort-items').addEventListener('click', (e) => {
    const item = e.target.closest('[data-sort]');
    if (!item) return;
    ui.sortDir = item.dataset.sort; saveUi(); syncControls(); renderList();
  });

  // header: expanding search (their search-input-wrapper behavior)
  $('#search-open').addEventListener('click', openSearchFn);
  $('#search-close').addEventListener('click', closeSearchFn);
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearchFn(); } }); // Escape in search must not also close the article

  // header ⋯ More menu (status/date/sort/view — their header dropdown)
  $('#btn-more').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#header-menu').classList.toggle('hidden');
  });

  // resizable sidebar (their #sidebar_resizer)
  const resizer = $('#sidebar_resizer');
  if (resizer && !resizer._bound) {
    resizer._bound = true;
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || 310;
      let cur = startW;
      const move = (ev) => {
        cur = Math.min(480, Math.max(210, startW + (ev.clientX - startX)));
        document.documentElement.style.setProperty('--sidebar-width', `${cur}px`);
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        ui.sidebarW = cur; saveUi();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  $('#menu-toggle').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
    $('#scrim').classList.toggle('hidden', !document.body.classList.contains('sidebar-open'));
  });
  $('#scrim').addEventListener('click', () => { document.body.classList.remove('sidebar-open'); $('#scrim').classList.add('hidden'); });

  $('#bulk-read').addEventListener('click', () => bulkMark(true));
  $('#bulk-unread').addEventListener('click', () => bulkMark(false));
  $('#bulk-clear').addEventListener('click', () => { state.bulkSel.clear(); renderList(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeModals();
    $('#header-menu')?.classList.add('hidden');
    $('#mark-menu')?.classList.add('hidden');
    document.body.classList.remove('sidebar-open');
    $('#scrim')?.classList.add('hidden');
    if (state.expandedId) closeViaHash(); // closing keeps the row in place and clears the hash
  });
}

function applyTheme() { document.documentElement.dataset.theme = ui.theme; }
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
  if (state.search) { state.search = ''; renderList(); } // closing search also clears the active filter
}
function syncControls() {
  const status = state.scope === 'today' ? 'today' : state.scope === 'recently-read' ? 'recently-read' : ui.status;
  $$('#status-items [data-status]').forEach((c) => c.classList.toggle('on', c.dataset.status === status));
  $$('#sort-items [data-sort]').forEach((c) => c.classList.toggle('on', c.dataset.sort === (ui.sortDir === 'oldest' ? 'oldest' : 'newest')));
  $$('#layouts [data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === ui.layout));
  $('#date-range').value = ui.dateRange;
  $('#btn-show-filtered').classList.toggle('on', ui.showFiltered);
  $('#menu-select-mode').classList.toggle('on', !!ui.bulkSelect);
  document.documentElement.style.setProperty('--title-size', ui.fontSize || '14.5px');
  applySidebarMode();
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
    if (dirty) { dirty = false; saveRead(); renderTree(); renderList(); }
  }, { threshold: 0 });
  $$('#list .row').forEach((r) => scrollObserver.observe(r));
}

/* ---------------- settings / stats ---------------- */
function closeModals() { $$('.modal').forEach((m) => m.classList.add('hidden')); }
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

/* ---------------- refresh / polling ---------------- */
async function refresh(manual = false) {
  try {
    const index = await fetchJson('data/index.json');
    const changed = index.generatedAt !== state.index?.generatedAt;
    state.index = index;
    if (!changed && !manual) return; // poll only re-downloads payloads when data actually changed
    // Prefer the consolidated single-request payload for speed.
    const consolidated = await loadConsolidatedIntoState();
    if (!consolidated) {
      // reload loaded feeds (new articles), keep the rest lazy
      const loaded = [...state.feeds.keys()];
      for (const id of loaded) { state.feeds.delete(id); await loadFeed(id); }
    }
    renderAll();
    flashUpdated();
  } catch (err) {
    if (manual) flashUpdated('offline — showing last data');
  }
}
function flashUpdated(msg) {
  const el = $('#last-updated');
  if (msg) { el.textContent = msg; el.title = ''; return; }
  const ts = state.index?.generatedAt;
  el.textContent = ts ? `Updated ${relTime(ts) === 'now' ? 'just now' : relTime(ts) + ' ago'}` : 'No data yet';
  el.title = ts ? fullTime(ts) : '';
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

/* ---------------- consolidated (all-feeds.json) loader ---------------- */
async function loadConsolidatedIntoState() {
  try {
    const allData = await fetchJson('data/all-feeds.json');
    if (!Array.isArray(allData?.articles) || !allData.articles.length || !state.index?.feeds) return false;
    const grouped = new Map();
    for (const a of allData.articles) {
      const feedId = a._feed;
      if (!feedId) continue;
      if (!grouped.has(feedId)) grouped.set(feedId, []);
      grouped.get(feedId).push(a);
    }
    state.feeds = new Map();
    for (const [feedId, arts] of grouped.entries()) {
      applyFiltersToFeed(feedId, arts);
      state.feeds.set(feedId, arts);
    }
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
    return true;
  } catch {
    return false;
  }
}

/* ---------------- boot ---------------- */
async function boot() {
  applyTheme();
  bindEvents();
  try {
    state.config = await fetchJson('config.json');
    const s = state.config.settings || {};
    // config.json owns every pref without an in-UI toggle — re-applied on EVERY
    // load, so editing settings + pushing is all it takes to change behavior.
    for (const k of CONFIG_KEYS) if (k in s) ui[k] = s[k];
    if (s.view && !localStorage.getItem(LS_UI)) ui.layout = s.view; // default layout for new visitors
    baseTitle = s.siteName || 'My Inoreader';
    document.title = baseTitle;
    applyTheme(); // theme may have just changed via config
    compileFilters();
    if (ui.sidebarW) document.documentElement.style.setProperty('--sidebar-width', `${ui.sidebarW}px`);
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
  syncControls();
  renderAll();
  flashUpdated();
  await ensureScopeLoaded();
  startPolling();
  // Deep link: #article/<id> reopens that article after a refresh — behaving
  // exactly like clicking the row (mark-read rules included).
  const hid = hashArticleId();
  if (hid && !openArticle(hid)) {
    clearHashArticle();
    showToast('That article is no longer available (filtered or past the retention window)');
  }
}

document.addEventListener('DOMContentLoaded', boot);
})();
