/* ghrss — entire reader UI. Plain ES2020, no deps, no build step.
   Data: config.json + data/*.json from the repo (GitHub Actions refreshes hourly).
   State: read/kept maps + your UI toggles in localStorage (ghrss:read/kept/ui);
   every other preference is owned by config.json and re-read on each load. */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS_READ = 'ghrss:read', LS_KEPT = 'ghrss:kept', LS_UI = 'ghrss:ui', LS_VER = 'ghrss:ver', LS_USERUNREAD = 'ghrss:userUnread';
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
  userUnread: loadObj(LS_USERUNREAD), // {articleId: ts} — explicit un-reads that must beat markRead filters (even across reloads)
  filters: [],
  markTimers: new Map(),
  loading: new Map(), // feedId → in-flight load promise (joinable, so a mark action waits for — not skips — a load in progress
  settled: new Set(), // feeds that finished loading (or failed) — mark-mode sync waits for these
  refreshTimer: null,
  lastPollAt: 0,
  bulkSel: new Set(),
  filterMarked: new Set(), // ids already auto-read by a markRead filter (never re-read one the user un-read)
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
const USER_KEYS = ['layout', 'status', 'dateRange', 'sortDir', 'showFiltered', 'openFolders', 'sidebarW'];
// bulkSelect is deliberately NOT persisted: a returning visitor must never
// find article clicks silently hijacked into checkbox selection.
const savedUi = loadObj(LS_UI); // older blobs may carry more keys — only USER_KEYS are honored
const ui = Object.assign({
  theme: 'auto', layout: 'list', status: 'unread', dateRange: 'all',
  showFiltered: false, openFolders: {},
  markReadOnOpen: true, markReadAfterSeconds: 0,
  density: 'comfort', sortDir: 'newest',
  updatedOnly: false, dimRead: false, sortAZ: false, scrollTracking: false,
  titlesOnly: false, openOriginal: false, showFavicons: true, columnThumbs: true,
  bulkSelect: false, autoScroll: true, absoluteDates: false, fontSize: '14.5px',
  sideFavicons: true, compactSidebar: false, countersClickable: true, titleCounter: true, showToday: false,
}, Object.fromEntries(USER_KEYS.filter((k) => k in savedUi).map((k) => [k, savedUi[k]])));
// migrate pre-parity values
if (ui.layout === 'compact') { ui.layout = 'list'; ui.density = 'compact'; }
if (ui.status === 'read') ui.status = 'all'; // legacy saved value — no such view exists

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
function saveUserUnread() { saveObj(LS_USERUNREAD, state.userUnread); }
function saveUi() { saveObj(LS_UI, Object.fromEntries(USER_KEYS.map((k) => [k, ui[k]]))); }

const isRead = (a) => !!state.read[a.id];
const isKept = (a) => !!state.kept[a.id];

