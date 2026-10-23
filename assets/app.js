/* ghrss — entire reader UI. Plain ES2020, no deps, no build step.
   Data: config.json + data/*.json from the repo (GitHub Actions refreshes hourly).
   State: read/kept maps + your UI toggles in localStorage (ghrss:read/kept/ui);
   every other preference is owned by config.json and re-read on each load. */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS_READ = 'ghrss:read', LS_KEPT = 'ghrss:kept', LS_UI = 'ghrss:ui', LS_VER = 'ghrss:ver';
const STORAGE_VERSION = 3; // bump = one-time reset of the stored feed state (read + kept); UI prefs survive
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
  loading: new Map(), // feedId → in-flight load promise (joinable, so a mark action waits for — not skips — a load in progress
  settled: new Set(), // feeds that finished loading (or failed) — mark-mode sync waits for these
  refreshTimer: null,
  lastPollAt: 0,
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
let baseTitle = 'My RSSFeed';
function updateTitleCounter() {
  let n = 0;
  for (const arts of state.feeds.values()) for (const a of arts) if (!isRead(a) && !a._f?.hidden) n++;
  const prefix = n > 0 && ui.titleCounter !== false ? `(${n}) ` : '';
  const open = state.expandedId ? findArticle(state.expandedId) : null;
  // Article open → "(N) My RSSFeed - Article title" (Inoreader-style tab title)
  document.title = open?.title
    ? `${prefix}${baseTitle} - ${String(open.title).slice(0, 100)}`
    : `${prefix}${baseTitle}`;
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
    // An explicit user "keep unread" beats the automation — never eat those.
    if (a._f.markRead && !a._f.keepUnread && !isKept(a) && !isRead(a)) { state.read[a.id] = Date.now(); }
  }
  saveRead();
}

/* ---------------- data loading ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Hard cap on every request — a stalled connection (mobile carriers, in-app
// browsers) can never wedge loading forever. RSS_FETCH_TIMEOUT_MS is a
// test/debug override; real visitors get 10 s.
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
  // A second request for the same feed JOINS the in-flight load instead of
  // skipping it — mark actions then cover exactly what was loading, not a
  // snapshot of whatever happened to be ready.
  if (state.loading.has(feedId)) return state.loading.get(feedId);
  if (!force && state.feeds.has(feedId)) return;
  const done = (async () => {
    try {
      const data = await fetchJson(`data/feeds/${encodeURIComponent(feedId)}.json`);
      applyFiltersToFeed(feedId, data.articles || []);
      state.feeds.set(feedId, data.articles || []);
      // fetch failures surface through index.json feed status (sidebar warning icon)
    } catch {
      // on a forced reload (refresh fallback) the previous articles stay put —
      // a network blip must never blank a feed the user is reading
    } finally {
      state.loading.delete(feedId);
      state.settled.add(feedId);
    }
  })();
  state.loading.set(feedId, done);
  await done;
}
/* Loads many feeds in parallel (6 at a time). 60 serial round-trips took
   minutes on a phone and any stalled request wedged the whole chain — mark
   actions and search now wait seconds at most (each fetch is also capped by
   fetchJson). Renders are throttled so a 60-feed load doesn't rebuild the
   list dozens of times. */
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
async function loadAllFeeds(onChange) {
  // One consolidated request beats dozens of feed files whenever it works;
  // whatever it misses (offline feeds, new entries) is fetched in parallel.
  await loadConsolidatedIntoState();
  const missing = Object.keys(state.index?.feeds || {}).filter((id) => !state.feeds.has(id));
  if (missing.length) await loadMany(missing, onChange);
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
  // (e.g. marked read under the "Unread" filter) until it is collapsed —
  // EXCEPT under an active search: a query narrows the list to exact matches.
  if (state.expandedId && !out.some((a) => a.id === state.expandedId)) {
    const open = findArticle(state.expandedId);
    if (open && !open._f?.hidden && !state.search && scopeFilter(open) && dateRangeFilter(open)) out.push(open);
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
  syncMarkButtons(); // the ✓ button flips to "mark as unread" when everything here is read
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
    const caughtUp = !state.search && ui.dateRange === 'all' && allReadInScope();
    el.innerHTML = `<h3>All caught up 🎉</h3><p>No unread articles here${ui.dateRange !== 'all' ? ' for this time range' : ''}.</p>${caughtUp ? '<p class="empty-hint">Over-marked? The ✓ button and its ▾ menu now offer <em>Mark as unread</em> — everything, by age, or before an exact date.</p>' : ''}`;
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
function collectScopeIds(scope, cutoff = 0) {
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
      if (cutoff && a.date >= cutoff) continue;
      ids.push(a.id);
    }
  }
  return ids;
}
/* Age bounds for the mark actions: either "older than N days" (menu presets)
   or an explicit "published before <date>" (the Before… date pickers). */
