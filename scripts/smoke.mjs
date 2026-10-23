// Smoke test: boot the real UI (index.html + app.js) in jsdom against
// deterministic in-memory fixtures.
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/* ---- fixtures ---- */
const now = Date.now();
const H = 3600e3;
const mkArticles = (feedId, titles) =>
  titles.map((t, i) => ({
    id: `${feedId}-${i}`, title: t, link: `https://example.com/${feedId}/${i}`,
    date: now - i * 3 * H - 5 * 60e3, author: 'Fixture Author',
    summary: `Summary for ${t}`, content: `<p>Body of ${t} with <b>markup</b>.</p>`,
    text: null, enclosures: [], fetchedAt: now,
  }));

const FIX = {
  'fixture-hn': {
    title: 'Hacker News', site: 'https://news.ycombinator.com', folder: 'tech',
    articles: mkArticles('fixture-hn', [
      'Show HN: spammy thing', 'AI model beats benchmark', 'Show HN: another spam',
      'Rust 2.0 released', 'Postgres 18 ships', 'New JS runtime',
      'Linux 7.0 out', 'Compiler optimizations', 'Open source drama',
      'WebGPU everywhere', 'Containers explained', 'Vim vs Emacs again',
    ]),
  },
  'fixture-verge': {
    title: 'The Verge', site: 'https://www.theverge.com', folder: 'tech',
    articles: mkArticles('fixture-verge', ['Phone review', 'Laptop preview', 'AI gadget', 'EV news', 'Space launch']),
  },
  'fixture-bbc': {
    title: 'BBC News', site: 'https://www.bbc.com/news', folder: 'news',
    articles: mkArticles('fixture-bbc', ['Election update', 'Climate summit', 'Market swing', 'Sports final', 'Tech regulation']),
  },
};

const config = {
  // theme is a config-owned pref with no UI toggle — it must apply on EVERY load.
  settings: { siteName: 'My RSSFeed', theme: 'dark', view: 'list', refreshMinutes: 60, markReadOnOpen: true },
  folders: [], // folder names come from the generated index.json (as with feeds.opml)
  feeds: [
    { id: 'fixture-hn', title: 'Hacker News', url: 'https://hnrss.test/frontpage', site: 'https://news.ycombinator.com', folder: 'tech' },
    { id: 'fixture-verge', title: 'The Verge', url: 'https://theverge.test/rss', site: 'https://www.theverge.com', folder: 'tech' },
    { id: 'fixture-bbc', title: 'BBC News', url: 'https://bbc.test/rss', site: 'https://www.bbc.com/news', folder: 'news' },
  ],
  filters: [{
    id: 'test-filter', name: 'test', feeds: ['fixture-hn'],
    exclude: { title: ['show hn'] }, actions: { hide: true },
  }],
};
const index = {
  generatedAt: now,
  folders: [{ id: 'tech', name: 'Technology' }, { id: 'news', name: 'News' }],
  feeds: Object.fromEntries(Object.entries(FIX).map(([id, f]) => [id, {
    title: f.title, site: f.site, folder: f.folder, folders: [f.folder],
    count: f.articles.length, newest: f.articles[0].date, oldest: f.articles.at(-1).date,
  }])),
};
const allFeeds = {
  articles: Object.entries(FIX).flatMap(([id, f]) => f.articles.map((a) => ({ ...a, _feed: id }))),
};
const TOTAL = Object.values(FIX).reduce((n, f) => n + f.articles.length, 0);
const HIDDEN = 2;

const html = (await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'))
  .replace(/<script src="assets\/app\.js\?v=\d+"><\/script>/, '');
const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

let dataFlip = false; // flipped during the sync test: the mock "publishes" new data
window.fetch = async (url) => {
  const p = String(url).split('?')[0];
  if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
  if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(dataFlip ? { ...index, generatedAt: now + 45 * 60000 } : index) };
  if (p === 'data/all-feeds.json') {
    const payload = dataFlip
      ? { articles: [...allFeeds.articles, { ...allFeeds.articles[0], id: 'fixture-hn-fresh', title: 'Fresh synced story', date: now + 40 * 60000, summary: 'Fresh synced story' }] }
      : allFeeds;
    return { ok: true, status: 200, json: async () => structuredClone(payload) };
  }
  const m = p.match(/^data\/feeds\/(.+)\.json$/);
  if (m && FIX[m[1]]) return { ok: true, status: 200, json: async () => structuredClone({ articles: FIX[m[1]].articles }) };
  return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
};

