// Smoke test: boot the real UI (index.html + app.js) in jsdom against
// deterministic in-memory fixtures.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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
  // hostile-feed regression: junk-scheme links must never reach an href, and
  // a feed-embedded SoundCloud player (w.soundcloud.com/player) must survive
  // the client sanitizer now that the server allowlist matches it.
  'fixture-junk': {
    title: 'Junk Feed', site: 'https://junk.test', folder: 'junk',
    articles: [{
      id: 'fixture-junk-0', title: 'Hostile link article', link: 'javascript:alert(1)',
      date: now - 60 * 60e3, author: null, summary: 'junk',
      content: '<p>hello <iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F1"></iframe></p>',
      text: null, enclosures: [], fetchedAt: now,
    }],
  },
};
// full-text fixture: the reader must prefer a.text over the shorter a.content
FIX['fixture-verge'].articles[2].text = '<p>Extracted full text present</p>';
FIX['fixture-verge'].articles[2].content = '<p>Short teaser only</p>';

const config = {
  // theme is a config-owned pref with no UI toggle — it must apply on EVERY load.
  settings: { siteName: 'My RSSFeed', theme: 'dark', view: 'list', refreshMinutes: 60, markReadOnOpen: true },
  folders: [], // folder names come from the generated index.json (as with feeds.opml)
  feeds: [
    { id: 'fixture-hn', title: 'Hacker News', url: 'https://hnrss.test/frontpage', site: 'https://news.ycombinator.com', folder: 'tech' },
    { id: 'fixture-verge', title: 'The Verge', url: 'https://theverge.test/rss', site: 'https://www.theverge.com', folder: 'tech' },
    { id: 'fixture-bbc', title: 'BBC News', url: 'https://bbc.test/rss', site: 'https://www.bbc.com/news', folder: 'news' },
  ],
  filters: [
    { id: 'test-filter', name: 'test', feeds: ['fixture-hn'],
      exclude: { title: ['show hn'] }, actions: { hide: true } },
    // include + highlight: must tint ONLY the include match, and hide nothing
    // (the old inverted predicate highlighted everything EXCEPT the match,
    // and hide:true-by-default nuked the whole scope)
    { id: 'test-highlight', name: 'hl', feeds: ['fixture-verge'],
      include: { title: ['laptop'] }, actions: { highlight: true } },
  ],
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
  .replace(/<script src="assets\/app\.js\?v=[^"]*"><\/script>/, ''); // any ?v= shape — CI substitutes a content hash
// Read app.js BEFORE any JSDOM is constructed: an await between construction
// and eval lets jsdom's natural DOMContentLoaded fire before the app's
// listener exists (boot never runs). The natural event — not a manual
// dispatch — drives every boot below: a manual one ON TOP of it ran boot
// twice, double-binding every listener (toggles like bulk-select then
// flipped twice per click and silently landed back off).
const appSrc = await fs.readFile(path.join(ROOT, 'assets/app.js'), 'utf8');
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

window.eval(appSrc);
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
ok($$('#list .row.highlight').length === 1 && /laptop/i.test($$('#list .row.highlight .row-title')[0].textContent), 'include+highlight tints ONLY the matching row (nothing hidden)');

console.log('reading');
const firstRow = $('#list .row');
const firstId = firstRow.dataset.id;
const firstLink = firstRow.querySelector('[data-act="open-original"]').getAttribute('href');
ok($('#list .row.unread [data-act="toggle-read"] use')?.getAttribute('href') === '#i-unread', 'unread rows show the ○ state icon (title carries the action)');
click(firstRow);
await settle(50);
ok(!!$('#reader-slot .reader-body'), 'article opens');
ok($('#reader-slot .reader-title a')?.href === firstLink, 'reader title links to the original article');
ok($('#list .row').classList.contains('expanded'), 'open row is highlighted in the list');
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'opening marks read');
ok(window.location.hash === `#article/${firstId}`, 'opening an article puts its id in the URL (#article/<id>)');

console.log('reader prefers extracted full text over the feed teaser');
{
  click('#search-open');
  await settle(20);
  const s = $('#search-input');
  s.value = 'AI gadget';
  s.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(400);
  ok(rowCount() === 1, 'full-text fixture article found');
  const ftRow = $('#list .row');
  const ftId = ftRow.dataset.id;
  click(ftRow);
  await settle(50);
  ok($('#reader-slot .reader-body').textContent.includes('Extracted full text present'), 'the reader shows the extracted text (a.text)');
  ok(!$('#reader-slot .reader-body').textContent.includes('Short teaser only'), 'not the shorter feed teaser (a.content)');
  ok(!!$('#reader-slot [data-act="keep"]') && !!$('#reader-slot [data-act="toggle-read"]'), 'reader toolbar carries keep-unread + read toggle (narrow screens have no row buttons)');
  click('#search-close');
  await settle(50);
  ok(window.document.body.classList.contains('article-open'), 'clearing the search keeps the open article (search no longer closes it)');
  click($(`#list .row[data-id="${ftId}"] [data-act="toggle-read"]`)); // back to unread — leave exactly one read article (the first) for the next sections
  await settle(50);
  ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'state restored to one read article');
  click($('#reader-slot [data-act="collapse"]'));
  await settle(50);
  ok(!window.document.body.classList.contains('article-open'), 'reader collapsed');
}

console.log('double-click keeps the read row');
click($('#list .row')); // re-open the just-read row
await settle(30);
click($('#list .row')); // same row again → collapse
await settle(50);
ok(!window.document.body.classList.contains('article-open'), 'reader closed');
ok(rowCount() === TOTAL - HIDDEN, 'double-clicked article stays in the list (marked read, not removed)');
ok(!$('#list .row').classList.contains('unread'), 'the row now shows as read');
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'badge unchanged by the collapse');
ok(!window.location.hash, 'collapsing the reader clears the hash (no history spam)');

console.log('moving on keeps the read row (Back/prev/k can still return to it)');
const secondRow = $$('#list .row')[1];
const secondId = secondRow.dataset.id;
click(secondRow);
await settle(50);
ok(rowCount() === TOTAL - HIDDEN, 'the previously read row lingers (tick flips in place, no vanish)');
ok(!!$(`#list .row[data-id="${firstId}"]`), 'the old row is still in the list for Back/Previous to return to');
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

console.log('keep unread actually un-reads');
ok(!!$(`#list .row[data-id="${firstId}"]`), 'the read row lingers in place');
click(`#list .row[data-id="${firstId}"] [data-act="keep"]`);
await settle(50);
ok(Number($('#badge-all-items').textContent) === TOTAL - HIDDEN, 'keep-unread deletes the read entry too (the badge counts it again)');
ok($(`#list .row[data-id="${firstId}"] [data-act="keep"]`)?.getAttribute('aria-pressed') === 'true', 'the keep button reports its pressed state');
click(`#list .row[data-id="${firstId}"] [data-act="keep"]`); // un-keep again (stays unread)
await settle(50);

console.log('mark-all split');
click('#btn-mark-all-split');
await settle(20);
ok(!$('#mark-menu').classList.contains('hidden'), 'mark menu opens');
click('#mark-menu [data-mark="read"][data-older="1"]');
await settle(80);
ok($('#toast-text').textContent.includes('4 article'), 'older-than-a-day marks exactly 4 articles (the day-old HN batch)');
ok(rowCount() === TOTAL - HIDDEN - 4, 'marked articles re-filter out');
click($('#toast-action'));
await settle(50);
ok(rowCount() === TOTAL - HIDDEN, 'undo restores the rows');

console.log('mark menu shows exactly ONE group (read ⇄ unread)');
// User spec: unread articles exist → offer "Mark as read"; everything read →
// offer "Mark as unread". Never both groups at once.
ok($('#btn-mark-all').title === 'Mark all as read', 'scope is NOT caught up (newer articles still unread)');
ok(!$('#mark-group-read').classList.contains('hidden'), 'unread articles exist → the "Mark as read" group is offered');
ok($('#mark-group-unread').classList.contains('hidden'), 'the "Mark as unread" group is hidden while not caught up');
ok($$('#mark-menu [data-mark="read"]').length === 4, 'the read group keeps its four age presets');
ok(!!$('#mark-date-unread') && !!$('#mark-date-read'), 'custom "Before…" date pickers present (one per group)');
const visibleGroupLabel = () =>
  $('#mark-group-unread').classList.contains('hidden') ? $('#mark-group-read .mark-label') : $('#mark-group-unread .mark-label');
ok(visibleGroupLabel().textContent === 'Mark as read', 'the OFFERED group while not caught up is "Mark as read"');

