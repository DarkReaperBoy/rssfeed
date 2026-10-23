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
ok($('#toast-text').textContent.includes('No read articles older than a month here — data goes back to'), 'unread-side month cutoff also names the boundary');
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
  wH.document.dispatchEvent(new wH.Event('DOMContentLoaded', { bubbles: true }));
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
  ok(wH.document.querySelector('#toast-text').textContent.includes('No read articles older than a day here'), 'mark clicks always respond — stalled fetches cannot dead-end them');
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
  wS.document.dispatchEvent(new wS.Event('DOMContentLoaded', { bubbles: true }));
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
  wR.document.dispatchEvent(new wR.Event('DOMContentLoaded', { bubbles: true }));
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
  ok(hn.hnApiUrl({ minPoints: 150 }, { retentionDays: 60, now: NOW }).includes(`created_at_i%3E${START}`), 'window bound derives from retentionDays');
  const sliced = hn.hnApiUrl({ minPoints: 150 }, { retentionDays: 60, now: NOW, fromSec: START, toSec: NOWS - 30 * 86400 });
  ok(sliced.includes('created_at_i%3C%3D'), 'range slicing encodes the closed upper bound');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
dom.window.close();
process.exit(fail ? 1 : 0);
