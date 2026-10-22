// Smoke test: boot the real UI (index.html + app.js) in jsdom against
// deterministic in-memory fixtures — the production feed list is the 59-feed
// OPML import, so disk data would make this slow and network-dependent.
// Run: node scripts/smoke.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/* ---- the real config on disk must be the OPML import ---- */
const diskConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
ok(diskConfig.feeds.length >= 55, `config.json imported from OPML (${diskConfig.feeds.length} feeds)`);
ok(diskConfig.folders.length === 6, `config.json has 6 folders (${diskConfig.folders.map((f) => f.name).join(', ')})`);
ok(diskConfig.feeds.every((f) => f.id && f.url && f.folder), 'every feed has id/url/folder');

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
const TOTAL = Object.values(FIX).reduce((n, f) => n + f.articles.length, 0); // 22
const HIDDEN = 2; // "Show HN" fixtures excluded by the test filter

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
await settle(1200); // let queued feed loads finish

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const click = (elOrSel) => {
  const el = typeof elOrSel === 'string' ? $(elOrSel) : elOrSel;
  if (!el) throw new Error(`click target missing: ${elOrSel}`);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
const fire = (sel, val) => {
  const el = $(sel);
  if (typeof val === 'boolean') el.checked = val; else el.value = val;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
};

console.log('boot + 1:1 chrome (no duplicated nav)');
ok(!$('#feeds_nav').classList.contains('hidden'), 'feeds panel visible by default');
ok($('#saved_nav').classList.contains('hidden') && $('#automation_nav').classList.contains('hidden'), 'other panels hidden');
ok(!!$('.tree-item[data-scope="all"]') && $('.tree-item[data-scope="all"]').textContent.includes('Newsfeed'), 'system row Newsfeed renders');
ok($('#pdinner_today').classList.contains('hidden'), 'Today row hidden by default (their d-none)');
ok(!$('.tree-item[data-scope="unread"]'), 'NO duplicate Unread row in sidebar (rail is modules only)');
ok($$('#subscriptions_fieldset > .parent_div').length === 2, 'subscriptions fieldset = Today + Newsfeed only');
ok(!!$('#feeds_tab .tab-item.active') && !!$('#saved_tab') && !!$('#automation_tab') && !!$('#search_tab') && !!$('#add_feed_tab'), 'rail module tabs render');
ok(!!$('#audio_player_tab') && !!$('#notifications_tab') && !!$('#support_tab') && !!$('#btn-settings') && !!$('#dock-toggle'), 'bottom rail tabs render');
ok($('#tree').textContent.includes('Technology'), 'folder renders');
ok($('#tree').textContent.includes('Hacker News') && $('#tree').textContent.includes('BBC News'), 'feeds render');
const railCount = Number($('#feed_tab_counter').textContent);
ok(railCount === TOTAL - HIDDEN, `rail counter = unread total (${railCount})`);
ok(Number($('#badge-all-items').textContent) === railCount, 'Newsfeed badge matches rail counter');
ok($('#reader-placeholder').textContent.includes('Select an article from the list to be displayed here.'), 'split pane placeholder text (ss1)');
ok($('#reader-slot').classList.contains('hidden') && !$('#reader-placeholder').classList.contains('hidden'), 'reader slot empty until an article is selected');
ok(!!$('#scroll-up') && !!$('#scroll-down'), 'scroll up/down buttons render (ss1–ss3)');

console.log('list rendering + exclude filter');
let rows = $$('#list .row');
ok(rows.length === TOTAL - HIDDEN, `rows rendered (${rows.length})`);
ok(rows.every((r) => r.classList.contains('unread')), 'all rows unread initially');
ok($$('#list .row').filter((r) => r.querySelector('.feed-name')?.textContent === 'Hacker News' && /show hn/i.test(r.querySelector('.row-title').textContent)).length === 0, 'exclude filter hides matching articles');
ok($$('#list .row').some((r) => r.querySelector('.feed-name')?.textContent === 'Hacker News'), 'non-matching HN articles still visible');

console.log('reading + mark read');
const firstId = $('#list .row').dataset.id; // capture before click (mark-read moves the open row to the end)
click($('#list .row'));
await settle(50);
ok(!!$('#list .row.expanded'), 'selected row highlighted in list');
ok(!!$('#reader-slot .reader-body'), 'article opens in the right reader pane');
ok(!!$('#reader-slot .reader-title'), 'reader shows title');
ok(!!$('#reader-slot .star-btn'), 'reader has star (read later) button');
ok($('#reader-placeholder').classList.contains('hidden') && window.document.body.classList.contains('article-open'), 'placeholder hides while article open');
ok(!!$('#reader-slot .reader-toolbar') && $('#reader-slot [data-rtab="description"]').classList.contains('active'), 'reader toolbar + Description tab active (ss3)');
ok(Number($('#badge-all-items').textContent) === railCount - 1, `opening marked read (badge → ${$('#badge-all-items').textContent})`);

console.log('reader tabs (Description / Transcript / Pro notes)');
click('#reader-slot [data-rtab="transcript"]');
await settle(30);
ok($('#reader-slot .reader-pro-note')?.textContent.includes('Transcript'), 'Transcript tab shows honest Pro note');
click('#reader-slot [data-rtab="article"]');
await settle(30);
ok($('#reader-slot .reader-pro-note')?.textContent.includes('extracted article text'), 'Article tab falls back honestly without extracted text');
click('#reader-slot [data-rtab="description"]');
await settle(30);
ok(!!$('#reader-slot .reader-body'), 'Description tab restores the body');

console.log('mark unread via reader ⋯ menu');
click('#reader-slot [data-act="reader-menu"]');
await settle(20);
ok(!$('#row-menu').classList.contains('hidden') && $('#row-menu').textContent.includes('Mark unread'), 'reader ⋯ menu opens with Mark unread');
click('#row-menu [data-act="toggle-read"]');
await settle(50);
ok(Number($('#badge-all-items').textContent) === railCount, 'mark unread restores count');
click('#reader-slot [data-act="reader-menu"]'); // read again
await settle(20);
click('#row-menu [data-act="toggle-read"]');
await settle(50);

console.log('mark-all ▾ dropdown = "Mark as read articles" (ss2)');
{
  const before = Number($('#badge-all-items').textContent);
  click('#btn-mark-all-split');
  await settle(20);
  ok(!$('#mark-menu').classList.contains('hidden'), '▾ opens the mark-as-read menu');
  const labels = $$('#mark-menu [data-older]').map((b) => b.textContent);
  ok(labels.join('|') === 'Older than a day|Older than two days|Older than three days|Older than a week|Older than two weeks', `menu options match theirs (${labels.length} items)`);
  click('#mark-menu [data-older="1"]');
  await settle(50);
  const mid = Number($('#badge-all-items').textContent);
  ok(mid < before, `older-than-a-day marks only old articles (${before} → ${mid})`);
  ok(!$('#toast').classList.contains('hidden') && $('#toast-action').textContent === 'Undo', 'undo toast shown');
  click('#toast-action');
  await settle(50);
  ok(Number($('#badge-all-items').textContent) === before, 'undo restores counts');
}

console.log('row ⋯ menu (mark read / keep unread / hide / star)');
click('#list .row [data-act="row-menu"]');
await settle(20);
ok(!$('#row-menu').classList.contains('hidden'), 'row ⋯ menu opens');
ok($('#row-menu').textContent.includes('Mark as read') && $('#row-menu').textContent.includes('Keep unread') && $('#row-menu').textContent.includes('hide'), 'row menu lists mark/keep/hide');
click('#row-menu [data-act="keep"]'); // toggle keep unread on
await settle(30);
ok($('#starred-count') !== null, 'menu action dispatch did not crash');
click('#list .row [data-act="row-menu"]'); // toggle it back off
await settle(20);
click('#row-menu [data-act="keep"]');
await settle(30);

console.log('status via header ⋯ menu (All / Unread / Today / Recently read)');
click('#btn-more');
await settle(20);
ok(!$('#header-menu').classList.contains('hidden'), 'More menu opens');
click('#status-items [data-status="all"]');
await settle(50);
ok($$('#list .row').length === TOTAL - HIDDEN, 'All articles shows everything unfiltered');
click('#btn-more'); click('#status-items [data-status="unread"]');
await settle(50);
ok($$('#list .row').length === TOTAL - HIDDEN - 1, 'Unread articles hides the read one');
click('#btn-more'); click('#status-items [data-status="recently-read"]');
await settle(50);
ok($('#scope-title').textContent === 'Recently read', 'scope title = Recently read');
ok($$('#list .row').length === 1 && $('#list .row').dataset.id === firstId, 'Recently read shows only the read article');
click('#btn-more'); click('#status-items [data-status="unread"]');
await settle(50);
ok($('#scope-title').textContent === 'Newsfeed', 'back to Newsfeed');

console.log('scope switching (feed / folder)');
click('.tree-item[data-scope="feed:fixture-bbc"]');
await settle(50);
ok($('#scope-title').textContent === 'BBC News', 'feed scope title updates');
ok($$('#list .row').every((r) => r.querySelector('.feed-name')?.textContent === 'BBC News'), 'feed scope shows only that feed');
click('.tree-item[data-folder="tech"]');
await settle(50);
{
  const folderFeeds = new Set($$('#list .row .feed-name').map((n) => n.textContent));
  ok(folderFeeds.size > 0 && !folderFeeds.has('BBC News'), `folder scope limited to folder (${[...folderFeeds].join(', ')})`);
}
click('.tree-item[data-scope="all"]');
await settle(50);

console.log('search operators');
const search = $('#search-input');
search.value = 'feed:fixture-bbc';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await settle(500);
ok($$('#list .row').length > 0 && $$('#list .row').every((r) => r.querySelector('.feed-name')?.textContent === 'BBC News'), 'feed: operator scopes search');
search.value = 'rust OR benchmark OR election';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await settle(500);
ok($$('#list .row').length > 0, `term search finds something (${$$('#list .row').length} rows)`);
search.value = 'zzzznotfoundzzzz';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await settle(500);
ok(!$('#empty').classList.contains('hidden') && $('#empty').textContent.includes('No matches'), 'empty state for no results');
search.value = '';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await settle(300);

console.log('layouts + sort (Inoreader parity)');
click('#btn-more');
for (const layout of ['expanded', 'column', 'cards', 'magazine', 'list']) {
  click(`#layouts [data-layout="${layout}"]`);
  await settle(30);
  ok($$('#list .row').length > 0 && $('#list').classList.contains(`view-${layout}`), `${layout} view renders with rows`);
  if (layout === 'expanded') ok($$('#list .row-body-inline').length > 0, 'expanded view shows inline article bodies');
}
click('#btn-more'); click('#sort-items [data-sort="oldest"]');
await settle(30);
{
  const firstOld = $('#list .row').dataset.id;
  click('#btn-more'); click('#sort-items [data-sort="newest"]');
  await settle(30);
  ok(firstOld !== $('#list .row').dataset.id, 'sort toggle flips ordering (newest/oldest)');
}

console.log('folder unread badge = mark read (sidebar parity)');
const folderBadge = $('#tree .tree-item[data-scope="folder:tech"] .badge');
ok(!!folderBadge, 'folder badge present');
if (folderBadge) {
  const before = Number(folderBadge.textContent);
  click(folderBadge);
  await settle(50);
  const techBadge = $('#tree .tree-item[data-scope="folder:tech"] .badge');
  ok(!techBadge || Number(techBadge.textContent) === 0, `clicking badge marks folder read (${before} → ${techBadge ? techBadge.textContent : 'gone'})`);
  ok(!$('#toast').classList.contains('hidden') && $('#toast-action').textContent === 'Undo', 'undo toast shown');
  click('#toast-action');
  await settle(50);
  const restored = $('#tree .tree-item[data-scope="folder:tech"] .badge');
  ok(!!restored && Number(restored.textContent) === before, 'undo restores unread counts');
}

console.log('expanding search + sidebar options');
click('#search-open');
await settle(20);
ok(!$('#search-box').classList.contains('hidden'), 'search expands from icon');
click('#search-close');
await settle(20);
ok($('#search-box').classList.contains('hidden'), 'search collapses');
click('#btn-sidebar-menu');
await settle(20);
ok(!$('#sidebar-menu').classList.contains('hidden'), 'sidebar menu opens');
click('#sidebar-menu [data-opt="dimRead"]');
await settle(20);
ok(JSON.parse(window.localStorage.getItem('ghrss:ui')).dimRead === true, 'dim-read option persisted');
click('#sidebar-menu [data-opt="dimRead"]');
await settle(20);

console.log('title menu + mark-all split');
click('#btn-title-menu');
await settle(20);
ok(!$('#title-menu').classList.contains('hidden'), 'title dropdown opens (Feed properties / Pro items)');
click('#title-menu [data-title-act="properties"]');
await settle(20);
ok(!$('#settings-modal').classList.contains('hidden'), 'Feed properties opens settings');
click('.modal-close');
await settle(20);

console.log('ported settings (tab counter, titles-only, dates, bulk select, Today row)');
ok(/^\(\d+\)/.test(window.document.title), `browser tab shows unread counter (${window.document.title})`);
click('#btn-settings');
await settle(30);
ok(!$('#settings-modal').classList.contains('hidden'), 'settings modal opens from rail');
fire('#set-titles-only', true);
await settle(30);
ok($$('#list .row-snippet').length === 0, 'titles-only hides descriptions');
fire('#set-absolute-dates', true);
await settle(30);
ok(/[\d]{1,2}:\d{2}/.test($('#list .row .time')?.textContent || ''), `absolute dates render (${$('#list .row .time')?.textContent})`);
fire('#set-titles-only', false);
fire('#set-absolute-dates', false);
fire('#set-show-today', true);
await settle(30);
ok(!$('#pdinner_today').classList.contains('hidden'), 'show-Today setting reveals the Today row');
click('.tree-item[data-scope="today"]');
await settle(50);
ok($('#scope-title').textContent === 'Today' && $$('#list .row').length > 0, 'Today scope lists today articles');
click('#btn-more'); click('#status-items [data-status="unread"]');
await settle(30);
fire('#set-show-today', false);
await settle(30);
ok($('#pdinner_today').classList.contains('hidden'), 'Today row hides again');

fire('#set-bulk-select', true);
await settle(30);
ok($$('#list .row-check').length > 0, 'bulk mode shows checkboxes');
$$('#list .row-check').slice(0, 2).forEach((c) => click(c));
await settle(30);
ok(!$('#bulk-bar').classList.contains('hidden') && $('#bulk-count').textContent === '2', 'bulk bar shows 2 selected');
click('#bulk-read');
await settle(50);
ok($('#bulk-bar').classList.contains('hidden'), 'bulk bar hides after mark read');
fire('#set-bulk-select', false);
await settle(30);

console.log('star (read later) + Saved tab');
const unreadRows = $$('#list .row').length;
click('#list .row [data-act="star"]');
await settle(50);
ok($('#starred-count').textContent === '1' && $('#saved_tab_counter').textContent === '1', 'starred counters update');
click('#saved_tab .tab-item');
await settle(800);
ok(!$('#saved_nav').classList.contains('hidden'), 'Saved panel shows on rail click');
ok($('#scope-title').textContent === 'Starred', 'scope title = Starred');
ok($$('#list .row').length === 1, 'starred article listed in Saved');
click('#list .row [data-act="star"]');
await settle(50);
ok($('#starred-count').textContent === '' && $$('#list .row').length === 0, 'unstar removes it from Saved');
ok(!$('#empty').classList.contains('hidden'), 'empty state shown for empty Saved');

console.log('rail module panels + dock');
click('#feeds_tab .tab-item');
await settle(50);
ok(!$('#feeds_nav').classList.contains('hidden') && $('#scope-title').textContent === 'Newsfeed', 'Feeds tab returns to Newsfeed');
click('#dashboard_tab .tab-item');
await settle(20);
ok(!$('#placeholder_nav').classList.contains('hidden') && $('#placeholder-title').textContent === 'Dashboards', 'Dashboards tab shows placeholder panel');
click('#automation_tab .tab-item');
await settle(20);
ok(!$('#automation_nav').classList.contains('hidden') && $('#automation_nav').textContent.includes('Spotlights'), 'Automate panel lists Rules/Filters/Spotlights/Email digests');
click('#feeds_tab .tab-item');
await settle(50);
ok($('#feeds_nav').classList.contains('hidden') === false, 'Feeds tab returns to feeds panel');
await settle(20);
click('#dock-toggle');
await settle(20);
ok(window.document.body.classList.contains('sidebar-collapsed'), 'dock toggle collapses sidebar');
click('#dock-toggle');
await settle(20);
ok(!window.document.body.classList.contains('sidebar-collapsed'), 'dock toggle restores sidebar');

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