const appSrc = await fs.readFile(path.join(ROOT, 'assets/app.js'), 'utf8');
window.eval(appSrc);
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
await settle(1200);

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const click = (elOrSel) => {
  const el = typeof elOrSel === 'string' ? $(elOrSel) : elOrSel;
  if (!el) throw new Error(`click target missing: ${elOrSel}`);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
const rowCount = () => $$('#list .row').length;

console.log('boot');
ok(!$('#feeds_nav').classList.contains('hidden'), 'feeds panel visible');
ok(!!$('.tree-item[data-scope="all"]'), 'Newsfeed row renders');
ok(!$('#parent_starred'), 'Starred sidebar row removed');
ok(!$('#i-star'), 'star icon removed');
ok($('#pdinner_today').classList.contains('hidden'), 'Today row hidden by default');
ok($('#tree').textContent.includes('Technology'), 'folder renders (from generated index.folders)');
ok($('#tree').textContent.includes('Hacker News'), 'feeds render');
ok(!$('#reader-placeholder'), 'reader placeholder removed');
ok(window.document.documentElement.dataset.theme === 'dark', 'config settings apply on every load (theme)');
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN, 'unread badge counts all feeds');

console.log('list + filter');
let rows = $$('#list .row');
ok(rows.length === TOTAL - HIDDEN, `rows rendered (${rows.length})`);
ok(!$$('#list .row .dot').length, 'blue unread dot removed');
ok(!$$('#list .row .star-btn').length, 'star buttons removed');
ok($$('#list .row [data-act="toggle-read"]').length === rows.length, 'every row has the read/unread tick');
ok($$('#list .row [data-act="keep"]').length === rows.length, 'every row has keep-unread');
ok($$('#list .row').filter((r) => r.querySelector('.feed-name')?.textContent === 'Hacker News' && /show hn/i.test(r.querySelector('.row-title').textContent)).length === 0, 'exclude filter hides matching articles');

console.log('reading');
const firstRow = $('#list .row');
const firstId = firstRow.dataset.id;
const firstLink = firstRow.querySelector('[data-act="open-original"]').getAttribute('href');
click(firstRow);
await settle(50);
ok(!!$('#reader-slot .reader-body'), 'article opens');
ok($('#reader-slot .reader-title a')?.href === firstLink, 'reader title links to the original article');
ok($('#list .row').classList.contains('expanded'), 'open row is highlighted in the list');
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'opening marks read');
ok(window.location.hash === `#article/${firstId}`, 'opening an article puts its id in the URL (#article/<id>)');

console.log('double-click keeps the read row');
click($('#list .row')); // same row again → collapse
await settle(50);
ok(!window.document.body.classList.contains('article-open'), 'reader closed');
ok(rowCount() === TOTAL - HIDDEN, 'double-clicked article stays in the list (marked read, not removed)');
ok(!$('#list .row').classList.contains('unread'), 'the row now shows as read');
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'badge unchanged by the collapse');
ok(!window.location.hash, 'collapsing the reader clears the hash (no history spam)');

console.log('moving on re-filters the read row');
const secondRow = $$('#list .row')[1];
const secondId = secondRow.dataset.id;
click(secondRow);
await settle(50);
ok(rowCount() === TOTAL - HIDDEN - 1, 'previously read article disappears when moving on');
ok(!$(`#list .row[data-id="${firstId}"]`), 'old row is gone from the list');
ok(window.document.body.classList.contains('article-open'), 'new article is selected');

console.log('browser Back/Forward (deep-link history)');
window.location.hash = `#article/${firstId}`; // Back = the previous article's hash
window.dispatchEvent(new window.Event('hashchange')); // idempotent if jsdom already fired it
await settle(50);
ok($('#reader-slot .reader')?.dataset.id === firstId, 'Back reopens the previous article');
ok($(`#list .row[data-id="${firstId}"]`), 'Backed-into article is in the list again (it was read)');
window.location.hash = `#article/${secondId}`; // Forward
window.dispatchEvent(new window.Event('hashchange'));
await settle(50);
ok($('#reader-slot .reader')?.dataset.id === secondId, 'Forward returns to the next article');

