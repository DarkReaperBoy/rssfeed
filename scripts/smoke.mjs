// Smoke test: boot the real UI (index.html + app.js) in jsdom against
// deterministic in-memory fixtures
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
  settings: { siteName: 'My Inoreader', theme: 'auto', view: 'list', refreshMinutes: 60 },
  folders: [{ id: 'tech', name: 'Technology' }, { id: 'news', name: 'News' }],
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
  feeds: Object.fromEntries(Object.entries(FIX).map(([id, f]) => [id, {
    title: f.title, site: f.site, folder: f.folder, folders: [f.folder],
    count: f.articles.length, newest: f.articles[0].date, oldest: f.articles.at(-1).date,
  }])),
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

console.log('boot');
ok(!$('#feeds_nav').classList.contains('hidden'), 'feeds panel visible');
ok(!!$('.tree-item[data-scope="all"]'), 'Newsfeed row renders');
ok($('#pdinner_today').classList.contains('hidden'), 'Today row hidden by default');
ok($('#tree').textContent.includes('Technology'), 'folder renders');
ok($('#tree').textContent.includes('Hacker News'), 'feeds render');
ok($('#reader-placeholder').textContent.includes('Select an article'), 'reader placeholder present');

console.log('list + filter');
let rows = $$('#list .row');
ok(rows.length === TOTAL - HIDDEN, `rows rendered (${rows.length})`);
ok($$('#list .row').filter((r) => r.querySelector('.feed-name')?.textContent === 'Hacker News' && /show hn/i.test(r.querySelector('.row-title').textContent)).length === 0, 'exclude filter hides matching articles');

console.log('reading');
const firstId = $('#list .row').dataset.id;
click($('#list .row'));
await settle(50);
ok(!!$('#reader-slot .reader-body'), 'article opens');
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'opening marks read');

console.log('mark unread');
click('#reader-slot [data-act="reader-menu"]');
await settle(20);
click('#row-menu [data-act="toggle-read"]');
await settle(50);
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN, 'mark unread restores count');

console.log('mark-all split');
click('#btn-mark-all-split');
await settle(20);
ok(!$('#mark-menu').classList.contains('hidden'), 'mark menu opens');
click('#mark-menu [data-older="1"]');
await settle(50);
click($('#toast-action'));
await settle(50);

console.log('search');
click('#search-open');
await settle(20);
ok(!$('#search-box').classList.contains('hidden'), 'search expands');

console.log('layouts');
const layoutBtns = $$('#layouts [data-layout]');
ok(layoutBtns.length >= 3, 'layout buttons present');
const origLayout = layoutBtns.find(b=>b.classList.contains('active'))?.dataset.layout;
click('#layouts [data-layout="expanded"]');
await settle(50);
ok($('#list').classList.contains('view-expanded'), 'expanded layout applies');
click('#layouts [data-layout="cards"]');
await settle(50);
ok($('#list').classList.contains('view-cards'), 'cards layout applies');
click('#layouts [data-layout="column"]');
await settle(50);
ok($('#list').classList.contains('view-column'), 'column layout applies');
click('#layouts [data-layout="magazine"]');
await settle(50);
ok($('#list').classList.contains('view-magazine'), 'magazine layout applies');
click('#layouts [data-layout="list"]');
await settle(50);
ok($('#list').classList.contains('view-list'), 'list layout restored');

console.log('header menus');
click('#btn-more');
await settle(30);
ok(!$('#header-menu').classList.contains('hidden'), 'header menu opens');
click('#btn-more');
await settle(20);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