console.log('inverse-direction expander — restore by age while NOT caught up');
// User report: "mark as unread, older than a x is broken" — the unread group
// was hidden whenever any unread article existed (with a fetch every ~15 min
// that is almost always), making restore-by-age unreachable. The subdued
// expander brings it back while the menu still OPENS offering exactly one group.
click('#btn-mark-all-split');
await settle(20);
ok(!!$('#mark-alt-toggle') && $('#mark-alt-label').textContent === 'Mark as unread by age', 'collapsed expander offers the inverse direction (unread) while not caught up');
ok($('#mark-group-unread').classList.contains('hidden'), 'the menu still opens with exactly ONE group');
click('#mark-alt-toggle');
await settle(20);
ok(!$('#mark-group-unread').classList.contains('hidden'), 'the expander reveals the "Mark as unread" group');
ok(!$('#mark-group-read').classList.contains('hidden'), 'the primary read group stays visible');
ok($('#mark-alt-toggle').getAttribute('aria-expanded') === 'true', 'the expander reports its expanded state');
click('#mark-menu [data-mark="read"][data-older="1"]'); // mark the day-old batch read via the primary group
await settle(80);
ok($('#toast-text').textContent.includes('4 article'), 'day-old batch marked read while not caught up');
ok($('#mark-menu').classList.contains('hidden'), 'the action closed the menu');
click('#btn-mark-all-split'); // reopen — the expansion must reset
await settle(20);
ok($('#mark-group-unread').classList.contains('hidden') && $('#mark-alt-toggle').getAttribute('aria-expanded') === 'false', 'reopening resets the expander (one group again)');
ok($('#mark-alt-label').textContent === 'Mark as unread by age', 'the expander label survives the reset');
click('#mark-alt-toggle'); // reveal the unread group again — the reported-broken path
await settle(20);
click('#mark-menu [data-mark="unread"][data-older="1"]');
await settle(80);
ok($('#toast-text').textContent.includes('No articles you read more than a day ago here'), 'restore-by-age answers honestly while NOT caught up — reads from seconds ago are not "more than a day ago"');
ok(rowCount() === TOTAL - HIDDEN - 4 && $('#badge-all-items').textContent === String(TOTAL - HIDDEN - 4), 'the day-old batch stays read: READING age, not publication age, is the restore cutoff');

console.log('Today scope: structurally dead presets are hidden');
// A Today article is never older than a day — the older-than rows can only
// ever toast "No articles older than … here" in that view (dead menu items,
// the other half of the "older than a x is broken" report).
click('#status-items [data-status="today"]');
await settle(80);
ok($('#scope-title').textContent === 'Today', 'Today view entered');
click('#btn-mark-all-split');
await settle(20);
ok($$('#mark-menu .dropdown-item[data-older]').length === 8, 'eight older-than rows exist across both groups');
ok($$('#mark-menu .dropdown-item[data-older]').every((b) => b.classList.contains('hidden')), 'every older-than preset is hidden in the Today view');
ok($$('#mark-menu .mark-custom').length === 2 && $$('#mark-menu .mark-custom.hidden').length === 0, 'the "Before…" pickers stay (a future date still works)');
click('#btn-mark-all-split'); // close
await settle(20);
click('.tree-item[data-scope="all"]'); // back to the Newsfeed
await settle(80);
click('#btn-mark-all-split');
await settle(20);
ok($$('#mark-menu .dropdown-item[data-older]').every((b) => !b.classList.contains('hidden')), 'presets return outside the Today view');
click('#btn-mark-all-split'); // close
await settle(20);

console.log('filter-invisible restores explain themselves');
// Caught up with the Date filter on Today: restoring older-than-a-day lands
// entirely OUTSIDE the filter — the toast used to claim success over an
// unchanged "All caught up 🎉" list (looked dead). It must now explain itself,
// offer Show all, and the empty state must stop celebrating hidden unread.
click('#badge-all-items'); // everything read → caught up
await settle(80);
const dr = $('#date-range');
dr.value = 'today';
dr.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle(80);
ok(rowCount() === 0, 'caught up under a Today filter: the unread view is empty');
ok($('#empty h3').textContent === 'Nothing in this time range', 'the empty state no longer claims "All caught up" while a filter narrows the view');
ok($('#empty p').textContent.includes('No unread articles'), 'the caught-up flavor reads honestly (no hidden unread yet)');
click('#btn-mark-all-split');
await settle(20);
ok(!$('#mark-group-unread').classList.contains('hidden'), 'caught up → the unread group is the offered one');
click('#mark-menu [data-mark="unread"][data-older="1"]');
await settle(120);
ok($('#toast-text').textContent.includes('No articles you read more than a day ago here'), 'freshly-read rows are not "read more than a day ago" — honest zero under the filter too');
ok(rowCount() === 0, 'nothing restored — the reading-age cutoff held');
ok($('#empty h3').textContent === 'Nothing in this time range', 'empty state stays on the honest header');
ok($('#empty p').textContent.includes('No unread articles'), 'no hidden unread to name — the empty state says so');
// (The filter-invisible RESTORE case — toast note + Show all + the empty
// state naming hidden unread — lives in the reading-age regression window
// below, which has genuinely old reads to restore.)
dr.value = 'all';
dr.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle(80);
ok(rowCount() === 0, 'filter reset: still caught up, still empty');
// Return to the full-unread net-zero state for the following blocks: not
// caught up → expander → "Before tomorrow" un-reads everything.
click('#btn-mark-all-split');
await settle(20);
click('#mark-alt-toggle');
await settle(20);
const tmr = new Date(now + 864e5);
const tmrStr = `${tmr.getFullYear()}-${String(tmr.getMonth() + 1).padStart(2, '0')}-${String(tmr.getDate()).padStart(2, '0')}`;
const dpick = $('#mark-date-unread');
dpick.value = tmrStr;
dpick.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle(500); // past the 250 ms date-picker debounce
ok(rowCount() === TOTAL - HIDDEN, '"Before tomorrow" through the revealed group un-reads everything (net-zero restored)');

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
ok(rowCount() === TOTAL - HIDDEN, 'closing search clears the active filter');
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
click($$('#list .row')[5]); // not the open article (that row stays pinned)
await settle(20);
ok($('#bulk-count').textContent === '1', 'row click selects in bulk mode');
click('#bulk-read');
await settle(50);
ok(rowCount() === TOTAL - HIDDEN - 1, 'bulk mark read removes the row from the unread view');
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
ok(!$('#mark-group-unread').classList.contains('hidden'), 'caught up → the "Mark as unread" group is offered');
ok($('#mark-group-read').classList.contains('hidden'), 'the "Mark as read" group is hidden once everything is read');
ok(visibleGroupLabel().textContent === 'Mark as unread', 'the OFFERED group while caught up is "Mark as unread"');
click('#btn-mark-all');
await settle(20);
ok(!$('#confirm-modal').classList.contains('hidden'), 'mark-as-unread asks for confirmation');
click('#confirm-yes');
await settle(50);
ok(rowCount() === rowsBeforeMarkAll, 'mark as unread restores every article');
ok($('#toast-text').textContent.includes('articles as unread'), 'restore toast reports the count');
ok($('#btn-mark-all').title === 'Mark all as read', 'button flips back once articles are unread');
ok(!$('#mark-group-read').classList.contains('hidden'), 'groups flip back the moment articles become unread');

click('#badge-all-items'); // everything read again
await settle(50);
ok(rowCount() === 0, 'badge tick re-marks everything read');
click('#btn-mark-all-split');
await settle(20);
click('#mark-menu [data-mark="unread"][data-older="1"]');
await settle(80);
ok($('#toast-text').textContent.includes('No articles you read more than a day ago here'), 'freshly-read articles are not "read more than a day ago" — no phantom restore');
ok(rowCount() === 0, 'nothing came back — the reading-age cutoff held');
click('#btn-mark-all'); // caught up → the full restore
await settle(20);
click('#confirm-yes');
await settle(50);
ok(rowCount() === rowsBeforeMarkAll, 'the plain caught-up restore still brings everything back');