console.log('popstate-driven navigation (WebView hardening)');
window.location.hash = `#article/${firstId}`;
window.dispatchEvent(new window.Event('popstate')); // environments that miss hashchange still sync via popstate
await settle(50);
ok($('#reader-slot .reader')?.dataset.id === firstId, 'popstate-driven Back reopens the article');
window.location.hash = `#article/${secondId}`;
window.dispatchEvent(new window.Event('popstate'));
await settle(50);
ok($('#reader-slot .reader')?.dataset.id === secondId, 'popstate-driven Forward returns to the article');

console.log('mark unread');
click(`#list .row[data-id="${secondId}"] [data-act="toggle-read"]`);
await settle(50);
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'mark unread restores count (the first article stays read)');

console.log('mark-all split');
click('#btn-mark-all-split');
await settle(20);
ok(!$('#mark-menu').classList.contains('hidden'), 'mark menu opens');
click('#mark-menu [data-mark="read"][data-older="1"]');
await settle(80);
ok($('#toast-text').textContent.includes('3 article'), 'older-than-a-day marks exactly 3 articles');
ok(rowCount() === TOTAL - HIDDEN - 3, 'marked articles re-filter out — the open one stays pinned in place');
click($('#toast-action'));
await settle(50);
ok(rowCount() === TOTAL - HIDDEN - 1, 'undo restores the rows');

console.log('mark-as-unread by age — explicit group, no caught-up requirement');
// The user bug: "older than" silently dispatched by a hidden mode that only
// flipped when everything was read. The menu is now explicit — restoring by
// age must work right here, while most articles are still UNREAD.
ok($('#btn-mark-all').title === 'Mark all as read', 'scope is NOT caught up (newer articles still unread)');
ok($$('#mark-menu [data-mark="read"]').length === 4, 'explicit "Mark as read" age group present');
ok($$('#mark-menu [data-mark="unread"]').length === 4, 'explicit "Mark as unread" age group present');
ok(!!$('#mark-date-unread') && !!$('#mark-date-read'), 'custom "Before…" date pickers present');
click('#btn-mark-all-split');
await settle(20);
click('#mark-menu [data-mark="unread"][data-older="1"]');
await settle(80);
ok($('#toast-text').textContent.includes('older than a day as unread'), 'unread-older-than restores while NOT caught up');
ok($('#toast-text').textContent.includes('1 article'), 'restores exactly the one read day-old article');
ok(rowCount() === TOTAL - HIDDEN, 'the restored article is back in the unread view');
click($('#toast-action'));
await settle(50);
ok(rowCount() === TOTAL - HIDDEN - 1, 'undo puts the state back');

console.log('search');
click('#search-open');
await settle(20);
ok(!$('#search-box').classList.contains('hidden'), 'search expands');
const sinput = $('#search-input');
sinput.value = 'AI model';
sinput.dispatchEvent(new window.Event('input', { bubbles: true }));
await settle(400);
ok(rowCount() === 1, 'search narrows rows');
click('#search-close');
await settle(50);
ok(rowCount() === TOTAL - HIDDEN - 1, 'closing search clears the active filter');
ok($('#search-input').value === '', 'search input cleared');

console.log('layouts');
const layoutBtns = $$('#layouts [data-layout]');
ok(layoutBtns.length === 5, 'all five layout buttons present');
for (const l of ['expanded', 'cards', 'column', 'magazine', 'list']) {
  click(`#layouts [data-layout="${l}"]`);
  await settle(50);
  ok($('#list').classList.contains(`view-${l}`), `${l} layout applies`);
}

console.log('header menus');
click('#btn-more');
await settle(30);
ok(!$('#header-menu').classList.contains('hidden'), 'header menu opens');
click('#btn-more');
await settle(20);

