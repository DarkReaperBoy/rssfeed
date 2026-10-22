/* ghrss — entire reader UI. Plain ES2020, no deps, no build step.
   Data: config.json + data/*.json from the repo (GitHub Actions refreshes hourly).
   State: localStorage (read map under ghrss:read, UI prefs under ghrss:ui). */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS_READ = 'ghrss:read', LS_KEPT = 'ghrss:kept', LS_UI = 'ghrss:ui', LS_STARRED = 'ghrss:starred';

const state = {
  config: null,
  index: null,
  feeds: new Map(),          // feedId -> articles[]
  feedErrors: new Map(),     // feedId -> error message
  scope: 'all',
  tab: 'feeds',
  railTab: 'feeds',
  search: '',
  expandedId: null,
  readerTab: 'description',
  menuId: null,
  visible: [],
  keepVisible: new Set(),
  read: loadObj(LS_READ),    // {articleId: readTs}
  kept: loadObj(LS_KEPT),    // {articleId: true} — "keep unread"
  starred: loadObj(LS_STARRED), // {articleId: feedId} — Saved → Starred (read later)
  filters: [],
  markTimers: new Map(),
  loading: new Set(),
  refreshTimer: null,
  bulkSel: new Set(),
};
const ui = Object.assign({
  theme: 'auto', layout: 'list', status: 'unread', dateRange: 'all',
  showFiltered: false, openFolders: {}, sidebarOpen: false,
  markReadOnOpen: true, markReadAfterSeconds: 0,
  density: 'comfort', sortDir: 'oldest',
  updatedOnly: false, dimRead: false, sortAZ: false, scrollTracking: false,
  titlesOnly: false, openOriginal: false, showFavicons: true, columnThumbs: true,
  bulkSelect: false, autoScroll: true, absoluteDates: false, fontSize: '14.5px',
  sideFavicons: true, compactSidebar: false, countersClickable: true, titleCounter: true, showToday: false,
}, loadObj(LS_UI));
// migrate pre-parity values
if (ui.layout === 'compact') { ui.layout = 'list'; ui.density = 'compact'; }

function loadObj(k) { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } }
function saveObj(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function saveRead() { saveObj(LS_READ, state.read); }
function saveKept() { saveObj(LS_KEPT, state.kept); }
function saveStarred() { saveObj(LS_STARRED, state.starred); }
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
  if (state.scope === 'starred') return [];
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
  if (state.scope === 'starred') {
    // Saved → Starred: every starred article, all statuses, newest first.
    for (const id of Object.keys(state.starred)) {
      const a = findArticle(id);
      if (a) out.push(a);
    }
    out.sort((x, y) => (ui.sortDir === 'oldest' ? 1 : -1) * (x.date - y.date));
    state.visible = out;
    return out;
  }
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
    const warnIcon = failed ? '<span class="feed-warn" title="' + esc(warnTitle.replace(/"/g, '&quot;')) + '">⚠</span>' : disabled ? '<span class="feed-warn feed-warn-dim" title="' + esc(warnTitle.replace(/"/g, '&quot;')) + '">⚠</span>' : '';
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
  $('#parent_all_articles').classList.toggle('selected_parent', state.scope === 'all');
  $$('[data-scope]').forEach((b) => b.classList.toggle('active', b.dataset.scope === state.scope));
}