console.log('custom "Before…" date picker');
click('#badge-all-items'); // everything read again
await settle(50);
ok(rowCount() === 0, 'badge tick re-marks everything read for the date test');
const t = new Date(now + 864e5);
const dstr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
const dinp = $('#mark-date-unread');
dinp.value = dstr; // "before tomorrow" = every article
dinp.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle(450); // past the 250 ms date-picker debounce (Chromium fires change per typed segment)
ok($('#toast-text').textContent.includes('as unread'), 'date picker action runs');
ok($('#toast-text').textContent.includes(new Date(`${dstr}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })), 'toast names the picked date');
ok(rowCount() === rowsBeforeMarkAll, '"before tomorrow" restores every read article');

click('#btn-mark-all-split');
await settle(20);
click('#mark-menu [data-mark="read"][data-older="31"]');
await settle(120);
ok($('#toast-text').textContent.includes('No unread articles older than a month here'), 'read-side zero toast explains itself');
ok(rowCount() === rowsBeforeMarkAll, 'a month cutoff matches nothing in the fixtures (all within ~2 days)');

console.log('zero-result toasts name the data boundary');
// The month cutoff predates ALL fixture data (~33 h old) → the toast must say
// where the data starts instead of looking like a dead button (user report:
// "No read articles older than a month here" -_- with 30-day retention).
ok($('#toast-text').textContent.includes('data goes back to'), 'a cutoff past the data start names the boundary');
ok($('#toast-text').textContent.includes(new Date(FIX['fixture-hn'].articles.at(-1).date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })), 'the boundary date is the oldest article in the scope');
// Zero results WITHIN the data window keep the plain message (no false boundary)
click('#tree .tree-item[data-scope="feed:fixture-hn"] .badge'); // HN read
await settle(60);
click('.tree-item[data-scope="feed:fixture-hn"]'); // select the HN feed
await settle(60);
click('#btn-mark-all-split');
await settle(20);
click('#mark-menu [data-mark="read"][data-older="1"]');
await settle(120);
ok($('#toast-text').textContent === 'No unread articles older than a day here', 'cutoff within the data window: plain zero-result toast, no boundary clause');
click('#btn-mark-all-split');
await settle(20);
click('#mark-menu [data-mark="unread"][data-older="31"]');
await settle(120);
ok($('#toast-text').textContent.includes('No articles you read more than a month ago here — data goes back to'), 'unread-side month cutoff also names the boundary');
click('.tree-item[data-scope="all"]'); // back to the Newsfeed
await settle(60);
click('#badge-all-items'); // everything read
await settle(60);
click('#btn-mark-all'); // caught up → confirm
await settle(20);
click('#confirm-yes');
await settle(80);
ok(rowCount() === rowsBeforeMarkAll, 'state restored: everything unread again');

console.log('Newsfeed badge marks ALL feeds, even from inside a feed view');
click('.tree-item[data-scope="feed:fixture-verge"]'); // a single feed
await settle(60);
ok($('#scope-title').textContent === 'The Verge', 'viewing a single feed');
click('#badge-all-items'); // the Newsfeed tick — must cover every feed, not just the Verge
await settle(150);
ok($('#toast-text').textContent.includes(`Marked ${TOTAL - HIDDEN} articles as read`), `the Newsfeed badge covered every feed (${TOTAL - HIDDEN}, not just the one in view)`);
click($('#toast-action'));
await settle(60);
click('.tree-item[data-scope="all"]'); // back to the Newsfeed
await settle(60);

console.log('an info toast never stomps a live Undo');
click('#badge-all-items'); // everything read -> "Marked N as read" + Undo
await settle(150);
ok($('#toast-action').style.display !== 'none', 'the mark-all toast carries a live Undo button');
const undoToastText = $('#toast-text').textContent;
click('#btn-more'); // open the \u22ef menu over it
await settle(20);
click('#menu-refresh'); // fires the "Already up to date" info toast
await settle(500);
ok($('#toast-text').textContent === undoToastText, 'the info toast does NOT replace the live Undo');
ok($('#toast-action').style.display !== 'none', 'the Undo button is still there');
click($('#toast-action')); // clean up: undo the mark-all
await settle(60);

console.log('j/k keyboard navigation');
const idsNow = $$('#list .row').map((r) => r.dataset.id);
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
await settle(80);
ok($('#reader-slot .reader')?.dataset.id === idsNow[0], 'j opens the first visible article when nothing is open');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
await settle(80);
ok($('#reader-slot .reader')?.dataset.id === idsNow[1], 'j again moves to the next article');
console.log('Escape peels one layer at a time');
click('#btn-more');
await settle(20);
ok(!$('#header-menu').classList.contains('hidden'), 'the \u22ef menu opens over the article');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await settle(40);
ok($('#header-menu').classList.contains('hidden'), 'Escape closes the menu');
ok(window.document.body.classList.contains('article-open'), 'the open article SURVIVES that Escape (menu and article no longer close together)');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await settle(60);
ok(!window.document.body.classList.contains('article-open'), 'a bare Escape closes the reader');
// open a row further down; k must walk back to the article above it
const rowsMid = $$('#list .row').map((r) => r.dataset.id);
click(`#list .row[data-id="${rowsMid[3]}"]`);
await settle(60);
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
await settle(80);
ok($('#reader-slot .reader')?.dataset.id === rowsMid[2], 'k walks back to the article above (the just-read row lingers)');

click('#btn-mark-all-split');
await settle(20);
const emptyDate = $('#mark-date-read'); // the read group is the one offered while not caught up
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
click('#badge-all-items'); // caught up first — the unread group is the one offered
await settle(50);
click('#btn-mark-all-split');
await settle(20);
const dinp2 = $('#mark-date-unread');
dinp2.value = dstr; // "before tomorrow" = every read article again
dinp2.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle(500); // past the 250 ms date-picker debounce
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

console.log('hostile feed links never become URLs');
{
  const junkRow = $('#list .row[data-id="fixture-junk-0"]');
  ok(!!junkRow, 'junk-feed article renders');
  ok(junkRow.querySelector('[data-act="open-original"]').getAttribute('href') === '#', 'a javascript: "link" degrades to # (never an executable href)');
  click(junkRow);
  await settle(60);
  ok(!$('#reader-slot .reader-title a'), 'the reader title is plain text when there is no usable http(s) link');
  ok(!!$('#reader-slot .reader-body iframe') && $('#reader-slot .reader-body iframe').src.includes('w.soundcloud.com/player/'), 'feed-embedded SoundCloud players survive the client sanitizer (allowlist now matches the server)');
  click($('#reader-slot [data-act="collapse"]'));
  await settle(50);
}

console.log('search is global — it crosses the current feed/folder scope');
{
  click('.tree-item[data-scope="feed:fixture-bbc"]');
  await settle(60);
  ok($('#scope-title').textContent === 'BBC News', 'viewing a single feed');
  click('#search-open');
  await settle(20);
  const gs = $('#search-input');
  gs.value = 'Rust 2.0';
  gs.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(400);
  ok(rowCount() === 1 && /Rust 2\.0/.test($('#list .row .row-title').textContent), 'a search from inside one feed finds HN articles (the old scope clip hid them)');
  click('#search-close');
  await settle(60);
  ok(rowCount() === 5, 'closing search restores the feed view');
  click('.tree-item[data-scope="all"]');
  await settle(60);
}

console.log('a read click patches the sidebar in place (no favicon churn)');
{
  const bbcItem = $('.tree-item[data-scope="feed:fixture-bbc"]');
  const bbcBadge = bbcItem.querySelector('.badge');
  const before = Number(bbcBadge.textContent);
  click($('#list .row[data-id="fixture-bbc-0"]'));
  await settle(80);
  ok($('.tree-item[data-scope="feed:fixture-bbc"]') === bbcItem, 'the sidebar row ELEMENT survives a read click (no full tree rebuild — favicons/scroll stay put)');
  ok(Number($('.tree-item[data-scope="feed:fixture-bbc"] .badge').textContent) === before - 1, 'the badge count still updates');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'm', bubbles: true }));
  await settle(80);
  ok(Number($('.tree-item[data-scope="feed:fixture-bbc"] .badge').textContent) === before, 'm toggles the open article back to unread (same path as the row tick)');
  click($('#reader-slot [data-act="collapse"]'));
  await settle(50);
}

console.log('Recently read: mark-all is the honest mass un-read, never a backlog nuke');
{
  click('#badge-all-items'); // everything read
  await settle(150);
  click('#btn-more');
  await settle(20);
  click('#status-items [data-status="recently-read"]');
  await settle(80);
  ok($('#scope-title').textContent === 'Recently read', 'recently-read view');
  ok(rowCount() > 0, 'read articles are listed');
  ok($('#btn-mark-all').title === 'Mark all as unread', 'the view is caught-up by definition → the SAME button flips to the honest mass un-read');
  click('#btn-mark-all');
  await settle(20);
  ok($('#confirm-text').textContent.includes('as unread'), 'the confirm offers un-read (it used to say Recently read while marking the entire UNREAD backlog)');
  click('#confirm-yes');
  await settle(80);
  ok(rowCount() === 0, 'nothing is read anymore → the read-only view empties');
  click('.tree-item[data-scope="all"]');
  await settle(80);
  ok(rowCount() === TOTAL - HIDDEN, 'back in the Newsfeed with every article unread');
}