console.log('bulk select');
click('#menu-select-mode');
await settle(20);
ok(window.document.body.classList.contains('bulk-mode'), 'bulk mode toggles on');
click($$('#list .row')[1]);
await settle(20);
ok($('#bulk-count').textContent === '1', 'row click selects in bulk mode');
click('#bulk-read');
await settle(50);
ok(rowCount() === TOTAL - HIDDEN - 2, 'bulk mark read removes the row from the unread view');
ok($('#toast-text').textContent.includes('1 article'), 'bulk toast reports the count');
click($('#toast-action'));
await settle(50);
click('#menu-select-mode');
await settle(20);
ok(!$$('#list .row-check').length, 'bulk mode toggles off');

console.log('reset read state (menu)');
click('#btn-more');
await settle(20);
click('#menu-reset-read');
await settle(20);
ok(!$('#confirm-modal').classList.contains('hidden'), 'reset read state asks for confirmation');
click('#confirm-yes');
await settle(50);
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN, 'reset makes every article unread');
ok(window.localStorage.getItem('ghrss:read') === '{}', 'stored read state is emptied');
ok(window.localStorage.getItem('ghrss:kept') === '{}', 'stored keep-unread state is emptied');

console.log('tab title format');
const tRow = $('#list .row');
const tTitle = tRow.querySelector('.row-title').textContent;
ok($('#badge-all-items').dataset.markread === 'all', 'Newsfeed badge is a working mark-all tick');
ok($('#badge-today').dataset.markread === 'today', 'Today badge is a mark-read tick');
const unreadBefore = Number($('#badge-all-items').textContent);
click(tRow);
await settle(50);
ok(window.document.title === `(${unreadBefore - 1}) My RSSFeed - ${tTitle}`, 'open article → "(N) My RSSFeed - Article title"');
await settle(20);
click($('#list .row')); // collapse
await settle(50);
ok(window.document.title === `(${unreadBefore - 1}) My RSSFeed`, 'closing → back to "(N) My RSSFeed"');
ok(!!$('#last-updated a[href="https://github.com/DarkReaperBoy/rssfeed"]'), 'sidebar footer credits the project');
ok($('#last-updated-text').textContent.includes('Updated'), 'updated line still shows under the credit');

console.log('mark-all ⇄ mark-as-unread toggle (same button)');
const rowsBeforeMarkAll = rowCount();
click('#badge-all-items');
await settle(50);
ok(rowCount() === 0, 'badge tick marks the whole Newsfeed read');
ok($('#empty').textContent.includes('All caught up'), 'empty state says "All caught up 🎉"');
ok(!!$('#empty .empty-hint'), 'caught-up hint points at the flipped button');
ok($('#btn-mark-all').title === 'Mark all as unread', 'the SAME button flips to "Mark all as unread"');
ok($$('#mark-menu .mark-label')[0].textContent === 'Mark as read', 'menu keeps its explicit read group while caught up');
ok($$('#mark-menu .mark-label')[1].textContent === 'Mark as unread', 'menu keeps its explicit unread group while caught up');
click('#btn-mark-all');
await settle(20);
ok(!$('#confirm-modal').classList.contains('hidden'), 'mark-as-unread asks for confirmation');
click('#confirm-yes');
await settle(50);
ok(rowCount() === rowsBeforeMarkAll, 'mark as unread restores every article');
ok($('#toast-text').textContent.includes('articles as unread'), 'restore toast reports the count');
ok($('#btn-mark-all').title === 'Mark all as read', 'button flips back once articles are unread');

click('#badge-all-items'); // everything read again
await settle(50);
ok(rowCount() === 0, 'badge tick re-marks everything read');
click('#btn-mark-all-split');
await settle(20);
click('#mark-menu [data-mark="unread"][data-older="1"]');
await settle(80);
ok($('#toast-text').textContent.includes('older than a day as unread'), 'older-than items restore by age in unread mode');
ok(rowCount() === 4, 'only the day-old articles came back unread');
click('#btn-mark-all'); // 4 unread left → read mode again
await settle(20);
click('#confirm-yes');
await settle(50);
ok(rowCount() === 0, 'the 4 restored are marked read again');
click('#btn-mark-all'); // caught up → the full restore
await settle(20);
click('#confirm-yes');
await settle(50);
ok(rowCount() === rowsBeforeMarkAll, 'back to unread after the second restore');