function scopeTitle() {
  const s = state.scope;
  if (s === 'all') return 'Newsfeed';
  if (s === 'today') return 'Today';
  if (s === 'recently-read') return 'Recently read';
  if (s === 'starred') return 'Starred';
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
      <span class="dot"></span>
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
function readerBodyHtml(a, tab) {
  return `<div class="reader-body">${articleBody(a)}</div>`;
}
function readerHtml(a) {
  const feed = feedMeta(a._feed);
  const tab = state.readerTab || 'description';
  const idx = state.visible.indexOf(a);
  return `<div class="reader" data-id="${esc(a.id)}">
    <div class="reader-toolbar">
      <span class="spacer"></span>
      <button class="icon-btn" data-act="prev" title="Previous article" ${idx <= 0 ? 'disabled' : ''}><svg><use href="#i-prev"/></svg></button>
      <button class="icon-btn" data-act="next" title="Next article" ${idx >= state.visible.length - 1 ? 'disabled' : ''}><svg><use href="#i-next"/></svg></button>
      <a class="icon-btn" href="${esc(a.link || '#')}" target="_blank" rel="noopener noreferrer" title="Open original" data-act="open-original"><svg><use href="#i-external"/></svg></a>
      <button class="icon-btn" data-act="collapse" title="Close reader"><svg><use href="#i-close"/></svg></button>
    </div>
    <h2 class="reader-title">${esc(a.title)}</h2>
    <div class="reader-sub">
      <span class="sub-feed" data-scope="feed:${esc(a._feed)}" title="Show this feed">${esc(feed.title)}</span>
      ${a.author ? `<span>by ${esc(a.author)}</span>` : ''}
      <span title="${esc(fullTime(a.date))}">${esc(relTime(a.date))}</span>
    </div>
    ${readerBodyHtml(a, tab)}
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
  if (state.expandedId && !visible.some((a) => a.id === state.expandedId)) state.expandedId = null;
  list.innerHTML = visible.map((a) => {
    let row = rowHtml(a);
    if (ui.layout === 'expanded') row = row.replace('</article>', `<div class="row-body-inline">${articleBody(a)}</div></article>`);
    return row;
  }).join('');
  list.querySelectorAll('.row-body-inline').forEach((el) => { sanitizeReaderDom(el); upgradeEmbeds(el); });
  renderReaderPane(visible);
  setupScrollTracking();
  const unread = visible.filter((a) => !isRead(a)).length;
  $('#scope-title').textContent = scopeTitle();
  $('#scope-count').textContent = `${unread} unread`; // their header: "Newsfeed" + "81 unread"
  updateTitleCounter();
  renderEmpty(visible);
}
function renderReaderPane(visible) {
  // Split frame (ss1/ss3): list stays put, the article opens in the right pane.
  const slot = $('#reader-slot'), ph = $('#reader-placeholder');
  if (!slot || !ph) return;
  const open = state.expandedId ? findArticle(state.expandedId) : null;
  const show = !!(open && visible.includes(open) && !open._f?.hidden);
  if (show) {
    slot.innerHTML = readerHtml(open);
    slot.classList.remove('hidden');
    ph.classList.add('hidden');
    document.body.classList.add('article-open');
    slot.querySelectorAll('.reader-body').forEach((el) => { sanitizeReaderDom(el); upgradeEmbeds(el); });
  } else {
    slot.innerHTML = '';
    slot.classList.add('hidden');
    ph.classList.remove('hidden');
    document.body.classList.remove('article-open');
    if (!state.expandedId) state.readerTab = 'description';
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
  if (!ui.markReadOnOpen) return; // opening does not mark read when disabled
  const delay = (Number(ui.markReadAfterSeconds) || 0) * 1000;
  const run = () => {
    state.markTimers.delete(a.id);
    if (!isRead(a) && !isKept(a) && !a._f?.keepUnread) { state.read[a.id] = Date.now(); saveRead(); renderTree(); renderList(); }
  };
  if (delay <= 0) run();
  else state.markTimers.set(a.id, setTimeout(run, delay));
}
function collectScopeIds(scope, olderDays = 0) {
  let feedIds;
  const cutoff = olderDays ? Date.now() - olderDays * 864e5 : 0;
  if (scope === 'starred') return [];
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
  saveRead(); state.expandedId = null; renderTree(); renderList();
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
function dispatchAct(act, id, el, e) {
  const a = findArticle(id);
  if (!a) return;
  if (act === 'toggle-read') { forceAllowed = true; markRead(id, !isRead(a)); forceAllowed = false; }
  else if (act === 'hide-read') {
    forceAllowed = true; markRead(id, true); forceAllowed = false;
    if (state.expandedId === id) state.expandedId = null;
    renderList();
  }
  else if (act === 'keep') { if (state.kept[id]) delete state.kept[id]; else state.kept[id] = true; saveKept(); renderList(); }
  else if (act === 'copy-link') {
    if (a.link) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(a.link).then(() => showToast('Link copied to clipboard'));
        } else {
          const ta = document.createElement('textarea');
          ta.value = a.link; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
          showToast('Link copied to clipboard');
        }
      } catch (err) {
        showToast('Failed to copy link');
      }
    }
  }
  else if (act === 'open-original') { /* anchor handles it */ }
  else if (act === 'collapse') { state.expandedId = null; renderList(); }
  else if (act === 'prev' || act === 'next') {
    const i = state.visible.indexOf(a);
    const target = state.visible[act === 'prev' ? i - 1 : i + 1];
    if (target) {
      state.expandedId = target.id; state.readerTab = 'description';
      renderList(); scheduleMarkRead(target); listScrollTo(target.id);
    }
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
  if (ui.openOriginal && a.link) { // "Open original webpages directly"
    window.open(a.link, '_blank', 'noopener');
    scheduleMarkRead(a);
    return;
  }
  if (state.expandedId && state.expandedId !== id) state.keepVisible.add(state.expandedId);
  if (state.expandedId === id) { state.expandedId = null; renderList(); return; }
  state.expandedId = id;
  state.readerTab = 'description';
  renderList();
  listScrollTo(id);
  if (ui.autoScroll) { const ap = $('#article_pane'); if (ap) ap.scrollTop = 0; }
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
    if (!e.target.closest('#sidebar-menu') && !e.target.closest('#btn-sidebar-menu')) $('#sidebar-menu')?.classList.add('hidden');
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
      state.expandedId = null;
      state.keepVisible.clear();
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

  // ⋯ menu → article list status (their dropdown: All/Unread/Today/Recently read)
  $('#status-items').addEventListener('click', (e) => {
    const item = e.target.closest('[data-status]');
    if (!item) return;
    const v = item.dataset.status;
    if (v === 'today') state.scope = 'today';
    else if (v === 'recently-read') state.scope = 'recently-read';
    else { ui.status = v; if (state.scope !== 'all' && state.scope !== 'feed:' && !state.scope.startsWith('feed:') && !state.scope.startsWith('folder:')) state.scope = 'all'; }
    state.expandedId = null;
    saveUi(); syncControls(); renderAll(); ensureScopeLoaded();
    $('#header-menu').classList.add('hidden');
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
  $('#menu-select-mode').addEventListener('click', () => {
    ui.bulkSelect = !ui.bulkSelect; state.bulkSel.clear(); saveUi(); syncControls(); renderList();
  });
  $('#menu-refresh').addEventListener('click', () => { $('#header-menu').classList.add('hidden'); refresh(true); });

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
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearchFn(); });

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
  $('#btn-clear-read')?.addEventListener('click', () => {
    confirmDialog('Clear read state', 'Reset every article back to unread in this browser?', () => {
      state.read = {}; saveRead(); renderAll();
    });
  });
  $('#btn-export-state')?.addEventListener('click', () => {
    try {
      const data = {
        version: 1,
        exportedAt: Date.now(),
        read: state.read || {},
        kept: state.kept || {},
        starred: state.starred || {},
        ui: ui || {}
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ghrss-state-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('State exported');
    } catch (err) {
      showToast('Failed to export state');
    }
  });
  $('#btn-import-state')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.read && typeof data.read === 'object') { state.read = data.read; saveRead(); }
      if (data.kept && typeof data.kept === 'object') { state.kept = data.kept; saveKept(); }
      if (data.starred && typeof data.starred === 'object') { state.starred = data.starred; saveStarred(); }
      if (data.ui && typeof data.ui === 'object') { Object.assign(ui, data.ui); saveUi(); applyTheme(); syncControls(); applySidebarMode(); }
      renderAll();
      showToast('State imported');
    } catch (err) {
      showToast('Failed to import state');
    } finally {
      e.target.value = '';
    }
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
function openSearchFn() {
  $('#search-box').classList.remove('hidden');
  $('#search-open').classList.add('hidden');
  $('#search-input').focus();
}
function closeSearchFn() {
  $('#search-box').classList.add('hidden');
  $('#search-open').classList.remove('hidden');
}
function syncControls() {
  const status = state.scope === 'today' ? 'today' : state.scope === 'recently-read' ? 'recently-read' : state.scope === 'starred' ? 'all' : ui.status;
  $$('#status-items [data-status]').forEach((c) => c.classList.toggle('on', c.dataset.status === status));
  $$('#sort-items [data-sort]').forEach((c) => c.classList.toggle('on', c.dataset.sort === (ui.sortDir === 'oldest' ? 'oldest' : 'newest')));
  $$('#layouts [data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === ui.layout));
  $('#date-range').value = ui.dateRange;
  $('#btn-show-filtered').classList.toggle('on', ui.showFiltered);
  $('#menu-select-mode').classList.toggle('on', !!ui.bulkSelect);
  if ($('#set-theme')) $('#set-theme').value = ui.theme;
  if ($('#set-layout')) $('#set-layout').value = ui.layout;
  if ($('#set-density')) $('#set-density').value = ui.density || 'comfort';
  if ($('#set-markread')) $('#set-markread').checked = !!ui.markReadOnOpen;
  if ($('#set-markread-delay')) $('#set-markread-delay').value = ui.markReadAfterSeconds || 0;
  if ($('#set-scroll-tracking')) $('#set-scroll-tracking').checked = !!ui.scrollTracking;
  const bools = {
    '#set-titles-only': 'titlesOnly', '#set-open-original': 'openOriginal',
    '#set-show-favicons': 'showFavicons', '#set-column-thumbs': 'columnThumbs',
    '#set-bulk-select': 'bulkSelect', '#set-auto-scroll': 'autoScroll',
    '#set-absolute-dates': 'absoluteDates', '#set-side-favicons': 'sideFavicons',
    '#set-compact-sidebar': 'compactSidebar', '#set-counters-clickable': 'countersClickable',
    '#set-title-counter': 'titleCounter', '#set-show-today': 'showToday',
  };
  for (const [sel, key] of Object.entries(bools)) { const el = $(sel); if (el) el.checked = !!ui[key]; }
  if ($('#set-font-size')) $('#set-font-size').value = ui.fontSize || '14.5px';
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
    if (dirty) { saveRead(); renderTree(); renderList(); }
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
    // Prefer the consolidated single-request payload for speed.
    const consolidated = await loadConsolidatedIntoState();
    if (!consolidated) {
      // reload loaded feeds (new articles), keep the rest lazy
      const loaded = [...state.feeds.keys()];
      for (const id of loaded) { state.feeds.delete(id); await loadFeed(id); }
    }
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
    if (!localStorage.getItem(LS_UI)) { // seed defaults from config on first run
      if (s.theme) ui.theme = s.theme;
      if (s.view) ui.layout = s.view;
      ui.markReadOnOpen = s.markReadOnOpen !== false;
      ui.markReadAfterSeconds = Number(s.markReadAfterSeconds) || 0;
      // Allow any config setting that maps to a UI pref to act as a default.
      for (const [k, v] of Object.entries(s)) {
        if (Object.prototype.hasOwnProperty.call(ui, k) && k !== 'view') ui[k] = v;
      }
      saveUi();
    }
    baseTitle = state.config.settings?.siteName || 'My Inoreader';
    document.title = baseTitle;
    compileFilters();
    if (ui.sidebarW) document.documentElement.style.setProperty('--sidebar-width', `${ui.sidebarW}px`);
  } catch (err) {
    $('#empty').classList.remove('hidden');
    $('#empty').innerHTML = `<h3>Could not load config.json</h3><p>${esc(err.message)}. Make sure the repo is published to GitHub Pages and config.json exists at the root.</p>`;
    return;
  }
  try {
    state.index = await fetchJson('data/index.json');
    const consolidated = await loadConsolidatedIntoState();
    if (consolidated) console.log(`Loaded consolidated all-feeds.json`);
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