console.log('refresh/restore: boot with #article/<id> in the URL');
{
  const dom2 = new JSDOM(html, { url: 'https://example.test/#article/fixture-hn-3', runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.fetch = window.fetch; // same deterministic fixture backend
  w2.eval(appSrc);
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
  await settle(1200);
  ok(Number(w4.document.querySelector('#badge-all-items').textContent) === TOTAL - HIDDEN - 1, 'same-version storage is kept (no re-reset)');
  dom4.window.close();
}

console.log('markReadAfterSeconds opts in on its own (markReadOnOpen:false + delay used to be silently dead)');
{
  const dom5 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w5 = dom5.window;
  w5.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone({ ...config, settings: { ...config.settings, markReadOnOpen: false, markReadAfterSeconds: 0.3 } }) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(allFeeds) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  w5.eval(appSrc);
  await settle(1200);
  const badge5 = () => Number(w5.document.querySelector('#badge-all-items').textContent);
  const before5 = badge5();
  w5.document.querySelector('#list .row').dispatchEvent(new w5.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge5() === before5, 'not marked read instantly (markReadOnOpen:false)');
  await settle(500);
  ok(badge5() === before5 - 1, 'the configured delay marks it read — a delay > 0 opts in on its own');
  const r2 = w5.document.querySelectorAll('#list .row')[1];
  const id2 = r2.dataset.id;
  r2.dispatchEvent(new w5.MouseEvent('click', { bubbles: true }));
  await settle(60);
  // re-query: opening rebuilds the list, the old element reference is detached
  w5.document.querySelector(`#list .row[data-id="${id2}"]`).dispatchEvent(new w5.MouseEvent('click', { bubbles: true })); // collapse before the 300 ms delay
  await settle(500);
  ok(badge5() === before5 - 1, 'closing the article before the delay cancels the pending mark');
  dom5.window.close();
}

console.log('an explicit un-read beats markRead filters — even after a reload (filters re-run at load)');
{
  const dom6 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w6 = dom6.window;
  const cfg6 = { ...config, filters: [...config.filters, { id: 'test-markread', name: 'mr', feeds: ['fixture-bbc'], include: { title: ['Election'] }, actions: { markRead: true } }] };
  w6.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(cfg6) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(allFeeds) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  w6.eval(appSrc);
  await settle(1200);
  const badge6 = () => Number(w6.document.querySelector('#badge-all-items').textContent);
  const rowByTitle = (re) => [...w6.document.querySelectorAll('#list .row')].find((r) => re.test(r.querySelector('.row-title').textContent));
  ok(badge6() === TOTAL - HIDDEN - 1, 'the markRead filter auto-read its match at load (Election update)');
  // switch to All articles so the read row is visible and clickable
  w6.document.querySelector('#btn-more').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(20);
  w6.document.querySelector('#status-items [data-status="all"]').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(80);
  const electionRow = rowByTitle(/^Election update$/);
  ok(!!electionRow && !electionRow.classList.contains('unread'), 'the filter-read article shows as read');
  electionRow.querySelector('[data-act="toggle-read"]').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge6() === TOTAL - HIDDEN, 'the user un-reads it');
  // a refresh re-runs the consolidated load → applyFiltersToFeed → the old code re-marked it read here
  w6.document.querySelector('#menu-refresh').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok(badge6() === TOTAL - HIDDEN, 'the explicit un-read SURVIVES the filter re-running (guard persisted, not session-scoped)');
  const electionRow2 = rowByTitle(/^Election update$/);
  ok(!!electionRow2 && electionRow2.classList.contains('unread'), 'the article is still unread after the reload');
  electionRow2.querySelector('[data-act="toggle-read"]').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge6() === TOTAL - HIDDEN - 1, 're-reading it clears the guard (the filter owns it again)');
  w6.document.querySelector('#menu-refresh').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok(badge6() === TOTAL - HIDDEN - 1, 'and stays read — no seesaw');
  dom6.window.close();
}

console.log('degraded network: hung feed fetches never wedge the UI');
{
  // The reported bug: on a flaky connection a stalled feed request could make
  // every mark click silent-forever. Fetches are capped now — a hung request
  // settles as a failure, and mark clicks always answer.
  const domH = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wH = domH.window;
  // A stalled connection that HONORS the abort signal, like a real browser
  // fetch: the request never completes, but abort() rejects it.
  const stalled = (opts) => new Promise((res, rej) => {
    opts?.signal?.addEventListener('abort', () => rej(new Error('The operation was aborted')));
  });
  wH.fetch = (url, opts) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return Promise.resolve({ ok: true, status: 200, json: async () => structuredClone(config) });
    if (p === 'data/index.json') return Promise.resolve({ ok: true, status: 200, json: async () => structuredClone(index) });
    return stalled(opts); // stalled forever — the old code never recovered from this
  };
  wH.RSS_FETCH_TIMEOUT_MS = 120; // test-scale cap (real visitors get 10 s)
  wH.eval(appSrc);
  await settle(700);
  const $$H = (s) => [...wH.document.querySelectorAll(s)];
  ok($$H('#tree .tree-item').length >= 4, 'sidebar renders from index.json even while feed fetches stall');
  ok(wH.document.querySelector('#btn-mark-all').title === 'Mark all as unread', 'stalled loads settle via the fetch cap — no feed is stuck "loading" forever');
  // a mark click must respond within bounds, not hang
  wH.document.querySelector('#btn-mark-all-split').dispatchEvent(new wH.MouseEvent('click', { bubbles: true }));
  await settle(30);
  const item = wH.document.querySelector('#mark-menu [data-mark="unread"][data-older="1"]');
  item.dispatchEvent(new wH.MouseEvent('click', { bubbles: true }));
  await settle(400);
  ok(wH.document.querySelector('#toast-text').textContent.includes('No articles you read more than a day ago here'), 'mark clicks always respond — stalled fetches cannot dead-end them');
  domH.window.close();
}

