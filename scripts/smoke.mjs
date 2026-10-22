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
  settings: { siteName: 'My Inoreader', theme: 'dark', view: 'list', refreshMinutes: 60, markReadOnOpen: true },
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
  .replace(/<script src="assets\/app.js"><\/script>/, '');
const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

window.fetch = async (url) => {
  const p = String(url).split('?')[0];
  if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
  if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
  if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(allFeeds) };
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

console.log('mark unread');
click(`#list .row[data-id="${secondId}"] [data-act="toggle-read"]`);
await settle(50);
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'mark unread restores count (the first article stays read)');

console.log('mark-all split');
click('#btn-mark-all-split');
await settle(20);
ok(!$('#mark-menu').classList.contains('hidden'), 'mark menu opens');
click('#mark-menu [data-older="1"]');
await settle(50);
ok($('#toast-text').textContent.includes('3 article'), 'older-than-a-day marks exactly 3 articles');
ok(rowCount() === TOTAL - HIDDEN - 4, 'marked articles re-filter out of the unread view');
click($('#toast-action'));
await settle(50);
ok(rowCount() === TOTAL - HIDDEN - 1, 'undo restores the rows');

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
  ok(w3.localStorage.getItem('ghrss:ver') === '2', 'the storage version is recorded');
  ok(Number(w3.document.querySelector('#badge-all-items').textContent) === TOTAL - HIDDEN, 'all articles unread after the one-time reset');
  ok(w3.document.querySelector('#list').classList.contains('view-cards'), 'UI prefs survive the feed-storage reset');
  dom3.window.close();
}
{
  const dom4 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w4 = dom4.window;
  w4.fetch = window.fetch;
  w4.localStorage.setItem('ghrss:ver', '2'); // already on this version
  w4.localStorage.setItem('ghrss:read', JSON.stringify({ 'fixture-hn-3': 123 }));
  w4.eval(appSrc);
  w4.document.dispatchEvent(new w4.Event('DOMContentLoaded', { bubbles: true }));
  await settle(1200);
  ok(Number(w4.document.querySelector('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'same-version storage is kept (no re-reset)');
  dom4.window.close();
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
dom.window.close();
process.exit(fail ? 1 : 0);