/* ---------------- utils ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripTags = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stripCtrl = (s) => String(s ?? '').replace(/[\s\u0000-\u001f]+/g, '');
/* Article links are FEED DATA, not trusted URLs: a hostile feed can ship a
   javascript:/data: "link" and it used to flow straight into the row/reader
   anchors and window.open. Only http(s) (control chars stripped — browsers
   ignore them inside schemes) ever becomes a real URL. */
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
  for (const arts of state.feeds.values()) for (const a of arts) if (!isRead(a) && !a._f?.hidden) n++;
  const prefix = n > 0 && ui.titleCounter !== false ? `(${n}) ` : '';
  const open = state.expandedId ? findArticle(state.expandedId) : null;
  // Article open → "(N) My RSSFeed - Article title" (Inoreader-style tab title)
  document.title = open?.title
    ? `${prefix}${baseTitle} - ${String(open.title).slice(0, 100)}`
    : `${prefix}${baseTitle}`;
}
function faviconHtml(feed) {
  // No inline onerror (CSP-friendly; a title starting with ' or " used to
  // break out of the attribute). A delegated capture-phase 'error' listener
  // in bindEvents swaps the failed <img> for the letter tile.
  // Array.from = code points: an emoji or surrogate-pair initial can't
  // degenerate into half a character.
  const initial = Array.from(String(feed?.title || '?'))[0] || '?';
  const site = feed?.site || '';
  let host = '';
  try { if (site) host = new URL(site).hostname; } catch {}
  if (!host) return `<span class="favicon-wrap"><span class="favicon-tile">${esc(initial)}</span></span>`;
  return `<span class="favicon-wrap"><img class="favicon" loading="lazy" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64" alt=""><span class="favicon-tile" hidden>${esc(initial)}</span></span>`;
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
    try { const re = new RegExp(m[1], (m[2] || 'i').replace(/g/g, '')); return (hay) => re.test(hay); } catch { return () => false; }
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
function blockMatches(block, a) {
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
    // "hide" defaults ON only for pure hide filters: an explicit highlight /
    // markRead / keepUnread means the user wants to SEE those rows — hiding
    // everything the filter selects made highlight-only filters nuke the list.
    const actions = Object.assign({ hide: f.actions && Object.keys(f.actions).length ? false : true }, f.actions || {});
    return {
      id: f.id || 'filter', name: f.name || f.id || '',
      inScope: (feedId) => !scope || scope.has('*') || scope.has(feedId) || feedMeta(feedId).folders.some((f) => scope.has(f)),
      include: compileBlock(f.include), exclude: compileBlock(f.exclude),
      actions,
    };
  });
}
function filterResult(a, feedId) {
  // Two match shapes share one filter: hide treats `include` as a whitelist
  // (hide everything OUTSIDE it — classic kill-file semantics), while the
  // positive actions (highlight / markRead / keepUnread) treat `include` as
  // the SELECTION (act on what's inside it) with `exclude` as a veto. The old
  // single predicate inverted every non-hide action.
  const res = { hidden: false, markRead: false, keepUnread: false, highlight: false };
  for (const f of state.filters) {
    if (!f.inScope(feedId)) continue;
    let hideMatch, actMatch;
    if (!f.include && !f.exclude) { hideMatch = true; actMatch = true; }
    else {
      const inc = f.include ? blockMatches(f.include, a) : null;
      const exc = f.exclude ? blockMatches(f.exclude, a) : false;
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
function applyFiltersToFeed(feedId, articles) {
  let marked = 0;
  for (const a of articles) {
    a._f = filterResult(a, feedId);
    a._feed = feedId;
    // Inoreader-style ingest: markRead filters silently read the article once.
    // An explicit user "keep unread" beats the automation — never eat those;
    // and an article the user deliberately un-read is never re-read by a
    // refresh re-running the filter.
    if (a._f.markRead && !a._f.keepUnread && !isKept(a) && !isRead(a) && !state.userUnread[a.id] && !state.filterMarked.has(a.id)) {
      state.read[a.id] = Date.now();
      state.filterMarked.add(a.id);
      marked++;
    }
  }
  if (marked) saveRead(); // one write per batch — zero when nothing changed
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
/* Scope resolution for ACTIONS (sidebar badges, mark menus): 'all' and 'today'
   are their OWN scopes — never "whatever the user happens to be looking at".
   Clicking the Newsfeed ✓ from inside a feed used to mark just that feed. */
function scopeFeedIds(scope) {
  if (scope.startsWith('feed:')) return [scope.slice(5)];
  if (scope.startsWith('folder:')) {
    const fid = scope.slice(7);
    return Object.keys(state.index?.feeds || {}).filter((id) => feedMeta(id).folders.includes(fid));
  }
  if (scope === 'all' || scope === 'today') return Object.keys(state.index?.feeds || {});
  return feedIdsInScope();
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
  // date-only values mean the user's LOCAL day, matching the mark-date
  // pickers (Date.parse('2026-01-01') would silently mean UTC midnight)
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
      else rest.push(m[0].toLowerCase()); // unknown operator: treat the whole token as a term
    } else rest.push((m[4] ?? m[5] ?? '').toLowerCase());
  }
  return { ops, terms: rest.filter(Boolean) };
}
function compileSearch(q) {
  if (!q || !String(q).trim()) return null;
  // OR-groups: "a b OR c" → (a AND b) OR (c). Uppercase-only: a lowercase "or"
  // inside prose ("for or against") must never split a query.
  return String(q).split(/\s+OR\s+/).map((group) => parseQuery(group));
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
  // An active search is GLOBAL — it spans every feed (the search box preloads
  // them all, and the feed:/title: operators are cross-feed by design). The
  // old scope-clipped loop made "Search in current section" technically true
  // but made the preload and the feed: operator pointless.
  const feedIds = searchGroups ? Object.keys(state.index?.feeds || {}) : feedIdsInScope();
  for (const feedId of feedIds) {
    const cutoff = searchGroups ? 0 : folderCutoff(feedId);
    for (const a of state.feeds.get(feedId) || []) {
      if (cutoff && Date.now() - a.date > cutoff) continue;
      if (!searchGroups && !scopeFilter(a)) continue;
      if (!dateRangeFilter(a)) continue;
      if (a._f.hidden && !ui.showFiltered) continue;
      const read = isRead(a);
      if (state.scope !== 'recently-read') {
        if (ui.status === 'unread' && read && !state.keepVisible.has(a.id) && a.id !== state.expandedId) continue;
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
  if (ui.sortAZ) folders.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)); // nameless config folders used to crash
  const inFolder = new Set();
  let html = '';
  let totalUnread = 0, todayN = 0; // ONE pass instead of a scan per counter
  for (const arts of state.feeds.values()) {
    for (const a of arts) {
      if (isRead(a) || a._f?.hidden) continue;
      totalUnread++;
      if (a.date >= startOfToday()) todayN++;
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
    // Raw title here — esc() runs ONCE, at interpolation. (It used to run
    // twice: "Tom & Jerry" displayed as "Tom &amp;amp; Jerry" in tooltips.)
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
  if (ui.updatedOnly) loose = loose.filter((id) => unreadCount(id) > 0); // was a splice/indexOf O(n²) loop
  if (loose.length) html += loose.map(feedItem).join('');
  tree.innerHTML = html;

  // System rows (their #subscriptions_fieldset): Today (opt-in) + Newsfeed only.
  // Unread/Recently read live in the header ⋯ menu, not duplicated in the tree.
  $('#pdinner_today').classList.toggle('hidden', !ui.showToday);
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
  const kept = isKept(a);
  const f = a._f || {};
  const stacked = ['cards', 'column', 'magazine'].includes(ui.layout);
  const listLike = ui.layout === 'list';
  const thumbWanted = (stacked || listLike) && (ui.layout !== 'column' || ui.columnThumbs);
  const thumb = thumbWanted ? thumbFor(a) : null;
  const isExpanded = state.expandedId === a.id && ui.layout !== 'expanded';
  const timeHtml = ui.absoluteDates ? absTime(a.date) : relTime(a.date);
  return `<article class="row ${read ? '' : 'unread'} ${f.highlight ? 'highlight' : ''} ${isExpanded ? 'expanded' : ''} ${state.bulkSel.has(a.id) ? 'selected' : ''}" data-id="${esc(a.id)}">
    ${ui.bulkSelect ? `<input type="checkbox" class="row-check" aria-label="Select article" ${state.bulkSel.has(a.id) ? 'checked' : ''} title="Select">` : ''}
    ${thumb ? `<img class="row-thumb" loading="lazy" src="${esc(thumb)}" alt="">` : ''}
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
      <a class="icon-btn" href="${esc(safeHref(a.link))}" target="_blank" rel="noopener noreferrer" title="Open original in new tab" aria-label="Open original in new tab" data-act="open-original"><svg><use href="#i-external"/></svg></a>
      <button class="icon-btn" data-act="keep" title="${kept ? 'Stop keeping unread' : 'Keep unread'}" aria-pressed="${kept}" aria-label="Keep unread"><svg><use href="#i-${kept ? 'eye' : 'eyeoff'}"/></svg></button>
      <button class="icon-btn" data-act="toggle-read" title="${read ? 'Mark as unread' : 'Mark as read'}" aria-label="Toggle read"><svg><use href="#i-${read ? 'read' : 'unread'}"/></svg></button>
    </div>
  </article>`;
}
function ytId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?.*?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
function articleBody(a) {
  // Extracted full text FIRST: the fetcher only extracts when the feed's own
  // content is a short teaser — content || text always short-circuited to the
  // teaser, so fullText never reached the reader (and readingTime disagreed).
  let html = a.text || a.content || `<p>${esc(a.summary || '')}</p>`;
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
  const read = isRead(a), kept = isKept(a);
  const link = safeHref(a.link); // '#' for missing/junk schemes — no anchor then
  return `<div class="reader" data-id="${esc(a.id)}">
    <div class="reader-toolbar">
      <span class="spacer"></span>
      <button class="icon-btn" data-act="keep" title="${kept ? 'Stop keeping unread' : 'Keep unread'}" aria-pressed="${kept}" aria-label="Keep unread"><svg><use href="#i-${kept ? 'eye' : 'eyeoff'}"/></svg></button>
      <button class="icon-btn" data-act="toggle-read" title="${read ? 'Mark as unread' : 'Mark as read'}" aria-label="Toggle read"><svg><use href="#i-${read ? 'read' : 'unread'}"/></svg></button>
      <button class="icon-btn" data-act="prev" title="Previous article (k)" ${idx <= 0 ? 'disabled' : ''}><svg><use href="#i-prev"/></svg></button>
      <button class="icon-btn" data-act="next" title="Next article (j)" ${idx >= state.visible.length - 1 ? 'disabled' : ''}><svg><use href="#i-next"/></svg></button>
      <a class="icon-btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Open original (o)" data-act="open-original"><svg><use href="#i-external"/></svg></a>
      <button class="icon-btn" data-act="collapse" title="Close reader"><svg><use href="#i-close"/></svg></button>
    </div>
    <h2 class="reader-title">${link !== '#' ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="Open original article">${esc(a.title)}</a>` : esc(a.title)}</h2>
    <div class="reader-sub">
      <span class="sub-feed" data-scope="feed:${esc(a._feed)}" title="Show this feed">${esc(feed.title)}</span>
      ${a.author ? `<span>by ${esc(a.author)}</span>` : ''}
      <span title="${esc(fullTime(a.date))}">${esc(ui.absoluteDates ? absTime(a.date) : relTime(a.date))}</span>
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
    // Only for genuinely extracted text: every YouTube/HN/4chan row used to
    // read "1 min read" off a two-line description with no readable body.
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
  $('#scope-count').textContent = state.scope === 'recently-read'
    ? `${state.visible.length} recently read`
    : `${unread} unread`; // their header: "Newsfeed" + "81 unread"
}
function renderList() {
  const list = $('#list');
  const visible = computeVisible();
  list.className = `view-${ui.layout}${ui.layout === 'list' ? ` density-${ui.density}` : ''}${ui.showFavicons ? '' : ' no-favicons'}`;
  document.body.classList.toggle('bulk-mode', !!ui.bulkSelect);
  updateBulkBar();
  if (state.expandedId && !visible.some((a) => a.id === state.expandedId)) {
    const open = findArticle(state.expandedId);
    // Purged or filter-hidden → close. Merely filtered OUT of the list by the
    // active search / date filter → the reader stays open on it: searching
    // must never throw away your place.
    if (!open || open._f?.hidden) { state.expandedId = null; clearHashArticle(); }
  }
  const keepScroll = list.scrollTop; // rebuilding the list must not yank it back to the top
  list.innerHTML = visible.map((a) => {
    let row = rowHtml(a);
    if (ui.layout === 'expanded') row = row.replace('</article>', `<div class="row-body-inline">${articleBody(a)}</div></article>`);
    return row;
  }).join('');
  list.scrollTop = keepScroll;
  list.querySelectorAll('.row-body-inline').forEach((el) => {
    sanitizeReaderDom(el);
    upgradeEmbeds(el, findArticle(el.closest('.row')?.dataset.id)?.link);
  });
  renderReaderPane(visible);
  setupScrollTracking();
  updateScopeCount();
  updateTitleCounter();
  syncMarkButtons(); // the ✓ button flips to "mark as unread" when everything here is read
  renderEmpty(visible);
}
let readerKey = ''; // article id:fetchedAt — rebuild the reader pane only when the open article changes
function syncReaderControls(slot, a) {
  // Same article: don't nuke playing embeds — only sync control state.
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
    if (u) u.setAttribute('href', kept ? '#i-eye' : '#i-eyeoff');
  }
}
function renderReaderPane(visible) {
  // Split frame (ss1/ss3): list stays put, the article opens in the right pane.
  const slot = $('#reader-slot');
  if (!slot) return;
  const open = state.expandedId ? findArticle(state.expandedId) : null;
  // Expanded layout renders the body inline in the list — a side pane would
  // duplicate the whole article next to itself.
  const show = !!(open && !open._f?.hidden && ui.layout !== 'expanded');
  if (show) {
    const key = `${open.id}:${open.fetchedAt || 0}`;
    if (key !== readerKey) {
      readerKey = key;
      // Inert-first: sanitize + upgrade on a detached <template>, THEN insert.
      // The live DOM (and its image/media loads) never sees unsanitized markup.
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
  // Feeds still arriving must not be told "All caught up 🎉" — that false
  // caught-up flashed on every slow first load before the articles landed.
  if (feedIdsInScope().some((id) => !state.settled.has(id))) {
    el.innerHTML = `<h3>Loading articles…</h3><p>Fetching this view's feeds — articles appear as they arrive.</p>`;
    return;
  }
  if (state.search) {
    el.innerHTML = `<h3>No matches</h3><p>Nothing matched <code>${esc(state.search)}</code> in any feed.<br>Operators: <code>feed:name</code> <code>title:word</code> <code>before:2026-01-01</code> <code>after:2026-01-01</code> <code>unread:true</code> <code>is:read</code></p>`;
  } else if (ui.status === 'unread') {
    const caughtUp = !state.search && ui.dateRange === 'all' && allReadInScope();
    el.innerHTML = `<h3>All caught up 🎉</h3><p>No unread articles here${ui.dateRange !== 'all' ? ' for this time range' : ''}.</p>${caughtUp ? '<p class="empty-hint">Over-marked? The ✓ button and its ▾ menu now offer <em>Mark as unread</em> — everything, by age, or before an exact date.</p>' : ''}`;
  } else {
    el.innerHTML = `<h3>Nothing here</h3><p>No articles in this view. New items arrive when the hourly fetch runs.</p>`;
  }
}

/* ---------------- embeds (YouTube/Vimeo/SoundCloud/audio/video) ---------------- */
function upgradeEmbeds(root, articleLink) {
  if (!root) return;
  const vimeo = (url) => { const m = url.match(/vimeo\.com\/(\d+)/); return m ? m[1] : null; };
  const audioRe = /\.(mp3|m4a|oga|ogg|wav|aac)(\?|$)/i;
  const videoRe = /\.(mp4|webm|ogv|mov)(\?|$)/i;

  for (const a of $$('a[href]', root)) {
    const url = a.href;
    if (!/^https?:/.test(url)) continue;
    // Only standalone links become players: the bare URL itself, or the
    // article's own link. A "watch this" link inside a sentence — or a
    // creator's "my other channels" link wall in a description — stays a
    // link; it used to be replaced by a wall of 16:9 players.
    const bare = a.textContent.trim() === url || a.textContent.trim() === (a.getAttribute('href') || '').trim();
    if (!bare && url !== articleLink) continue;
    const wrap = document.createElement('div');
    wrap.className = 'embed';
    // Clicks must not bubble to the row handler: opening/closing the article
    // rebuilt the list and instantly killed the player the user just started.
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
    // Track/set links only (2+ path segments): a profile link is not a player.
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
      // Strip control chars first: browsers ignore them inside URL schemes, so
      // "java&#9;script:" used to slip past a naive ^(javascript|data|vbscript):
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

/* ---------------- read state actions ---------------- */
let forceAllowed = false; // explicit user clicks override keepUnread
function patchRow(id) {
  // Flip ONE row's read/keep state in place — no full list rebuild. Keeps
  // scroll position, keeps playing inline videos, skips a few thousand rows
  // of innerHTML work on every click.
  const safe = (window.CSS && CSS.escape) ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
  const rowEl = $(`.row[data-id="${safe}"]`);
  const a = rowEl ? findArticle(id) : null;
  if (!rowEl || !a) return false;
  rowEl.classList.toggle('unread', !isRead(a));
  const t = rowEl.querySelector('[data-act="toggle-read"]');
  if (t) {
    t.title = isRead(a) ? 'Mark as unread' : 'Mark as read';
    const u = t.querySelector('use');
    if (u) u.setAttribute('href', isRead(a) ? '#i-read' : '#i-unread');
  }
  const k = rowEl.querySelector('[data-act="keep"]');
  if (k) {
    k.title = isKept(a) ? 'Stop keeping unread' : 'Keep unread';
    k.setAttribute('aria-pressed', String(isKept(a)));
    const u = k.querySelector('use');
    if (u) u.setAttribute('href', isKept(a) ? '#i-eye' : '#i-eyeoff');
  }
  return true;
}
/* Patch sidebar counters IN PLACE: a read/unread/keep flip used to rebuild the
   whole tree (every favicon <img> recreated) on every single click. Falls back
   to the full renderTree when a badge appears/disappears (structure changed) or
   updatedOnly hides empty rows — those are structural, not numeric. */
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
    if ((n > 0) !== !!row.querySelector('.badge')) { structural = true; break; } // badge shows/hides → rebuild
    plan.push([row, n]);
  }
  if (structural) { renderTree(); return; }
  for (const [row, n] of plan) {
    row.querySelector('.badge').textContent = String(n);
    row.classList.toggle('unread', n > 0);
    row.classList.toggle('dimmed', !!ui.dimRead && n === 0);
  }
  let total = 0, todayN = 0;
  for (const arts of state.feeds.values()) {
    for (const a of arts) {
      if (isRead(a) || a._f?.hidden) continue;
      total++;
      if (a.date >= startOfToday()) todayN++;
    }
  }
  const all = $('#badge-all-items'), td = $('#badge-today');
  if (all) all.textContent = total > 0 ? String(total) : '';
  if (td) td.textContent = todayN > 0 ? String(todayN) : '';
}
function markRead(id, on = true) {
  const a = findArticle(id);
  if (!on) {
    delete state.read[id];
    // The user's explicit un-read must outlive a reload: markRead filters
    // re-run at every load and used to re-read the article the moment the
    // tab reopened ("unread is sacred" only held within one session).
    if (a?._f?.markRead) { state.userUnread[id] = Date.now(); saveUserUnread(); }
  } else {
    if (a && a._f?.keepUnread && !forceAllowed) return;
    if (state.userUnread[id]) { delete state.userUnread[id]; saveUserUnread(); } // explicit read clears the guard
    state.read[id] = Date.now();
    // A row the user just marked read lingers in the Unread view (tick flips to ✓)
    // until they move on — it never vanishes mid-click.
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
function findArticle(id) {
  for (const arts of state.feeds.values()) { const a = arts.find((x) => x.id === id); if (a) return a; }
  return null;
}
function scheduleMarkRead(a) {
  clearTimeout(state.markTimers.get(a.id));
  state.markTimers.delete(a.id);
  const delay = (Number(ui.markReadAfterSeconds) || 0) * 1000;
  // markReadOnOpen gates INSTANT marking; a configured delay opts in on its own —
  // markReadOnOpen:false + markReadAfterSeconds:N is the documented "mark after
  // N seconds instead" combination and used to be silently dead (nothing ever
  // marked read).
  if (!ui.markReadOnOpen && delay <= 0) return;
  const run = () => {
    state.markTimers.delete(a.id);
    // open-original mode never expands anything — the delay must not gate it
    if (delay > 0 && state.expandedId !== a.id && !ui.openOriginal) return; // article was closed before the delay elapsed
    if (!isRead(a) && !isKept(a) && !a._f?.keepUnread) markRead(a.id, true);
  };
  if (delay <= 0) run();
  else state.markTimers.set(a.id, setTimeout(run, delay));
}
function collectScopeIds(scope, cutoff = 0) {
  // 'all'/'today' resolve to EVERY feed here — feedIdsInScope() would quietly
  // clip the action to whatever the user happens to be looking at.
  if (scope === 'recently-read') return []; // that view lists READ articles — there is nothing unread in it to mark (the old fall-through nuked the entire unread backlog while the confirm said "Recently read")
  const feedIds = scopeFeedIds(scope);
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
    confirmDialog('Mark all as read', `Mark all articles in "${scopeTitle()}" as read? Articles kept unread or hidden by filters are skipped.`, async () => {
      // wait for whatever is still loading — same rule as the ✓ ▾ menu items
      await Promise.race([ensureLoadedForScope(state.scope), sleep(11000)]);
      markScopeRead(state.scope);
    });
  }
}

/* ---- mark-as-unread: the mirror of markScopeRead, active only when the
   current scope is fully caught up (see syncMarkButtons) ---- */
function scopeUnreadCount(scope) {
  // Same definition as the sidebar badges: not read, not filter-hidden.
  if (scope === 'recently-read') return 0; // the view is read-by-definition → caught-up flip offers the (honest) mass un-read
  let n = 0;
  for (const feedId of scopeFeedIds(scope)) {
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
  for (const feedId of scopeFeedIds(scope)) {
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
  if (split) split.title = caughtUp ? 'Mark as unread — more options' : 'Mark as read — more options';
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
    const a = findArticle(id); // may be null: a refresh can prune a selected article
    if (on && a && (isKept(a) || a._f?.keepUnread)) continue;
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
function showToast(text, actionLabel, cb, ambient = false) {
  const el = $('#toast');
  const btn = $('#toast-action');
  // One slot, so priority rules apply: AMBIENT notices (sync results, "already
  // up to date") must never stomp a live Undo; action feedback (zero-results,
  // confirms, new Undos) always replaces — a silent button looks broken.
  if (ambient && !actionLabel && !el.classList.contains('hidden') && btn.style.display !== 'none') return;
  $('#toast-text').textContent = text;
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
  if (!h.startsWith(HASH_PREFIX)) return null;
  // A malformed % sequence used to throw out of hashchange/popstate and kill
  // navigation entirely. Fall back to the raw string: openArticle simply
  // reports "not available" and the hash clears.
  try { return decodeURIComponent(h.slice(HASH_PREFIX.length)); } catch { return h.slice(HASH_PREFIX.length); }
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
  // The article being left LINGERS (read, ticked) — rows re-filter on
  // scope/view changes, not on every open. Clearing here broke Back/prev/k:
  // the row you just read vanished, and "Previous" had nothing to return to.
  if (state.expandedId) state.keepVisible.add(state.expandedId);
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
function dispatchAct(act, id) {
  const a = findArticle(id);
  if (!a) return;
  if (act === 'toggle-read') {
    forceAllowed = true; markRead(id, !isRead(a)); forceAllowed = false;
    if (isRead(a)) { delete state.kept[id]; saveKept(); patchRow(id); } // read beats keep
  }
  else if (act === 'keep') {
    if (state.kept[id]) delete state.kept[id];
    else {
      state.kept[id] = Date.now();
      // "Keep unread" must actually make it UNREAD — leaving the read entry
      // meant the row vanished the moment you moved on, flag useless.
      delete state.read[id];
    }
    saveKept(); saveRead();
    if (!patchRow(id)) renderList();
    patchTreeCounts(); updateScopeCount(); updateTitleCounter(); syncMarkButtons();
    const slot = $('#reader-slot');
    if (slot && state.expandedId === id) syncReaderControls(slot, a);
  }
  else if (act === 'open-original') { /* anchor handles it */ }
  else if (act === 'collapse') closeViaHash(); // closing keeps the row — read, ticked, in place
  else if (act === 'prev' || act === 'next') {
    const i = state.visible.indexOf(a);
    const target = state.visible[act === 'prev' ? i - 1 : i + 1];
    if (target) openViaHash(target.id); // moving on refilters
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
    rowEl.classList.toggle('selected', state.bulkSel.has(id));
    updateBulkBar();
    return;
  }
  // Inline bodies are CONTENT, not row toggles: embed clicks, links and text
  // selection inside the article body must never open/close the row around
  // them (it used to destroy the playing video mid-click).
  if (e.target.closest('.row-body-inline') && !e.target.closest('[data-act]')) return;
  const sel = window.getSelection?.();
  if (sel && String(sel).trim()) return;
  const actBtn = e.target.closest('[data-act]');

  if (actBtn) {
    e.stopPropagation();
    dispatchAct(actBtn.dataset.act, id);
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
  if (ui.openOriginal) { // "Open original webpages directly"
    const url = safeHref(a.link);
    if (url !== '#') {
      window.open(url, '_blank', 'noopener');
      scheduleMarkRead(a);
    }
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

  // Favicon/thumb fallback without inline handlers (CSP-friendly, and a
  // title starting with ' or " can't break out of an attribute): swap a
  // failed favicon <img> for its letter tile, drop a dead row thumbnail.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.classList.contains('favicon')) {
      img.closest?.('.favicon-wrap')?.querySelector('.favicon-tile')?.removeAttribute('hidden');
      img.remove();
    } else if (img.classList.contains('row-thumb')) img.remove();
  }, true);

  // Cross-tab sync: another tab writing read/kept state updates this one —
  // without it, tab B's stale in-memory copy overwrote everything tab A read.
  addEventListener('storage', (e) => {
    if (e.key !== LS_READ && e.key !== LS_KEPT) return;
    state.read = loadObj(LS_READ);
    state.kept = loadObj(LS_KEPT);
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
      // Newsfeed/Today badges cover EVERY feed even when the current view is
      // a single feed/folder — and wait (bounded) for whatever is still loading.
      const run = async () => {
        await Promise.race([ensureLoadedForScope(scope), sleep(11000)]);
        markScopeRead(scope);
      };
      run();
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
      ensureLoadedForScope();
      return;
    }
  });
  // Badges are role=button spans: make Enter/Space click them (keyboard a11y)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target?.closest?.('[data-markread]');
    if (t) { e.preventDefault(); t.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
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
    saveUi(); syncControls(); renderAll(); ensureLoadedForScope();
    $('#header-menu').classList.add('hidden');
    syncMenuAria();
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
    ui.bulkSelect = !ui.bulkSelect; state.bulkSel.clear(); syncControls(); renderList(); // not persisted — see USER_KEYS
  });
  $('#menu-refresh').addEventListener('click', () => { $('#header-menu').classList.add('hidden'); refresh(true); });
  window.addEventListener('hashchange', () => syncFromHash()); // Back/Forward between articles
  window.addEventListener('popstate', () => syncFromHash());   // belt-and-braces: sync is idempotent on double-fire
  $('#menu-reset-read').addEventListener('click', () => {
    $('#header-menu').classList.add('hidden');
    syncMenuAria();
    confirmDialog('Reset read state', 'Forget all read and keep-unread state? Every article goes back to unread.', () => {
      state.read = Object.create(null); state.kept = Object.create(null); state.userUnread = Object.create(null);
      state.keepVisible.clear(); state.bulkSel.clear();
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
    syncMenuAria();
  });
  // Menu actions wait for the scope's feeds so the count matches the badges —
  // but never forever: every fetch is capped and this wait is bounded too, so
  // a slow connection can't dead-end the click. A visible "still loading"
  // toast replaces the old silent nothing.
  const applyMark = async (fn, olderDays, beforeTs) => {
    const load = ensureLoadedForScope(state.scope);
    const slow = setTimeout(() => showToast('Still loading this view — marking what has arrived so far', undefined, undefined, true), 1500);
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
  let datePickTimer = null; // Chromium fires change per completed segment while
  // typing a date — act only on the value that's still there a beat later.
  const onMarkDate = (mode) => (e) => {
    clearTimeout(datePickTimer);
    const val = e.target.value || '';
    const ts = Date.parse(`${val}T00:00:00`); // local midnight of the picked day
    if (!val || Number.isNaN(ts) || new Date(ts).getFullYear() < 2000) return; // partial junk ("0002") is a no-op
    datePickTimer = setTimeout(() => {
      $('#mark-menu').classList.add('hidden');
      applyMark(mode === 'unread' ? markScopeUnread : markScopeRead, 0, ts);
    }, 250);
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
    syncMenuAria();
  });

  // resizable sidebar (pointer events: works with touch, not just a mouse)
  const resizer = $('#sidebar_resizer');
  if (resizer) {
    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || 242; // the CSS default — 310 used to make it jump
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
    // Escape peels ONE layer: the confirm dialog (cancelled properly — focus
    // restored through its own done()), then menus, then the mobile sidebar —
    // only a bare Escape closes the open article. It used to close all of
    // them at once, article included, out from under the user.
    const modal = $('#confirm-modal');
    if (modal && !modal.classList.contains('hidden')) { $('#confirm-no')?.click(); return; }
    const menuOpen = !$('#header-menu')?.classList.contains('hidden') || !$('#mark-menu')?.classList.contains('hidden');
    const sidebarOpen = document.body.classList.contains('sidebar-open');
    $('#header-menu')?.classList.add('hidden');
    $('#mark-menu')?.classList.add('hidden');
    document.body.classList.remove('sidebar-open');
    $('#scrim')?.classList.add('hidden');
    syncMenuAria();
    if (menuOpen || sidebarOpen) return;
    if (state.expandedId) closeViaHash(); // closing keeps the row in place and clears the hash
  });
  // j/k: Inoreader-style next/previous article; m/o/s/“/”: mark, open original,
  // keep unread, focus search (skips typing contexts and open overlays).
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (document.querySelector('.modal:not(.hidden), .dropdown:not(.hidden)')) return; // an overlay owns the keys
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
    if (e.key === 'm' && a) { dispatchAct('toggle-read', id); } // same path as the row tick (incl. keep cleanup + in-place patch)
    else if ((e.key === 'o' || e.key === 'v') && a) { const url = safeHref(a.link); if (url !== '#') window.open(url, '_blank', 'noopener'); }
    else if (e.key === 's' && a) { dispatchAct('keep', id); }
    else if (e.key === '/') { e.preventDefault(); openSearchFn(); }
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = ui.theme;
  // Cache the last-applied theme so the inline <head> script in index.html can
  // paint dark BEFORE the CSS/config arrive — returning dark-mode visitors
  // used to get a white flash on every single load.
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
      state.read[a.id] = Date.now();
      // Linger + patch the row IN PLACE. Rebuilding the list removed the row,
      // the content jumped up under the fixed scrollTop, the rows above the
      // fold entered the observer, got marked, and so on — one scroll drained
      // the whole unread view in a runaway cascade.
      state.keepVisible.add(a.id);
      en.target.classList.remove('unread');
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      saveRead();
      patchTreeCounts();
      updateScopeCount(); updateTitleCounter(); syncMarkButtons();
    }
  }, { threshold: 0 });
  $$('#list .row').forEach((r) => scrollObserver.observe(r));
}

/* ---------------- settings / stats ---------------- */
function syncMenuAria() {
  // aria-expanded must track the menus its buttons describe — screen readers
  // announce a stale "collapsed" otherwise.
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

/* ---------------- refresh / polling ----------------
   The Action publishes at :05/:20/:35/:50 (self-healing quarter-hourly
   schedule, landing ~2–3 min after the slot). Polls run on a wall-clock grid
   (period = refreshMinutes, min 5) so a tab that's been open for hours still
   picks up fresh data at the next boundary instead of "an hour after it
   happened to load". Backgrounded tabs idle; they catch up on focus. */
async function refresh(manual = false) {
  state.lastPollAt = Date.now();
  try {
    const index = await fetchJson('data/index.json');
    const changed = index.generatedAt !== state.index?.generatedAt;
    state.index = index;
    if (!changed && !manual) { renderTree(); flashUpdated(); return; } // cheap poll: freshen status icons + the Updated line (it used to go stale for hours)
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
async function ensureLoadedForScope(scope = state.scope) {
  let ids = scopeFeedIds(scope).filter((id) => !state.feeds.has(id));
  if (!ids.length) return;
  // Many feeds missing → one consolidated request beats dozens of files
  // (this also self-heals a boot where all-feeds.json failed the first time).
  if (ids.length > 8) {
    await loadConsolidatedIntoState();
    ids = scopeFeedIds(scope).filter((id) => !state.feeds.has(id));
  }
  if (ids.length) await loadMany(ids, () => { renderTree(); renderList(); });
  renderAll();
}

/* ---------------- consolidated (all-feeds.json) loader ----------------
   Read-state GC: localStorage has a fixed quota and article ids churn (4chan
   threads rekey hourly) — unpruned maps eventually make saveObj throw
   silently, and reads stop persisting with no symptom at all. Rules:
   - read entries older than the retention window (+2wk grace) are gone from
     the data anyway;
   - ids that no longer exist anywhere are dropped only when EVERY feed
     settled AND none failed its last fetch (its articles may simply not have
     arrived yet — pruning then would eat live state). */
function pruneReadState() {
  if (!state.index?.feeds) return;
  const retention = Number(state.config?.settings?.retentionDays) > 0 ? Number(state.config.settings.retentionDays) : 60;
  const cutoff = Date.now() - (retention + 14) * 864e5;
  const Y2K = 946684800000; // sanity floor: garbage/epoch-0 timestamps are "unknown age", kept
  let dropped = false;
  for (const k of Object.keys(state.read)) {
    const ts = state.read[k];
    if (typeof ts === 'number' ? (ts >= Y2K && ts < cutoff) : !ts) { delete state.read[k]; dropped = true; }
  }
  const ids = Object.keys(state.index.feeds);
  if (ids.length && ids.every((id) => state.settled.has(id)) && ids.every((id) => state.index.feeds[id]?.status?.ok !== false)) {
    const live = new Set();
    for (const arts of state.feeds.values()) for (const a of arts) live.add(a.id);
    if (live.size) {
      for (const k of Object.keys(state.kept)) if (!live.has(k)) { delete state.kept[k]; dropped = true; }
      for (const k of Object.keys(state.read)) if (!live.has(k)) { delete state.read[k]; dropped = true; }
      for (const k of Object.keys(state.userUnread)) if (!live.has(k)) { delete state.userUnread[k]; dropped = true; }
    }
  }
  if (dropped) { saveRead(); saveKept(); saveUserUnread(); }
}
async function loadConsolidatedIntoState() {
  try {
    const allData = await fetchJson('data/all-feeds.json');
    // An EMPTY articles array is valid (every feed has zero articles) — only a
    // malformed payload falls back to per-feed files. And every configured
    // feed gets an entry (even empty): a feed with no articles used to look
    // "not loaded", so every search and mark re-downloaded all-feeds.json.
    if (!Array.isArray(allData?.articles) || !state.index?.feeds) return false;
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
    }
    for (const id of Object.keys(state.index.feeds)) {
      if (!state.feeds.has(id)) state.feeds.set(id, []); // zero-article feed: exists, settled
      state.settled.add(id);
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
    pruneReadState();
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
    // Clamp a stored sidebar width: the drag path clamps 210–480, the boot
    // path used to apply any stale garbage unclamped (broken layout).
    if (ui.sidebarW) {
      const w = Math.min(480, Math.max(210, Number(ui.sidebarW) || 242));
      ui.sidebarW = w;
      document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
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
  syncControls();
  renderAll();
  flashUpdated();
  await ensureLoadedForScope();
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