const OLDER_LABELS = { 1: 'a day', 2: 'two days', 7: 'a week', 31: 'a month' };
const cutoffFrom = (olderDays = 0, beforeTs = 0) => (beforeTs > 0 ? beforeTs : olderDays > 0 ? Date.now() - olderDays * 864e5 : 0);
function describeCutoff(olderDays = 0, beforeTs = 0) {
  if (beforeTs > 0) return ` from before ${new Date(beforeTs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  if (olderDays > 0) return ` older than ${OLDER_LABELS[olderDays] || olderDays + ' days'}`;
  return '';
}
/* Oldest article the current scope's data actually contains (from
   index.feeds[*].oldest — the fetcher's retention window). A cutoff older
   than this can never match anything: the toast says so instead of leaving
   the user guessing whether the button is broken. */
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
function markScopeRead(scope, olderDays = 0, beforeTs = 0) {
  const what = describeCutoff(olderDays, beforeTs);
  const cutoff = cutoffFrom(olderDays, beforeTs);
  const ids = collectScopeIds(scope, cutoff);
  if (!ids.length) {
    showToast(olderDays || beforeTs ? `No unread articles${what} here${boundaryHint(cutoff)}` : 'Nothing to mark — everything here is read');
    return;
  }
  const snapshot = ids.map((id) => ({ id, ts: state.read[id] }));
  for (const id of ids) state.read[id] = Date.now();
  saveRead(); state.keepVisible.clear(); renderTree(); renderList();
  showToast(`Marked ${ids.length} article${ids.length === 1 ? '' : 's'}${what} as read`, 'Undo', () => {
    for (const { id, ts } of snapshot) { if (ts) state.read[id] = ts; else delete state.read[id]; }
    saveRead(); renderTree(); renderList();
  });
}
function markAllAsReadInScope() {
  if (allReadInScope()) {
    // Everything here is read — the SAME button flips to "mark as unread" so an
    // accidental mark-all (or procrastination regret) is one confirmed click away.
    confirmDialog('Mark as unread', `Mark every article in "${scopeTitle()}" as unread again?`, () => {
      markScopeUnread(state.scope);
    });
  } else {
    confirmDialog('Mark all as read', `Mark all articles in "${scopeTitle()}" as read? Articles kept unread or hidden by filters are skipped.`, () => {
      markScopeRead(state.scope);
    });
  }
}

/* ---- mark-as-unread: the mirror of markScopeRead, active only when the
   current scope is fully caught up (see syncMarkButtons) ---- */
function scopeUnreadCount(scope) {
  // Same definition as the sidebar badges: not read, not filter-hidden.
  let n = 0;
  for (const feedId of feedIdsInScope()) {
    for (const a of state.feeds.get(feedId) || []) {
      if (isRead(a) || a._f?.hidden) continue;
      if (scope === 'today' && a.date < startOfToday()) continue;
      n++;
    }
  }
  return n;
}
function allReadInScope() {
  const ids = feedIdsInScope();
  // Nothing known (index missing / empty) or feeds still loading — keep the
  // read mode; "caught up" must never be claimed vacuously or the button
  // would offer a mark-as-unread that no-ops.
  if (!state.index?.feeds || !ids.length) return false;
  if (ids.some((id) => !state.settled.has(id))) return false; // feeds still loading — keep the read mode
  return scopeUnreadCount(state.scope) === 0;
}
function collectScopeReadIds(scope, cutoff = 0) {
  const ids = [];
  for (const feedId of feedIdsInScope()) {
    for (const a of state.feeds.get(feedId) || []) {
      if (!isRead(a) || a._f?.hidden) continue; // hidden articles re-read themselves via markRead filters anyway
      if (scope === 'today' && a.date < startOfToday()) continue;
      if (cutoff && a.date >= cutoff) continue;
      ids.push(a.id);
    }
  }
  return ids;
}
function markScopeUnread(scope, olderDays = 0, beforeTs = 0) {
  const what = describeCutoff(olderDays, beforeTs);
  const cutoff = cutoffFrom(olderDays, beforeTs);
  const ids = collectScopeReadIds(scope, cutoff);
  if (!ids.length) {
    showToast(olderDays || beforeTs ? `No read articles${what} here${boundaryHint(cutoff)}` : 'Nothing to restore — no read articles here');
    return;
  }
  const snapshot = ids.map((id) => ({ id, ts: state.read[id] }));
  for (const id of ids) delete state.read[id];
  state.keepVisible.clear();
  saveRead(); renderTree(); renderList();
  showToast(`Marked ${ids.length} article${ids.length === 1 ? '' : 's'}${what} as unread`, 'Undo', () => {
    for (const { id, ts } of snapshot) { if (ts) state.read[id] = ts; else delete state.read[id]; }
    saveRead(); renderTree(); renderList();
  });
}
function syncMarkButtons() {
  const caughtUp = allReadInScope();
  const btn = $('#btn-mark-all');
  if (!btn) return;
  btn.title = caughtUp ? 'Mark all as unread' : 'Mark all as read';
  const use = btn.querySelector('use');
  if (use) use.setAttribute('href', caughtUp ? '#i-unread' : '#i-read');
  const split = $('#btn-mark-all-split');
  if (split) split.title = caughtUp ? 'Mark as unread articles' : 'Mark as read articles';
  // Exactly ONE ▾ group is offered — the same rule as the main button flip:
  // unread articles exist → "Mark as read"; everything here is read →
  // "Mark as unread". Never both at once.
  const gRead = $('#mark-group-read');
  const gUnread = $('#mark-group-unread');
  if (gRead) gRead.classList.toggle('hidden', caughtUp);
  if (gUnread) gUnread.classList.toggle('hidden', !caughtUp);
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
  if ((location.hash || '') === target) return; // already here
  // pushState + a direct syncFromHash: opening no longer depends on the
  // browser firing hashchange for a hash-only navigation (some WebViews and
  // in-app browsers mishandle it — the reported "id not stored / Back broken"
  // symptom). pushState is synchronous and fires no events; Back/Forward fire
  // popstate + hashchange, both wired to the same idempotent sync.
  try {
    history.pushState(null, '', location.pathname + location.search + target);
  } catch {
    location.hash = target; // opaque-origin fallback: hashchange still opens it
    return;
  }
  syncFromHash();
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
    const chev = e.target.closest('.tree-folder > .tree-item .chev');
    if (chev) {
      // The chevron IS the expand/collapse control. The folder row itself only
      // selects the folder (shows its articles) — expanding is a separate act.
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
      clearHashArticle();
      state.expandedId = null;
      state.keepVisible.clear();
      document.body.classList.remove('sidebar-open');
      $('#scrim').classList.add('hidden'); // don't leave a stuck overlay after picking a feed (mobile)
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
  window.addEventListener('popstate', () => syncFromHash());   // belt-and-braces: sync is idempotent on double-fire
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
    e.stopPropagation(); // their ▾ opens the mark menu (ss2)
    $('#mark-menu').classList.toggle('hidden');
  });
  // Menu actions wait for the scope's feeds so the count matches the badges —
  // but never forever: every fetch is capped and this wait is bounded too, so
  // a slow connection can't dead-end the click. A visible "still loading"
  // toast replaces the old silent nothing.
  const applyMark = async (fn, olderDays, beforeTs) => {
    const load = ensureScopeLoaded();
    const slow = setTimeout(() => showToast('Still loading this view — marking what has arrived so far'), 1500);
    try {
      await Promise.race([load, sleep(11000)]);
    } finally {
      clearTimeout(slow);
    }
    fn(state.scope, olderDays, beforeTs);
  };
  $('#mark-menu').addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return; // date pickers act on change
    const custom = e.target.closest('[data-custom]');
    if (custom) { // "Before…" row → open its date picker
      const inp = custom.querySelector('input');
      if (inp) { inp.focus(); try { inp.showPicker?.(); } catch {} }
      return;
    }
    const item = e.target.closest('[data-older]');
    if (!item) return;
    $('#mark-menu').classList.add('hidden');
    applyMark(item.dataset.mark === 'unread' ? markScopeUnread : markScopeRead, Number(item.dataset.older) || 0, 0);
  });
  const onMarkDate = (mode) => (e) => {
    const ts = Date.parse(`${e.target.value || ''}T00:00:00`); // local midnight of the picked day
    if (!e.target.value || Number.isNaN(ts)) return;
    $('#mark-menu').classList.add('hidden');
    applyMark(mode === 'unread' ? markScopeUnread : markScopeRead, 0, ts);
  };
  $('#mark-date-read').addEventListener('change', onMarkDate('read'));
  $('#mark-date-unread').addEventListener('change', onMarkDate('unread'));
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
  // j/k: Inoreader-style next/previous article (skips typing contexts).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'j' && e.key !== 'k') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (!state.visible.length) return;
    const i = state.expandedId ? state.visible.findIndex((a) => a.id === state.expandedId) : -1;
    const target = e.key === 'j'
      ? state.visible[Math.min(state.visible.length - 1, i + 1)]
      : state.visible[Math.max(0, i - 1)];
    if (target && target.id !== state.expandedId) openViaHash(target.id);
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

/* ---------------- refresh / polling ----------------
   The Action fetches at :00 sharp and publishes around :01–:03, so polls run on
   a WALL-CLOCK grid (period = refreshMinutes, min 5) — new data is picked up on
   the next boundary tick (:05 with the default), not "an hour after the tab
   happened to load". Tabs left open in the background catch up on focus. */
async function refresh(manual = false) {
  state.lastPollAt = Date.now();
  try {
    const index = await fetchJson('data/index.json');
    const changed = index.generatedAt !== state.index?.generatedAt;
    state.index = index;
    if (!changed && !manual) { renderTree(); return; } // cheap poll: only freshen feed status icons
    // Prefer the consolidated single-request payload for speed.
    const beforeIds = new Set();
    for (const arts of state.feeds.values()) for (const a of arts) beforeIds.add(a.id);
    const consolidated = await loadConsolidatedIntoState();
    if (!consolidated) {
      // Reload the feeds we already have — in parallel, and a feed whose
      // reload fails keeps its previous articles instead of vanishing.
      await loadMany([...state.feeds.keys()], null, true);
    }
    renderAll();
    flashUpdated();
    let fresh = 0;
    for (const arts of state.feeds.values()) for (const a of arts) if (!beforeIds.has(a.id)) fresh++;
    if (fresh) showToast(`${fresh} new article${fresh === 1 ? '' : 's'} synced`);
    else if (manual) showToast('Already up to date');
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
    const delay = period - (Date.now() % period) + 2500; // next wall-clock boundary + 2.5s
    state.refreshTimer = setTimeout(async () => {
      if (document.visibilityState === 'visible') await refresh(false); // hidden tabs idle (battery)
      schedule();
    }, delay);
  };
  schedule();
  // Returning to a backgrounded tab: catch up immediately if the grid missed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.lastPollAt || Date.now() - state.lastPollAt > period) refresh(false);
  });
}
async function ensureScopeLoaded() {
  let ids = feedIdsInScope().filter((id) => !state.feeds.has(id));
  if (!ids.length) return;
  // Many feeds missing → one consolidated request beats dozens of files
  // (this also self-heals a boot where all-feeds.json failed the first time).
  if (ids.length > 8) {
    await loadConsolidatedIntoState();
    ids = feedIdsInScope().filter((id) => !state.feeds.has(id));
  }
  if (ids.length) await loadMany(ids, () => { renderTree(); renderList(); });
  renderAll();
}

/* ---------------- consolidated (all-feeds.json) loader ---------------- */
async function loadConsolidatedIntoState() {
  try {
    const allData = await fetchJson('data/all-feeds.json');
    if (!Array.isArray(allData?.articles) || !allData.articles.length || !state.index?.feeds) return false;
    // Same id + same content keeps the article's original fetchedAt, so the open
    // reader pane (and a playing embed) is NOT rebuilt when a sync lands.
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
      applyFiltersToFeed(feedId, arts);
      state.feeds.set(feedId, arts);
      state.settled.add(feedId);
    }
    // Every configured feed is settled after a consolidated load — a feed with
    // ZERO articles (brand-new, or emptied by upstream 404s) must never block
    // the caught-up flip that allReadInScope() waits on.
    for (const id of Object.keys(state.index.feeds)) state.settled.add(id);
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
    baseTitle = s.siteName || 'My RSSFeed';
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