console.log('degraded network: a click during a slow load is visible, then lands');
{
  const domS = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wS = domS.window;
  const DELAY = 2600;
  wS.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
    if (p === 'data/all-feeds.json') return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
    await new Promise((r) => setTimeout(r, DELAY)); // slow but eventual
    const m = p.match(/^data\/feeds\/(.+)\.json$/);
    if (m && FIX[m[1]]) return { ok: true, status: 200, json: async () => structuredClone({ articles: FIX[m[1]].articles }) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  wS.eval(appSrc);
  await settle(300); // boot is still mid-load (each feed takes 2.6 s)
  wS.document.querySelector('#btn-mark-all-split').dispatchEvent(new wS.MouseEvent('click', { bubbles: true }));
  await settle(30);
  // the click JOINS the in-flight loads instead of dispatching over an empty snapshot
  wS.document.querySelector('#mark-menu [data-mark="read"][data-older="31"]').dispatchEvent(new wS.MouseEvent('click', { bubbles: true }));
  await settle(1700); // past the 1.5 s slow-load notice, still before the loads finish
  ok(wS.document.querySelector('#toast-text').textContent.includes('Still loading this view'), 'a click during a slow load announces itself instead of silently doing nothing');
  await settle(1800); // loads finish → the queued action dispatches over the full data
  ok(wS.document.querySelector('#toast-text').textContent.includes('No unread articles older than a month here'), 'the action lands over the FULL data once loading completes');
  domS.window.close();
}

console.log('refresh fallback: a failed reload keeps the articles on screen');
{
  const domR = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wR = domR.window;
  let feedsFail = false;
  let indexGen = now;
  wR.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone({ ...index, generatedAt: indexGen }) };
    if (p === 'data/all-feeds.json') return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
    if (feedsFail) return { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => { throw new Error('503'); } };
    const m = p.match(/^data\/feeds\/(.+)\.json$/);
    if (m && FIX[m[1]]) return { ok: true, status: 200, json: async () => structuredClone({ articles: FIX[m[1]].articles }) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  wR.eval(appSrc);
  await settle(1200);
  const rowsR = () => [...wR.document.querySelectorAll('#list .row')].length;
  ok(rowsR() === TOTAL - HIDDEN, 'boot loads rows via per-feed files (consolidated 404)');
  indexGen = now + 45 * 60000; // a new "publish"
  feedsFail = true; // …and the reload blips
  wR.document.querySelector('#menu-refresh').dispatchEvent(new wR.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok(rowsR() === TOTAL - HIDDEN, 'a failed reload keeps the previous articles (no blank feed)');
  ok(!wR.document.querySelector('#toast-text').textContent.includes('new article'), 'nothing is announced as synced when the reload fails');
  feedsFail = false;
  wR.document.querySelector('#menu-refresh').dispatchEvent(new wR.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok(rowsR() === TOTAL - HIDDEN, 'the next successful refresh restores the normal flow');
  domR.window.close();
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
  const q = chan.chanThreadToArticle({ no: 107, time: 1745000000, sub: 'quotelink test', com: '<a href="#p106" class="quotelink">&gt;&gt;106</a><br><span class="quote">&gt;implying this works</span>', replies: 320 }, { board: 'g', worksafe: true, now: 1746000000000 });
  ok(q.content.includes('href="https://boards.4channel.org/g/thread/107#p106"'), 'same-thread quotelinks rewrite to absolute URLs (no more 404s off github.io)');
  ok(q.content.includes('<blockquote>&gt;implying this works</blockquote>'), 'greentext becomes a styled blockquote');
  const xq = chan.chanThreadToArticle({ no: 108, time: 1745000000, com: '<a href="/v/thread/99#p1">cross</a>', replies: 5 }, { board: 'g', worksafe: true });
  ok(xq.content.includes('href="https://boards.4chan.org/v/thread/99#p1"'), 'cross-board quotelinks go absolute too');
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

console.log('fetch.mjs pure helpers (entity decode, linkify, ids, matchers)');
{
  const fetchMod = await import('./fetch.mjs');
  ok(fetchMod.stripTags('Don&#8217;t &mdash; a &amp; b &quot;q&quot; &#39;s&#39;') === 'Don\u2019t \u2014 a & b "q" \'s\'', 'entity decode: numeric + named decoded, &amp; last (no double-decode, no stray ";")');
  ok(fetchMod.pickContent({ content: '<img src="https://x.example/a.jpg"> look' }).includes('<img src="https://x.example/a.jpg">'), 'linkify never touches markup attributes (img src intact)');
  const p2 = fetchMod.pickContent({ content: 'watch https://youtu.be/abc12345 now' });
  ok(p2.includes('<a href="https://youtu.be/abc12345">') && !p2.includes('now</a>'), 'plain-text URLs linkify; trailing words stay out of the href');
  const p3 = fetchMod.pickContent({ content: 'see (https://a.dev/page) end' });
  ok(p3.includes('href="https://a.dev/page"') && p3.includes(') end'), 'a closing paren stays out of the href');
  ok(fetchMod.stableId('guid-x') === fetchMod.stableId('guid-x') && fetchMod.stableId('a') !== fetchMod.stableId('b'), 'stableId is deterministic and title-independent');
  const reCi = fetchMod.compileMatcherSrv('/pc build/');
  ok(reCi('PC BUILD') === true, 'regex without flags stays case-insensitive');
  const reFlagged = fetchMod.compileMatcherSrv('/pc build/m');
  ok(reFlagged('PC BUILD') === true, 'an explicit flag no longer silently drops the default i');
  const bAliased = fetchMod.compileBlockSrv({ authors: ['alice'], links: ['example.com'] });
  ok(!!bAliased && bAliased.author?.length === 1 && bAliased.link?.length === 1, 'per-feed filters accept BOTH author/authors and link/links spellings');
  ok(fetchMod.feedFilterDrop({ title: 't', content: '', author: 'alice', link: 'https://example.com/x' }, { include: bAliased }) === false, 'aliased fields match');
  ok(fetchMod.feedFilterDrop({ title: 't', content: '', author: 'bob', link: 'https://other.dev/' }, { include: bAliased }) === true, 'aliased-field miss drops');
}

console.log('server sanitizer: iframe allowlist mirrors the client (SoundCloud embeds)');
{
  const fetchMod = await import('./fetch.mjs');
  const kept = fetchMod.sanitize('<p><iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F1"></iframe></p>');
  ok(/<iframe[^>]+w\.soundcloud\.com\/player\//.test(kept), 'w.soundcloud.com/player iframes survive (the real embed URL — the old server regex allowed a form the client stripped)');
  const blocked = fetchMod.sanitize('<p><iframe src="https://soundcloud.com/player/?url=x"></iframe></p>');
  ok(!blocked.includes('<iframe'), 'non-player soundcloud.com iframes are converted, not passed through');
  ok(blocked.includes('data-blocked-embed'), 'the blocked-embed marker survives sanitization (client removes those nodes wholesale — the marker attr used to be stripped, littering empty divs)');
  const yt = fetchMod.sanitize('<p><iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe></p>');
  ok(/<iframe[^>]+youtube-nocookie\.com/.test(yt), 'youtube-nocookie embeds still pass');
}

console.log('Hacker News deep windows — Algolia\'s 1000-hit cap splits into date ranges');
{
  const hn = await import('./hackernews.mjs');
  const mk = (from, n) => Array.from({ length: n }, (_, i) => ({ objectID: from + i, title: `story ${from + i}` }));
  const NOWS = 1746000000; // fixed test clock (seconds)
  const NOW = NOWS * 1000;
  const START = NOWS - 60 * 86400;
  // Parse the range bounds back out of the URL the way the real API sees them
  const bounds = (url) => {
    const f = Number(decodeURIComponent(url).match(/created_at_i>(\d+)/)?.[1] || 0);
    const t = Number(decodeURIComponent(url).match(/created_at_i<=(\d+)/)?.[1] || 0);
    return { f, t };
  };
  let calls = 0;
  const urls = [];
  const r = await hn.hnFetchAllPages(async (url) => {
    calls++; urls.push(url);
    const { f, t } = bounds(url);
    if (f === START && !t) return { ok: true, status: 200, json: async () => ({ hits: mk(1, 1000), nbHits: 1388 }) }; // root: truncated
    if (f > START && !t) return { ok: true, status: 200, json: async () => ({ hits: mk(2000, 705), nbHits: 705 }) };   // newer half
    return { ok: true, status: 200, json: async () => ({ hits: mk(3000, 683), nbHits: 683 }) };                          // older half
  }, { minPoints: 150, minComments: 100 }, { retentionDays: 60, now: NOW });
  ok(calls === 3 && r.requests === 3, 'a truncated window costs exactly 3 requests: probe + two halves');
  ok(r.hits.length === 1388 && !r.truncated, 'the split window returns EVERY hit (705 newer + 683 older = 1388)');
  ok(r.hits.some((h) => h.objectID >= 3000) && r.hits.some((h) => h.objectID >= 2000 && h.objectID < 3000), 'both halves\' stories are present');
  const lower = urls.map(bounds).find((b) => b.t > 0);
  ok(!!lower && lower.t > lower.f, 'the older half carries the closed upper bound created_at_i<=mid');
  ok(urls[0].includes('created_at_i%3E') && !urls[0].includes('%3C'), 'the root probe is the plain open window');
  let threw = false;
  try { await hn.hnFetchAllPages(async () => ({ ok: false, status: 503, json: async () => ({}) }), { minPoints: 150 }, { retentionDays: 60, now: NOW }); }
  catch { threw = true; }
  ok(threw, 'root failure throws — the feed reports failure, old articles kept');
  const soft = await hn.hnFetchAllPages(async (url) => {
    const { f, t } = bounds(url);
    if (f === START && !t) return { ok: true, status: 200, json: async () => ({ hits: mk(1, 1000), nbHits: 1388 }) };
    if (t > 0) return { ok: false, status: 500, json: async () => ({}) }; // older half dies
    return { ok: true, status: 200, json: async () => ({ hits: mk(2000, 705), nbHits: 705 }) };
  }, { minPoints: 150 }, { retentionDays: 60, now: NOW });
  ok(soft.hits.length === 705 && !soft.truncated, 'a half failing is a soft miss — the other half still lands');
  let n = 0;
  const capped = await hn.hnFetchAllPages(async () => { n++; return { ok: true, status: 200, json: async () => ({ hits: mk(n, 1), nbHits: 5000 }) }; }, { minPoints: 150 }, { retentionDays: 90, now: NOW, maxRequests: 6 });
  ok(n === 6 && capped.truncated, 'the request cap holds even when every range truncates — no loops in a scheduled job');
  let one = 0;
  const single = await hn.hnFetchAllPages(async () => { one++; return { ok: true, status: 200, json: async () => ({ hits: mk(1, 42), nbHits: 42 }) }; }, { minPoints: 150 }, { retentionDays: 30, now: NOW });
  ok(one === 1 && single.hits.length === 42 && !single.truncated, 'an untruncated window stays a single request');
  let fpCalls = 0;
  const fp = await hn.hnFetchAllPages(async () => { fpCalls++; return { ok: true, status: 200, json: async () => ({ hits: mk(1, 30), nbHits: 30 }) }; }, {}, { retentionDays: 30, now: NOW });
  ok(fpCalls === 1 && fp.hits.length === 30 && !fp.truncated, 'no-caps front_page queries never split (the URL ignores ranges — splitting would refetch and duplicate)');
  const dup = await hn.hnFetchAllPages(async () => ({ ok: true, status: 200, json: async () => ({ hits: [...mk(1, 10), ...mk(1, 10)], nbHits: 20 }) }), { minPoints: 150 }, { retentionDays: 30, now: NOW });
  ok(dup.hits.length === 10, 'duplicate objectIDs across range halves collapse (defensive dedup — a boundary change upstream can no longer double stories)');
  ok(hn.hnApiUrl({ minPoints: 150 }, { retentionDays: 60, now: NOW }).includes(`created_at_i%3E${START}`), 'window bound derives from retentionDays');
  const sliced = hn.hnApiUrl({ minPoints: 150 }, { retentionDays: 60, now: NOW, fromSec: START, toSec: NOWS - 30 * 86400 });
  ok(sliced.includes('created_at_i%3C%3D'), 'range slicing encodes the closed upper bound');
}

console.log('recently-read: the view (and its mark-all) cover the 7-day window — not the whole read history');
{
  // The reported nuke: the ✓ flip in "Recently read" unmarked EVERY read
  // article in every feed (scopeFeedIds falls through to all feeds there),
  // while the confirm said only "Recently read".
  const domR2 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wR2 = domR2.window;
  wR2.fetch = window.fetch;
  wR2.localStorage.setItem('ghrss:ver', '3');
  // one article read 10 days ago (outside the window), one read just now
  wR2.localStorage.setItem('ghrss:read', JSON.stringify({ 'fixture-bbc-1': now - 10 * 864e5, 'fixture-bbc-2': now - 60e3 }));
  wR2.eval(appSrc);
  await settle(1200);
  wR2.document.querySelector('#btn-more').dispatchEvent(new wR2.MouseEvent('click', { bubbles: true }));
  wR2.document.querySelector('#status-items [data-status="recently-read"]').dispatchEvent(new wR2.MouseEvent('click', { bubbles: true }));
  await settle(80);
  const rowsR2 = [...wR2.document.querySelectorAll('#list .row')];
  ok(rowsR2.length === 1 && /Market swing/.test(rowsR2[0].textContent), 'the view lists only articles read within the last 7 days (the 10-day-old read is gone)');
  ok(wR2.document.querySelector('#scope-count').textContent === '1 recently read', 'the count chip matches the windowed view');
  // mark-all-as-unread from here must restore ONLY what the view shows
  wR2.document.querySelector('#btn-mark-all').dispatchEvent(new wR2.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wR2.document.querySelector('#confirm-yes').dispatchEvent(new wR2.MouseEvent('click', { bubbles: true }));
  await settle(80);
  const lsR2 = JSON.parse(wR2.localStorage.getItem('ghrss:read') || '{}');
  ok(lsR2['fixture-bbc-2'] === undefined, 'the recent read was restored to unread');
  ok(typeof lsR2['fixture-bbc-1'] === 'number', 'the 10-day-old read STAYS read — no more whole-history nuke');
  domR2.window.close();
}

console.log('regression: marking with caught-up (badgeless) feeds in the tree must not freeze the counters');
{
  // The live-site TypeError: patchTreeCounts planned [row, 0] for every
  // caught-up feed and unconditionally wrote badge.textContent — null for a
  // badgeless row. The click handler died there: the row flipped, but the
  // sidebar badge, the (N) title counter and the ✓ flip all froze.
  const dom10 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w10 = dom10.window;
  w10.fetch = window.fetch;
  w10.localStorage.setItem('ghrss:ver', '3');
  // verge + bbc fully read (badgeless, n=0); hn keeps its unread badge
  const readSeed = {};
  for (const a of FIX['fixture-verge'].articles) readSeed[a.id] = now - 3600e3;
  for (const a of FIX['fixture-bbc'].articles) readSeed[a.id] = now - 3600e3;
  for (const a of FIX['fixture-junk'].articles) readSeed[a.id] = now - 3600e3; // every feed but hn caught up
  w10.localStorage.setItem('ghrss:read', JSON.stringify(readSeed));
  w10.eval(appSrc);
  await settle(1200);
  const hnBadge = () => w10.document.querySelector('#tree .tree-item[data-scope="feed:fixture-hn"] .badge');
  const titleCount10 = () => Number((w10.document.title.match(/^\((\d+)\)/) || [])[1] || 0);
  const unreadN = 12 - HIDDEN; // hn articles minus the two hidden 'show hn'
  ok(Number(hnBadge()?.textContent) === unreadN, 'the HN badge starts at its unread count');
  ok(!w10.document.querySelector('#tree .tree-item[data-scope="feed:fixture-verge"] .badge'), 'the caught-up feed is badgeless (the trap is set)');
  // open an HN article — markRead → patchTreeCounts with badgeless rows in the plan
  const row10 = [...w10.document.querySelectorAll('#list .row')].find((r) => /AI model beats benchmark/.test(r.querySelector('.row-title').textContent));
  row10.dispatchEvent(new w10.MouseEvent('click', { bubbles: true }));
  await settle(150);
  ok(Number(w10.document.querySelector('#tree .tree-item[data-scope="feed:fixture-hn"] .badge').textContent) === unreadN - 1, 'the sidebar badge still updates with badgeless caught-up feeds in the tree');
  ok(titleCount10() === unreadN - 1, 'the (N) title counter updates too — the handler no longer dies mid-click');
  // and a toggle-read round trip in the same trapped state (re-query: renders replace rows)
  [...w10.document.querySelectorAll('#list .row')].find((r) => /AI model beats benchmark/.test(r.querySelector('.row-title').textContent)).dispatchEvent(new w10.MouseEvent('click', { bubbles: true })); // collapse
  await settle(60);
  const row10b = [...w10.document.querySelectorAll('#list .row')].find((r) => /AI model beats benchmark/.test(r.querySelector('.row-title').textContent));
  row10b.querySelector('[data-act="toggle-read"]').dispatchEvent(new w10.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(titleCount10() === unreadN, 'toggling back to unread also updates the counters');
  dom10.window.close();
}

console.log('mark-all round trip: mass read clears un-read guards, mass unread re-arms them (no read↔unread seesaw)');
{
  const dom7 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w7 = dom7.window;
  const cfg7 = { ...config, filters: [...config.filters, { id: 'test-markread', name: 'mr', feeds: ['fixture-bbc'], include: { title: ['Election'] }, actions: { markRead: true } }] };
  w7.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(cfg7) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(allFeeds) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  w7.eval(appSrc);
  await settle(1200);
  const badge7 = () => Number(w7.document.querySelector('#badge-all-items').textContent);
  const rowByTitle7 = (re) => [...w7.document.querySelectorAll('#list .row')].find((r) => re.test(r.querySelector('.row-title').textContent));
  const refresh7 = async () => {
    w7.document.querySelector('#menu-refresh').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
    await settle(600);
  };
  // switch to All articles so every row is visible/clickable
  w7.document.querySelector('#btn-more').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(20);
  w7.document.querySelector('#status-items [data-status="all"]').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge7() === TOTAL - HIDDEN - 1, 'the markRead filter auto-read its match at load (Election update)');
  // 1. un-read it by hand → guard set (covered by dom6, restated for the trip)
  rowByTitle7(/^Election update$/).querySelector('[data-act="toggle-read"]').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge7() === TOTAL - HIDDEN, 'explicit un-read wins for now');
  // 2. mark ALL read — must clear the guard
  w7.document.querySelector('#btn-mark-all').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(30);
  w7.document.querySelector('#confirm-yes').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(200);
  ok(badge7() !== TOTAL - HIDDEN, 'mark-all-as-read landed');
  const guardAfterRead = JSON.parse(w7.localStorage.getItem('ghrss:userUnread') || '{}');
  ok(!guardAfterRead['fixture-bbc-0'], 'mass read CLEARED the stale un-read guard (no ghost guard survives)');
  // 3. mark ALL unread — must ARM a guard for the filter's article
  w7.document.querySelector('#btn-mark-all').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(30);
  w7.document.querySelector('#confirm-yes').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(200);
  const guardAfterUnread = JSON.parse(w7.localStorage.getItem('ghrss:userUnread') || '{}');
  ok(guardAfterUnread['fixture-bbc-0'], 'mass unread ARMS a guard for the filter-owned article');
  await refresh7();
  ok(badge7() === TOTAL - HIDDEN, 'after the refresh the filter article is STILL unread — the guard beats the filter re-run (no seesaw)');
  ok(rowByTitle7(/^Election update$/).classList.contains('unread'), '…and the row shows unread');
  dom7.window.close();
}

console.log('bulk mark: the same guard rules as mark-all (explicit, filter-proof, undo-able)');
{
  const dom8 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w8 = dom8.window;
  const cfg8 = { ...config, filters: [...config.filters, { id: 'test-markread', name: 'mr', feeds: ['fixture-bbc'], include: { title: ['Election'] }, actions: { markRead: true } }] };
  w8.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(cfg8) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(allFeeds) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  w8.eval(appSrc);
  await settle(1200);
  const badge8 = () => Number(w8.document.querySelector('#badge-all-items').textContent);
  // All articles view + bulk mode on
  w8.document.querySelector('#btn-more').dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
  await settle(20);
  w8.document.querySelector('#status-items [data-status="all"]').dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
  await settle(20);
  w8.document.querySelector('#btn-more').dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
  await settle(20);
  w8.document.querySelector('#menu-select-mode').dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
  await settle(80);
  const election8 = [...w8.document.querySelectorAll('#list .row')].find((r) => /Election update/.test(r.querySelector('.row-title').textContent));
  election8.querySelector('.row-check').dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
  await settle(30);
  // bulk UNREAD the filter-read article
  w8.document.querySelector('#bulk-unread').dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
  await settle(120);
  const guard8 = JSON.parse(w8.localStorage.getItem('ghrss:userUnread') || '{}');
  ok(guard8['fixture-bbc-0'], 'bulk un-read arms the guard for a filter-owned article');
  w8.document.querySelector('#menu-refresh').dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok(badge8() === TOTAL - HIDDEN, 'the bulk un-read survives the filter re-running');
  dom8.window.close();
}

console.log('settings modal: the mark-read duration is finally user-settable, persists, and beats config.json');
{
  const dom9 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w9 = dom9.window;
  w9.fetch = window.fetch; // default config: markReadOnOpen true, delay 0
  w9.eval(appSrc);
  await settle(1200);
  // open ⋯ → Settings
  w9.document.querySelector('#btn-more').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await settle(20);
  w9.document.querySelector('#menu-settings').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await settle(20);
  ok(!w9.document.querySelector('#settings-modal').classList.contains('hidden'), 'the settings modal opens');
  ok(w9.document.querySelector('#set-mark-on-open').checked === true, 'the checkbox shows the config default (mark on open)');
  ok(w9.document.querySelector('#set-mark-after').value === '0', 'the delay input shows the config default (0)');
  ok(/the moment you open/.test(w9.document.querySelector('#set-mark-hint').textContent), 'the hint explains instant marking');
  // set a 1-second delay
  const after = w9.document.querySelector('#set-mark-after');
  after.value = '1';
  after.dispatchEvent(new w9.Event('change', { bubbles: true }));
  await settle(20);
  ok(/1 second after you open/.test(w9.document.querySelector('#set-mark-hint').textContent), 'the hint reflects the new delay');
  const ui9 = JSON.parse(w9.localStorage.getItem('ghrss:ui') || '{}');
  ok(ui9.settings?.markReadAfterSeconds === 1, 'the override persists to ghrss:ui.settings');
  // close with Escape, then the delay must govern real opens
  w9.document.dispatchEvent(new w9.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(20);
  ok(w9.document.querySelector('#settings-modal').classList.contains('hidden'), 'Escape closes the settings modal');
  const badge9 = () => Number(w9.document.querySelector('#badge-all-items').textContent);
  const before9 = badge9();
  w9.document.querySelector('#list .row').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge9() === before9, 'with a 1s delay the open does NOT mark instantly');
  await settle(1100);
  ok(badge9() === before9 - 1, 'the configured delay marks it read a second later');
  dom9.window.close();

  // precedence: a saved local override wins over config.json on the next load
  const dom9b = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w9b = dom9b.window;
  w9b.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone({ ...config, settings: { ...config.settings, markReadOnOpen: true, markReadAfterSeconds: 99 } }) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(allFeeds) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  w9b.localStorage.setItem('ghrss:ver', '3');
  w9b.localStorage.setItem('ghrss:ui', JSON.stringify({ settings: { markReadOnOpen: false, markReadAfterSeconds: 0 } }));
  w9b.eval(appSrc);
  await settle(1200);
  const badge9b = () => Number(w9b.document.querySelector('#badge-all-items').textContent);
  const before9b = badge9b();
  w9b.document.querySelector('#list .row').dispatchEvent(new w9b.MouseEvent('click', { bubbles: true }));
  await settle(900);
  ok(badge9b() === before9b, 'the saved local override (manual marking) beats config.json\'s mark-on-open');
  dom9b.window.close();
}

console.log('progressive rendering: 400 rows chunk in, scroll grows the list, deep links materialize their row');
{
  const mkBig = (n) => Array.from({ length: n }, (_, i) => ({
    id: `big-${i}`, title: `Big story ${i}`, link: `https://example.com/big/${i}`,
    date: now - i * 60e3, author: null, summary: `s${i}`, content: `<p>body ${i}</p>`,
    text: null, enclosures: [], fetchedAt: now,
  }));
  const bigFix = { 'fixture-big': { title: 'Big Feed', site: 'https://big.test', folder: 'tech', articles: mkBig(400) } };
  const bigIndex = { generatedAt: now, folders: [], feeds: { 'fixture-big': { title: 'Big Feed', site: 'https://big.test', folder: 'tech', folders: ['tech'], count: 400, newest: now, oldest: now - 400 * 60e3 } } };
  const bigAll = { articles: bigFix['fixture-big'].articles.map((a) => ({ ...a, _feed: 'fixture-big' })) };
  const bootBig = async (w, url) => {
    w.fetch = async (reqUrl) => {
      const p = String(reqUrl).split('?')[0];
      if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
      if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(bigIndex) };
      if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(bigAll) };
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
    };
    w.eval(appSrc);
    await settle(1200);
  };
  const domB = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wB = domB.window;
  await bootBig(wB);
  ok(wB.document.querySelectorAll('#list .row').length === 150, 'only the first chunk (150 rows) renders at boot');
  ok(!!wB.document.querySelector('#list-tail'), 'the tail sentinel marks the unrendered remainder');
  ok(Number(wB.document.querySelector('#badge-all-items').textContent) === 400, 'the badge still counts all 400 unread');
  ok(wB.document.querySelector('#scope-count').textContent === '400 unread', 'the count chip is NOT clipped to the rendered chunk');
  // scroll event → the tail grows (bounded loop, zero geometry in jsdom)
  wB.document.querySelector('#list').dispatchEvent(new wB.Event('scroll', { bubbles: false }));
  await settle(120); // rAF tick
  ok(wB.document.querySelectorAll('#list .row').length === 400, 'a scroll event materializes the rest of the list');
  ok(!wB.document.querySelector('#list-tail'), 'the sentinel retires once everything is rendered');
  // mark-all still covers the whole list (ids come from state, not the DOM)
  wB.document.querySelector('#btn-mark-all').dispatchEvent(new wB.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wB.document.querySelector('#confirm-yes').dispatchEvent(new wB.MouseEvent('click', { bubbles: true }));
  await settle(200);
  ok(wB.document.querySelector('#badge-all-items').textContent === '', 'mark-all-as-read covered every article — rendered or not');
  const lsB = JSON.parse(wB.localStorage.getItem('ghrss:read') || '{}');
  ok(Object.keys(lsB).length === 400, 'all 400 ids landed in the read state');
  domB.window.close();

  // deep link into the unrendered tail: the row must materialize
  const domD = new JSDOM(html, { url: 'https://example.test/#article/big-350', runScripts: 'outside-only', pretendToBeVisual: true });
  const wD = domD.window;
  await bootBig(wD, '#article/big-350');
  ok(!!wD.document.querySelector('#reader-slot .reader') && wD.document.querySelector('#reader-slot .reader').dataset.id === 'big-350', 'a deep link into the tail opens the article');
  ok(!!wD.document.querySelector('.row[data-id="big-350"]'), 'the deep-linked row is materialized in the DOM (renderUpTo)');
  domD.window.close();
}

console.log('mark-as-unread by age: the cutoff is WHEN YOU READ IT, not when it was published');
{
  // User report (2026-10-23): "when i mark as unread, for example when i do for
  // older than 2 days, instead of like keeping everything from 2 days ago and
  // everything after the 2 days begin read, it instead unreads the whole history
  // instead of that two days." The old code compared the PUBLISHED date against
  // the cutoff: an article published three days ago that the user read an HOUR
  // ago went back to unread — and across a 60-day retention window nearly every
  // read article is "published older than two days", so the action reliably
  // un-read the entire reading history. The restore cutoff must compare the
  // READ timestamp: "older than two days" = read more than two days ago.
  const D = 864e5;
  const nowU = Date.now();
  const art = (id, ageDays, title) => ({
    id, title, link: `https://example.test/${id}`, date: nowU - ageDays * D,
    author: null, summary: title, content: `<p>${title}</p>`, text: null, enclosures: [], fetchedAt: nowU,
  });
  // A realistic 60-day backlog: publication ages scattered across the window.
  const articles = [
    art('u-fresh', 0.02, 'Published half an hour ago'),
    art('u-1d', 1, 'Published a day ago'),
    art('u-3d', 3, 'Published three days ago'),
    art('u-10d', 10, 'Published ten days ago'),
    art('u-40d', 40, 'Published forty days ago'),
    art('u-55d', 55, 'Published fifty-five days ago'),
  ];
  // The user's reading history — WHAT they read, and WHEN:
  const readSeed = {
    'u-fresh': nowU - 2 * 3600e3, // read 2 h ago (published 30 min ago)
    'u-3d': nowU - 1 * 3600e3,    // read an HOUR ago — the exact reported case
    'u-10d': nowU - 5 * D,        // read five days ago
    'u-40d': nowU - 5 * D,        // read five days ago
    'u-55d': nowU - 20 * D,       // read twenty days ago
    // 'u-1d' deliberately unread
  };
  const idxU = { generatedAt: nowU, folders: [], feeds: { 'fixture-age': { title: 'Age Feed', site: 'https://age.test', folder: null, folders: [], count: articles.length, newest: articles[0].date, oldest: articles.at(-1).date } } };
  const domU = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wU = domU.window;
  wU.fetch = async (reqUrl) => {
    const p = String(reqUrl).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(idxU) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone({ articles: articles.map((a) => ({ ...a, _feed: 'fixture-age' })) }) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  // Seed the reading history BEFORE boot (and pin the storage version, or the
  // one-time versioned reset wipes the seed at eval time).
  wU.localStorage.setItem('ghrss:ver', '3');
  wU.localStorage.setItem('ghrss:read', JSON.stringify(readSeed));
  wU.eval(appSrc);
  await settle(1200);
  const unreadRow = (id) => {
    const r = wU.document.querySelector(`#list .row[data-id="${id}"]`);
    return r ? r.classList.contains('unread') : null;
  };
  // All-articles view: read rows are rendered there (the default Unread view
  // hides them).
  wU.document.querySelector('#btn-more').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  wU.document.querySelector('#status-items [data-status="all"]').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(wU.document.querySelectorAll('#list .row').length === 6, 'all six rows render in the All-articles view');
  ok(unreadRow('u-3d') === false && unreadRow('u-fresh') === false, 'sanity: the seeded reads render as read');
  ok(unreadRow('u-10d') === false && unreadRow('u-40d') === false && unreadRow('u-55d') === false, 'sanity: the old reads render as read');
  // Filter-invisible restore: with the Date filter on Today, every row the
  // restore touches is older than the filter — the toast must say so and
  // carry one-click Show all, and the empty state must name the hidden unread.
  const drU = wU.document.querySelector('#date-range');
  drU.value = 'today';
  drU.dispatchEvent(new wU.Event('change', { bubbles: true }));
  await settle(80);
  ok(wU.document.querySelectorAll('#list .row').length === 1, 'the Today filter narrows the view to the fresh article');
  // Not caught up (u-1d is unread) → the expander reveals the unread group.
  wU.document.querySelector('#btn-mark-all-split').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  wU.document.querySelector('#mark-alt-toggle').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  wU.document.querySelector('#mark-menu [data-mark="unread"][data-older="2"]').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(400);
  const toastU = wU.document.querySelector('#toast-text').textContent;
  ok(toastU.includes('Marked 3 articles you read more than two days ago as unread'), 'the toast counts by READING age (three old reads, not four)');
  ok(toastU.includes('— hidden by the date filter'), 'the toast names the filter that hides every restored row');
  ok(wU.document.querySelector('#toast-action-2').textContent === 'Show all', 'the one-click Show-all companion rides along');
  const lsU = JSON.parse(wU.localStorage.getItem('ghrss:read') || '{}');
  ok(JSON.stringify(Object.keys(lsU).sort()) === JSON.stringify(['u-3d', 'u-fresh']), 'THE REPORTED CASE, persisted: read an hour ago (published 3 days ago) → the read entry SURVIVES');
  // Unread view under the Today filter: the restored rows are all outside it.
  wU.document.querySelector('#btn-more').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  wU.document.querySelector('#status-items [data-status="unread"]').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(wU.document.querySelector('#empty h3').textContent === 'Nothing in this time range', 'the empty state names the filter instead of celebrating');
  const emptyU = wU.document.querySelector('#empty p').textContent;
  ok(emptyU.includes('4 unread articles') && emptyU.includes('older than Today'), 'the empty state counts the hidden unread (the three restored + the never-read)');
  wU.document.querySelector('#toast-action-2').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(wU.document.querySelector('#date-range').value === 'all', 'Show all resets the Date filter');
  ok(wU.document.querySelectorAll('#list .row').length === 4, 'Show all reveals the restored rows (three + the never-read)');
  // All-articles view: per-row read/unread truth.
  wU.document.querySelector('#btn-more').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  wU.document.querySelector('#status-items [data-status="all"]').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(unreadRow('u-3d') === false, 'THE REPORTED CASE, rendered: read an hour ago (published 3 days ago) → row stays READ');
  ok(unreadRow('u-fresh') === false, 'read 2 h ago → stays read');
  ok(unreadRow('u-10d') === true && unreadRow('u-40d') === true && unreadRow('u-55d') === true, 'reads from 5/20 days ago come back unread');
  ok(unreadRow('u-1d') === true, 'the never-read article is untouched');
  ok(Number(wU.document.querySelector('#badge-all-items').textContent) === 4, 'badge: 4 unread (the restored three + the never-read one)');
  // …and the READ direction still keys on PUBLICATION age (Inoreader-style
  // backlog clearing): the three restored ones are published > 2 days ago.
  wU.document.querySelector('#btn-mark-all-split').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  wU.document.querySelector('#mark-menu [data-mark="read"][data-older="2"]').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(300);
  ok(wU.document.querySelector('#toast-text').textContent.includes('Marked 3 articles older than two days as read'), 'mark-as-read still counts by PUBLICATION age');
  ok(unreadRow('u-1d') === true, 'the day-old unread article survives mark-read-older-than-two-days (published < 2 days ago)');
  ok(unreadRow('u-10d') === false && unreadRow('u-40d') === false && unreadRow('u-55d') === false, 'the three old-published unread ones were cleared');
  domU.window.close();
}

console.log('recently-read scope: restore-by-reading-age inside the 7-day view');
{
  const D = 864e5;
  const nowV = Date.now();
  const art = (id, ageDays, title) => ({
    id, title, link: `https://example.test/${id}`, date: nowV - ageDays * D,
    author: null, summary: title, content: `<p>${title}</p>`, text: null, enclosures: [], fetchedAt: nowV,
  });
  const articles = [
    art('v-a', 2, 'Read twelve hours ago'),
    art('v-b', 1, 'Read three days ago'),
    art('v-c', 20, 'Read six and a half days ago'),
    art('v-d', 30, 'Read twelve days ago'),
    art('v-e', 0.5, 'Never read'),
  ];
  const readSeed = {
    'v-a': nowV - 12 * 3600e3,
    'v-b': nowV - 3 * D,
    'v-c': nowV - 6.5 * D,
    'v-d': nowV - 12 * D, // outside the 7-day "recently read" window
  };
  const idxV = { generatedAt: nowV, folders: [], feeds: { 'fixture-rr': { title: 'RR Feed', site: 'https://rr.test', folder: null, folders: [], count: articles.length, newest: articles[0].date, oldest: articles.at(-1).date } } };
  const domV = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wV = domV.window;
  wV.fetch = async (reqUrl) => {
    const p = String(reqUrl).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(idxV) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone({ articles: articles.map((a) => ({ ...a, _feed: 'fixture-rr' })) }) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  wV.localStorage.setItem('ghrss:ver', '3');
  wV.localStorage.setItem('ghrss:read', JSON.stringify(readSeed));
  wV.eval(appSrc);
  await settle(1200);
  // Enter the Recently read view (⋯ → Recently read).
  wV.document.querySelector('#btn-more').dispatchEvent(new wV.MouseEvent('click', { bubbles: true }));
  await settle(20);
  wV.document.querySelector('#status-items [data-status="recently-read"]').dispatchEvent(new wV.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(wV.document.querySelectorAll('#list .row').length === 3, 'the view lists exactly the reads from the last 7 days');
  wV.document.querySelector('#btn-mark-all-split').dispatchEvent(new wV.MouseEvent('click', { bubbles: true }));
  await settle(20);
  // The view can only ever list reads ≤ 7 days old, so the unread group's
  // week/month presets are structurally dead here (nothing "read more than a
  // week ago" can be IN this view) — they hide, like the Today-scope rows.
  const hidden7 = wV.document.querySelector('#mark-menu [data-mark="unread"][data-older="7"]').classList.contains('hidden');
  const hidden31 = wV.document.querySelector('#mark-menu [data-mark="unread"][data-older="31"]').classList.contains('hidden');
  const shown1 = !wV.document.querySelector('#mark-menu [data-mark="unread"][data-older="1"]').classList.contains('hidden');
  const shown2 = !wV.document.querySelector('#mark-menu [data-mark="unread"][data-older="2"]').classList.contains('hidden');
  const readPresetsLive = [...wV.document.querySelectorAll('#mark-menu [data-mark="read"][data-older]')].every((b) => !b.classList.contains('hidden'));
  ok(hidden7 && hidden31, 'unread week/month presets hide in the Recently read view (dead: the view caps at 7 days of reads)');
  ok(shown1 && shown2, 'unread day/two-day presets stay (reads 1–7 days old exist here)');
  ok(readPresetsLive, 'the read group keeps its presets (publication age, unbounded by the view)');
  wV.document.querySelector('#mark-menu [data-mark="unread"][data-older="1"]').dispatchEvent(new wV.MouseEvent('click', { bubbles: true }));
  await settle(300);
  ok(wV.document.querySelector('#toast-text').textContent.includes('Marked 2 articles you read more than a day ago as unread'), 'restore counts reads older than a day inside the view (v-b, v-c — not v-a, not v-d)');
  ok(wV.document.querySelectorAll('#list .row').length === 1, 'the un-read articles left the Recently read view (only the 12-hour read remains)');
  const rowA = wV.document.querySelector('#list .row[data-id="v-a"]');
  ok(!!rowA && !rowA.classList.contains('unread'), 'the twelve-hour-old read stays read');
  domV.window.close();
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
dom.window.close();
process.exit(fail ? 1 : 0);