console.log('custom "Before…" date picker');
click('#badge-all-items'); // everything read again
await settle(50);
ok(rowCount() === 0, 'badge tick re-marks everything read for the date test');
const t = new Date(now + 864e5);
const dstr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
const dinp = $('#mark-date-unread');
dinp.value = dstr; // "before tomorrow" = every article
dinp.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle(120);
ok($('#toast-text').textContent.includes('as unread'), 'date picker action runs');
ok($('#toast-text').textContent.includes(new Date(`${dstr}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })), 'toast names the picked date');
ok(rowCount() === rowsBeforeMarkAll, '"before tomorrow" restores every read article');

click('#btn-mark-all-split');
await settle(20);
click('#mark-menu [data-mark="read"][data-older="31"]');
await settle(120);
ok($('#toast-text').textContent.includes('No unread articles older than a month here'), 'read-side zero toast explains itself');
ok(rowCount() === rowsBeforeMarkAll, 'a month cutoff matches nothing in the fixtures (all within ~2 days)');

console.log('j/k keyboard navigation');
const idsNow = $$('#list .row').map((r) => r.dataset.id);
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
await settle(80);
ok($('#reader-slot .reader')?.dataset.id === idsNow[0], 'j opens the first visible article when nothing is open');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
await settle(80);
ok($('#reader-slot .reader')?.dataset.id === idsNow[1], 'j again moves to the next article');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await settle(60);
ok(!window.document.body.classList.contains('article-open'), 'Escape closes the reader');
// open a row further down; k must walk back to the unread article above it
const rowsMid = $$('#list .row').map((r) => r.dataset.id);
click(`#list .row[data-id="${rowsMid[3]}"]`);
await settle(60);
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
await settle(80);
ok($('#reader-slot .reader')?.dataset.id === rowsMid[2], 'k walks back to the unread article above');

click('#btn-mark-all-split');
await settle(20);
const emptyDate = $('#mark-date-unread');
emptyDate.value = '';
emptyDate.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle(80);
ok(!$('#mark-menu').classList.contains('hidden'), 'an empty date pick is a no-op (menu stays)');

console.log('sync: refresh picks up new data + announces it');
const rowsBeforeSync = rowCount();
dataFlip = true;
click('#menu-refresh');
await settle(500);
ok($('#toast-text').textContent.includes('1 new article synced'), 'refresh announces the synced article');
ok($('#last-updated-text').textContent.includes('just now'), 'updated line refreshes');
ok(rowCount() === rowsBeforeSync + 1, 'the fresh article appears in the list');
dataFlip = false;
click('#menu-refresh');
await settle(500);
ok($('#toast-text').textContent.includes('Already up to date'), 'manual refresh with unchanged data says "Already up to date"');
ok(rowCount() === rowsBeforeSync, 'state settles back to the fixture data');
click('#btn-mark-all-split');
await settle(20);
const dinp2 = $('#mark-date-unread');
dinp2.value = dstr; // "before tomorrow" = every article again
dinp2.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle(120);
ok(rowCount() === rowsBeforeMarkAll, '"before tomorrow" restore clears the navigation reads before the folder test');

console.log('folder click selects, chevron expands');
const folderSel = '#tree .tree-folder .tree-item[data-folder="tech"]';
click(folderSel);
await settle(50);
let fRow = $(folderSel);
ok($('#scope-title').textContent === 'Technology', 'clicking a folder selects it');
ok(!fRow.closest('.tree-folder').classList.contains('open'), 'selecting the folder does NOT expand it');
ok(rowCount() === 15, 'folder view shows its feeds\' articles');
click(fRow.querySelector('.chev'));
await settle(50);
fRow = $(folderSel);
ok(fRow.closest('.tree-folder').classList.contains('open'), 'the chevron toggle expands the folder');
ok($$('#tree .tree-folder.open .tree-children .tree-item').length === 2, 'feed rows visible inside the folder');
ok($('#scope-title').textContent === 'Technology', 'expanding keeps the folder selected');
click($(folderSel).querySelector('.chev'));
await settle(50);
ok(!$(folderSel).closest('.tree-folder').classList.contains('open'), 'chevron collapses the folder');
ok($('#scope-title').textContent === 'Technology', 'collapsing keeps the folder selected');
click('.tree-item[data-scope="all"]'); // back to the Newsfeed
await settle(50);

console.log('refresh/restore: boot with #article/<id> in the URL');
{
  const dom2 = new JSDOM(html, { url: 'https://example.test/#article/fixture-hn-3', runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.fetch = window.fetch; // same deterministic fixture backend
  w2.eval(appSrc);
  w2.document.dispatchEvent(new w2.Event('DOMContentLoaded', { bubbles: true }));
  await settle(1200);
  const reader2 = w2.document.querySelector('#reader-slot .reader');
  ok(!!reader2 && reader2.dataset.id === 'fixture-hn-3', 'refresh reopens the article from the URL hash');
  ok(w2.document.querySelector('#reader-slot .reader-title a')?.href === 'https://example.com/fixture-hn/3', 'the restored article is the right one');
  ok(Number(w2.document.querySelector('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'hash-restore marks it read exactly like a click');
  ok(w2.location.hash === '#article/fixture-hn-3', 'the hash survives boot');
  dom2.window.close();
}

console.log('feed-storage version reset');
{
  const dom3 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w3 = dom3.window;
  w3.fetch = window.fetch;
  // a pre-version browser shows up with old feed state and UI prefs
  w3.localStorage.setItem('ghrss:read', JSON.stringify({ 'fixture-hn-0': 123 }));
  w3.localStorage.setItem('ghrss:kept', JSON.stringify({ 'fixture-hn-1': true }));
  w3.localStorage.setItem('ghrss:ui', JSON.stringify({ layout: 'cards', sortDir: 'newest' }));
  w3.eval(appSrc);
  w3.document.dispatchEvent(new w3.Event('DOMContentLoaded', { bubbles: true }));
  await settle(1200);
  ok(!Object.keys(JSON.parse(w3.localStorage.getItem('ghrss:read') || '{}')).length, 'old-version feed storage is wiped on upgrade');
  ok(w3.localStorage.getItem('ghrss:ver') === '3', 'the storage version is recorded');
  ok(Number(w3.document.querySelector('#badge-all-items').textContent) === TOTAL - HIDDEN, 'all articles unread after the one-time reset');
  ok(w3.document.querySelector('#list').classList.contains('view-cards'), 'UI prefs survive the feed-storage reset');
  dom3.window.close();
}
{
  const dom4 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w4 = dom4.window;
  w4.fetch = window.fetch;
  w4.localStorage.setItem('ghrss:ver', '3'); // already on this version
  w4.localStorage.setItem('ghrss:read', JSON.stringify({ 'fixture-hn-3': 123 }));
  w4.eval(appSrc);
  w4.document.dispatchEvent(new w4.Event('DOMContentLoaded', { bubbles: true }));
  await settle(1200);
  ok(Number(w4.document.querySelector('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'same-version storage is kept (no re-reset)');
  dom4.window.close();
}

console.log('YouTube shorts detection (fetch.mjs)');
{
  const fetchMod = await import('./fetch.mjs');
  ok(fetchMod.isShortItem('https://www.youtube.com/shorts/abc', 'Whatever', '') === true, '/shorts/ link detected');
  ok(fetchMod.isShortItem('https://www.youtube.com/shorts/abc', 'Old cached short', '<p>stored content</p>') === true, 'previously STORED shorts (merge purge) are detected by link');
  ok(fetchMod.isShortItem('https://www.youtube.com/watch?v=abc', 'Old cached video', '<p>stored content with #shorts</p>') === true, 'previously stored #shorts-tagged articles are purged too');
  ok(fetchMod.isShortItem('https://www.youtube.com/watch?v=abc', 'Real video', '<p>stored content</p>') === false, 'regular stored articles survive the merge purge');
  ok(fetchMod.isShortItem('https://www.youtube.com/watch?v=abc', 'My #SHORTS video', '') === true, '#shorts tag detected (case-insensitive)');
  ok(fetchMod.isShortItem('https://www.youtube.com/watch?v=abc', 'try #short thing', '') === true, '#short tag detected');
  ok(fetchMod.isShortItem('https://www.youtube.com/watch?v=abc', 'Short film review', 'in short, no') === false, 'plain "short" text is not a Short');
  ok(fetchMod.isShortItem('https://www.youtube.com/watch?v=abc', '#shortfilm festival', '') === false, '#shortfilm is not #short(s)');
  ok(fetchMod.isShortItem('https://www.youtube.com/watch?v=abc', 'normal video', 'plain description') === false, 'regular videos pass');
}

console.log('per-feed ingest word filters (fetch.mjs)');
{
  const fetchMod = await import('./fetch.mjs');
  const blocks = {
    include: fetchMod.compileBlockSrv({ title: ['thinkpad'] }),
    exclude: fetchMod.compileBlockSrv({ title: ['/\\bgeneric\\b/'] }),
  };
  const art = (title, content = 'x') => ({ title, content, author: null, link: 'https://example.com/a' });
  ok(fetchMod.feedFilterDrop(art('Thinkpad deals'), blocks) === false, 'include match passes');
  ok(fetchMod.feedFilterDrop(art('Linux thread'), blocks) === true, 'include miss is dropped');
  ok(fetchMod.feedFilterDrop(art('thinkpad but generic mousepad'), blocks) === true, 'exclude match is dropped');
  ok(fetchMod.feedFilterDrop(art('Thinkpad deals'), { include: fetchMod.compileBlockSrv({ title: ['thinkpad'], content: ['/deal/'] }), exclude: null }) === true, 'AND across fields: content miss drops');
  ok(fetchMod.feedFilterDrop(art('Thinkpad deals', 'big deal content'), { include: fetchMod.compileBlockSrv({ title: ['thinkpad'], content: ['/deal/'] }), exclude: null }) === false, 'AND across fields: both match passes');
}

console.log('4chan catalog → articles (4chan.mjs)');
{
  const chan = await import('./4chan.mjs');
  const t = (o) => ({ no: 100, time: 1745000000, name: 'Anonymous', com: '>>99<br>check this out', ...o });
  const catalog = [{ threads: [
    t({ no: 101, replies: 299, sub: 'small thread' }),
    t({ no: 102, replies: 301, sticky: 1, sub: 'sticky mega' }),
    t({ no: 103, replies: 350, closed: 1, sub: 'closed one' }),
    t({ no: 104, replies: 800, sub: 'Thinkpad thread', com: 'my &amp; keyboard<br>line two', tim: 1745000000123, ext: '.png', images: 12 }),
    t({ no: 105, replies: 400, sub: 'generic thread' }),
    t({ no: 106, replies: 600, com: 'pc building thread edition<br>op post' }),
  ] }, { threads: [] }, { threads: null }];
  const threads = chan.chanThreadsFromCatalog(catalog);
  ok(threads.length === 6, 'catalog pages flatten (junk pages tolerated)');
  const passes = (opts) => threads.filter((x) => chan.chanThreadPasses(x, opts)).map((x) => x.no);
  ok(JSON.stringify(passes({ minReplies: 300 })) === '[104,105,106]', 'minReplies window; sticky + closed skipped by default');
  ok(JSON.stringify(passes({ minReplies: 300, includeSticky: true })) === '[102,104,105,106]', 'includeSticky opt-in');
  ok(JSON.stringify(passes({ minReplies: 300, maxReplies: 500 })) === '[105]', 'maxReplies caps the window');
  ok(JSON.stringify(passes({ minReplies: 300, minImages: 5 })) === '[104]', 'minImages window');
  const a = chan.chanThreadToArticle(threads[3], { board: 'g', worksafe: true, now: 1746000000000 });
  ok(a.link === 'https://boards.4channel.org/g/thread/104', 'worksafe boards link to 4channel.org');
  ok(a.title === 'Thinkpad thread', 'title from the thread subject');
  ok(a.summary.includes('keyboard'), 'summary from the OP comment');
  ok(a.content.includes('800 replies') && a.content.includes('/g/thread/104'), 'content carries thread stats + link');
  ok(a.enclosures.length === 1 && a.enclosures[0].url === 'https://i.4cdn.org/g/1745000000123s.jpg' && a.enclosures[0].type === 'image/thumbnail', 'thumbnail enclosure for row thumbs');
  ok(a.author === null, 'Anonymous posts carry no author');
  ok(a.id === chan.chanThreadToArticle(threads[3], { board: 'g', worksafe: true, now: 1 }).id, 'thread ids are stable across fetches');
  ok(chan.chanThreadToArticle(threads[3], { board: 't', worksafe: false }).link.startsWith('https://boards.4chan.org/t/'), 'non-worksafe boards link to 4chan.org');
  const noSub = chan.chanThreadToArticle(threads[5], { board: 'g', worksafe: true });
  ok(noSub.title === 'pc building thread edition', 'no subject → first comment line is the title');
  const fetchMod = await import('./fetch.mjs');
  ok(fetchMod.feedFilterDrop(noSub, { include: fetchMod.compileBlockSrv({ title: ['building'] }), exclude: fetchMod.compileBlockSrv({ title: ['megathread'] }) }) === false, 'word filters work on 4chan threads (include+exclude pass)');
  ok(fetchMod.feedFilterDrop(noSub, { include: null, exclude: fetchMod.compileBlockSrv({ title: ['edition'] }) }) === true, 'word filters drop matching 4chan threads');
}

console.log('Hacker News → articles (hackernews.mjs)');
{
  const hn = await import('./hackernews.mjs');
  const url = hn.hnApiUrl({ minPoints: 100, minComments: 100 }, { retentionDays: 30, now: 1746000000000 });
  ok(url.startsWith('https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters='), 'both caps → search_by_date over stories');
  ok(url.includes('points%3E%3D100') && url.includes('num_comments%3E%3D100'), 'both cap conditions present (AND on the server)');
  ok(url.includes('created_at_i%3E'), 'retention window bounds the query');
  const uPoints = hn.hnApiUrl({ minPoints: 100 }, { retentionDays: 30, now: 1746000000000 });
  ok(uPoints.includes('points%3E%3D100') && !uPoints.includes('num_comments'), 'only points set → comments condition omitted (ignore the unset cap)');
  const uComments = hn.hnApiUrl({ minComments: 50 }, { retentionDays: 30, now: 1746000000000 });
  ok(uComments.includes('num_comments%3E%3D50') && !uComments.includes('points'), 'only comments set → points condition omitted');
  ok(hn.hnApiUrl({}, {}) === 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=100', 'no caps → the live HN front page');
  const hit = { objectID: 50123456, title: 'Show HN: A & B <fast> tool', url: 'https://example.com/x', author: 'alice', points: 120, num_comments: 130, created_at: '2026-10-20T10:00:00Z', story_text: '<p>Hello &amp; welcome</p>' };
  const a = hn.hnHitToArticle(hit, { now: 1746000000000 });
  ok(a.id === hn.hnHitToArticle({ ...hit, points: 999, num_comments: 400, title: 'edited later' }, { now: 1 }).id, 'ids are objectID-based: edits/votes never rekey them');
  ok(a.title.includes('Show HN: A & B'), 'title HTML is flattened');
  ok(a.link === 'https://example.com/x', 'external url is the article link');
  ok(a.author === 'alice', 'author carried');
  ok(a.date === Date.parse('2026-10-20T10:00:00Z'), 'date parsed from created_at');
  ok(a.content.includes('120 points · 130 comments') && a.content.includes('Discuss on Hacker News'), 'stats line + discussion link in the body');
  ok(a.content.includes('Hello &amp; welcome'), 'story text passed through for the sanitize pipeline');
  const ask = hn.hnHitToArticle({ objectID: 50999, title: 'Ask HN: best distro?', points: 10, num_comments: 5, created_at: '2026-10-21T10:00:00Z' }, { now: 1746000000000 });
  ok(ask.link === 'https://news.ycombinator.com/item?id=50999', 'no-url stories (Ask HN) link to the HN item');
  ok(ask.summary.includes('10 points'), 'summary carries stats when there is no story text');
  const fetchMod2 = await import('./fetch.mjs');
  ok(fetchMod2.feedFilterDrop(a, { include: null, exclude: fetchMod2.compileBlockSrv({ title: ['show hn'] }) }) === true, 'word filters work on HN stories like any feed');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
dom.window.close();
process.exit(fail ? 1 : 0);
