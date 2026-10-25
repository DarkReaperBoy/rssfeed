import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
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
      'AI model beats benchmark',
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
FIX['fixture-verge'].articles[2].text = '<p>Extracted full text present</p>';
FIX['fixture-verge'].articles[2].content = '<p>Short teaser only</p>';
// Backend filter flags ride on the article data (filters run in the fetcher, never in the browser)
FIX['fixture-verge'].articles[1].highlight = true;
const config = {
  settings: { siteName: 'My RSSFeed', theme: 'dark', refreshMinutes: 60 },
  folders: [], 
  feeds: [
    { id: 'fixture-hn', title: 'Hacker News', url: 'https://hnrss.test/frontpage', site: 'https://news.ycombinator.com', folder: 'tech' },
    { id: 'fixture-verge', title: 'The Verge', url: 'https://theverge.test/rss', site: 'https://www.theverge.com', folder: 'tech' },
    { id: 'fixture-bbc', title: 'BBC News', url: 'https://bbc.test/rss', site: 'https://www.bbc.com/news', folder: 'news' },
  ],
};
const urlOf = Object.fromEntries(config.feeds.map((f) => [f.id, f.url]));
const index = {
  generatedAt: now,
  folders: [{ id: 'tech', name: 'Technology' }, { id: 'news', name: 'News' }],
  feeds: Object.fromEntries(Object.entries(FIX).map(([id, f]) => [id, {
    title: f.title, site: f.site, xml: urlOf[id] || null,
    origTitle: id === 'fixture-verge' ? 'The Verge (source self-title)' : null,
    image: id === 'fixture-bbc' ? 'https://www.bbc.test/logo.png' : null,
    folder: f.folder, folders: [f.folder],
    count: f.articles.length, newest: f.articles[0].date, oldest: f.articles.at(-1).date,
    status: id === 'fixture-junk'
      ? { ok: false, disabled: false, lastAttempt: now - 3600e3, lastSuccess: now - 48 * 3600e3, consecutiveFailures: 3, error: 'HTTP 500' }
      : { ok: true, disabled: false, lastAttempt: now - 600e3, lastSuccess: now - 600e3, consecutiveFailures: 0, error: null },
  }])),
};
const allFeeds = {
  articles: Object.entries(FIX).flatMap(([id, f]) => f.articles.map((a) => ({ ...a, _feed: id }))),
};
const TOTAL = Object.values(FIX).reduce((n, f) => n + f.articles.length, 0);
const html = (await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'))
  .replace(/<script src="assets\/app\.js\?v=[^"]*"><\/script>/, ''); 
const appSrc = await fs.readFile(path.join(ROOT, 'assets/app.js'), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
let dataFlip = false; 
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
ok(!$('#pdinner_today'), 'Today sidebar row removed entirely');
ok($('#tree').textContent.includes('Technology'), 'folder renders (from generated index.folders)');
ok($('#tree').textContent.includes('Hacker News'), 'feeds render');
ok(!$('#reader-placeholder'), 'reader placeholder removed');
ok(window.document.documentElement.dataset.theme === 'dark', 'config settings apply on every load (theme)');
ok(Number($('#badge-all-items').textContent) === TOTAL, 'unread badge counts all feeds');
console.log('list + filter');
let rows = $$('#list .row');
ok(rows.length === TOTAL, `rows rendered (${rows.length})`);
ok(!$$('#list .row .dot').length, 'blue unread dot removed');
ok(!$$('#list .row .star-btn').length, 'star buttons removed');
ok($$('#list .row [data-act="toggle-read"]').length === rows.length, 'every row has the read/unread tick');
ok($$('#list .row [data-act="keep"]').length === rows.length, 'every row has keep-unread');
ok($$('#list .row').filter((r) => r.querySelector('.feed-name')?.textContent === 'Hacker News' && /show hn/i.test(r.querySelector('.row-title').textContent)).length === 0, 'backend-hidden articles are simply absent (the two Show HN threads never shipped in the data)');
ok($$('#list .row.highlight').length === 1 && /laptop/i.test($$('#list .row.highlight .row-title')[0].textContent), 'a backend highlight flag tints ONLY the flagged row');
console.log('default sort: oldest → newest');
ok($$('#list .row')[0].dataset.id === 'fixture-hn-9', 'the list opens oldest-first by default (the oldest article leads)');
ok($('#sort-items [data-sort="oldest"]').classList.contains('on'), 'the sort menu marks "Oldest first" as the active default');
click('#btn-more');
await settle(20);
click('#sort-items [data-sort="newest"]');
await settle(80);
ok($$('#list .row').at(-1).dataset.id === 'fixture-hn-9', 'toggling "Newest first" flips the order (the oldest article is now last)');
ok(JSON.parse(window.localStorage.getItem('ghrss:ui') || '{}').sortDir === 'newest', 'the sort choice persists');
click('#sort-items [data-sort="oldest"]');
await settle(80);
ok($$('#list .row')[0].dataset.id === 'fixture-hn-9', 'back to oldest-first for the rest of the flow');
click('#btn-more');
await settle(20);
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
ok(Number($('#badge-all-items').textContent) === TOTAL - 1, 'opening marks read');
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
  click($(`#list .row[data-id="${ftId}"] [data-act="toggle-read"]`)); 
  await settle(50);
  ok(Number($('#badge-all-items').textContent) === TOTAL - 1, 'state restored to one read article');
  click($('#reader-slot [data-act="collapse"]'));
  await settle(50);
  ok(!window.document.body.classList.contains('article-open'), 'reader collapsed');
}
console.log('double-click keeps the read row');
click($('#list .row')); 
await settle(30);
click($('#list .row')); 
await settle(50);
ok(!window.document.body.classList.contains('article-open'), 'reader closed');
ok(rowCount() === TOTAL, 'double-clicked article stays in the list (marked read, not removed)');
ok(!$('#list .row').classList.contains('unread'), 'the row now shows as read');
ok(Number($('#badge-all-items').textContent) === TOTAL - 1, 'badge unchanged by the collapse');
ok(!window.location.hash, 'collapsing the reader clears the hash (no history spam)');
console.log('moving on keeps the read row (Back/prev/k can still return to it)');
const secondRow = $$('#list .row')[1];
const secondId = secondRow.dataset.id;
click(secondRow);
await settle(50);
ok(rowCount() === TOTAL, 'the previously read row lingers (tick flips in place, no vanish)');
ok(!!$(`#list .row[data-id="${firstId}"]`), 'the old row is still in the list for Back/Previous to return to');
ok(window.document.body.classList.contains('article-open'), 'new article is selected');
console.log('browser Back/Forward (deep-link history)');
window.location.hash = `#article/${firstId}`; 
window.dispatchEvent(new window.Event('hashchange')); 
await settle(50);
ok($('#reader-slot .reader')?.dataset.id === firstId, 'Back reopens the previous article');
ok($(`#list .row[data-id="${firstId}"]`), 'Backed-into article is in the list again (it was read)');
window.location.hash = `#article/${secondId}`; 
window.dispatchEvent(new window.Event('hashchange'));
await settle(50);
ok($('#reader-slot .reader')?.dataset.id === secondId, 'Forward returns to the next article');
console.log('popstate-driven navigation (WebView hardening)');
window.location.hash = `#article/${firstId}`;
window.dispatchEvent(new window.Event('popstate')); 
await settle(50);
ok($('#reader-slot .reader')?.dataset.id === firstId, 'popstate-driven Back reopens the article');
window.location.hash = `#article/${secondId}`;
window.dispatchEvent(new window.Event('popstate'));
await settle(50);
ok($('#reader-slot .reader')?.dataset.id === secondId, 'popstate-driven Forward returns to the article');
console.log('mark unread');
click(`#list .row[data-id="${secondId}"] [data-act="toggle-read"]`);
await settle(50);
ok(Number($('#badge-all-items').textContent) === TOTAL - 1, 'mark unread restores count (the first article stays read)');
console.log('keep unread actually un-reads');
ok(!!$(`#list .row[data-id="${firstId}"]`), 'the read row lingers in place');
click(`#list .row[data-id="${firstId}"] [data-act="keep"]`);
await settle(50);
ok(Number($('#badge-all-items').textContent) === TOTAL, 'keep-unread deletes the read entry too (the badge counts it again)');
ok($(`#list .row[data-id="${firstId}"] [data-act="keep"]`)?.getAttribute('aria-pressed') === 'true', 'the keep button reports its pressed state');
ok($(`#list .row[data-id="${firstId}"] [data-act="keep"] use`)?.getAttribute('href') === '#i-bookmark-on', 'a kept article shows the FILLED bookmark glyph');
ok($$('#list .row')[1].querySelector('[data-act="keep"] use')?.getAttribute('href') === '#i-bookmark', 'an un-kept article shows the outline bookmark glyph (the old eye-off path rendered broken)');
click(`#list .row[data-id="${firstId}"] [data-act="keep"]`); 
await settle(50);
click($('#reader-slot [data-act="collapse"]'));
await settle(50);
console.log('mark-all split: the age slider');
const slider = () => $('#mark-age-slider');
const setAge = (w, days) => {
  const s = w.document.querySelector('#mark-age-slider');
  if (!s) throw new Error('mark-age slider missing');
  s.value = String(days);
  s.dispatchEvent(new w.Event('input', { bubbles: true }));
  s.dispatchEvent(new w.Event('change', { bubbles: true }));
};
click('#btn-mark-all-split');
await settle(20);
ok(!$('#mark-menu').classList.contains('hidden'), 'mark menu opens');
ok(!$('#mark-alt-toggle'), 'the inverse-direction expander is gone — one action at a time');
ok(!$('#mark-group-read') && !$('#mark-group-unread'), 'the dual preset groups are gone');
ok(!$$('#mark-menu .dropdown-item').length, 'the age preset buttons are gone');
ok(!$('#mark-date-read') && !$('#mark-date-unread'), 'the Before…/Since… date pickers are gone');
ok(!!slider(), 'the age slider exists');
ok(slider().min === '1' && slider().max === '30' && slider().step === '1', 'the slider spans 1–30 days');
ok(Number(slider().value) === 7, 'the slider opens at its default of 7 days');
ok($('#mark-age-title').textContent === 'Mark as read', 'unread articles exist → the offered action is mark-as-read');
ok($('#mark-age-desc').textContent === 'Articles older than', 'the sentence names the cutoff');
ok($('#mark-age-value').textContent === '7 days', 'the live value reads as a sentence');
ok($('#mark-age-apply').textContent === 'Mark as read', 'the apply button names the direction');
ok($('#mark-age-count').textContent === 'Nothing to mark here', '7 days: nothing that old is unread (fixtures span ~27 h)');
ok(slider().getAttribute('aria-valuetext') === '7 days', 'the slider announces its value to screen readers');
setAge(window, 1);
await settle(20);
ok($('#mark-age-value').textContent === '1 day', 'dragging updates the value live (singular grammar)');
ok($('#mark-age-count').textContent === 'Will mark 2 articles', 'the count preview names the day-old HN pair');
ok(slider().getAttribute('aria-valuetext') === '1 day', 'the announced value tracks the drag');
click('#mark-age-apply');
await settle(80);
ok($('#toast-text').textContent.includes('Marked 2 articles older than a day as read'), 'apply marks exactly the previewed set');
ok(rowCount() === TOTAL - 2, 'marked articles re-filter out');
ok($('#mark-menu').classList.contains('hidden'), 'apply closes the menu');
click($('#toast-action'));
await settle(50);
ok(rowCount() === TOTAL, 'undo restores the rows');
console.log('the dragged value persists across opens');
click('#btn-mark-all-split');
await settle(20);
ok(Number(slider().value) === 1, 'the menu reopens at the last-used value');
ok($('#mark-age-count').textContent === 'Will mark 2 articles', 'the preview rebuilds on open');
setAge(window, 7);
click('#btn-mark-all-split');
await settle(20);
console.log('filter-invisible restores explain themselves');
click('#badge-all-items');
await settle(80);
ok(rowCount() === 0, 'caught up: the unread view is empty');
ok($('#empty h3').textContent === 'All caught up 🎉', 'the caught-up empty state shows');
click('#search-open');
await settle(20);
const nz = $('#search-input');
nz.value = 'zzz-no-such-words';
nz.dispatchEvent(new window.Event('input', { bubbles: true }));
await settle(400);
ok(rowCount() === 0, 'a no-match search empties the view');
ok($('#empty h3').textContent === 'No matches', 'the empty state names the search');
click('#btn-mark-all-split');
await settle(20);
ok($('#mark-age-title').textContent === 'Mark as unread', 'caught up → the offered action is mark-as-unread');
ok($('#mark-age-desc').textContent === 'Read articles from the last', 'the restore direction describes its window');
ok($('#mark-age-apply').textContent === 'Mark as unread', 'the apply button flips with the direction');
setAge(window, 1);
await settle(20);
ok($('#mark-age-count').textContent === 'Will mark 19 articles', 'the preview names the nineteen sub-day reads');
click('#mark-age-apply');
await settle(120);
ok($('#toast-text').textContent.includes('Marked 19 articles from a day ago as unread'), 'from-a-day-ago restores exactly the nineteen sub-day reads');
ok($('#toast-text').textContent.includes('— hidden by the search'), 'the toast names the search that hides every restored row');
ok($('#toast-action-2').textContent === 'Clear search', 'the one-click Clear-search companion rides along');
ok(rowCount() === 0, 'the restored rows stay hidden behind the search');
click($('#toast-action-2'));
await settle(200);
ok(rowCount() === 19, 'Clear search reveals the restored sub-day rows');
click('#badge-all-items');
await settle(80);
ok(rowCount() === 0, 're-marked everything read for the wide-window restore');
click('#btn-mark-all-split');
await settle(20);
setAge(window, 30);
await settle(20);
ok($('#mark-age-count').textContent === 'Will mark 21 articles', 'a 30-day window covers every read article');
click('#mark-age-apply');
await settle(120);
ok($('#toast-text').textContent.includes('Marked 21 articles from 30 days ago as unread'), 'the widest restore window un-reads everything');
ok(rowCount() === TOTAL, 'every fixture row is back');
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
ok(rowCount() === TOTAL, 'closing search clears the active filter');
ok($('#search-input').value === '', 'search input cleared');
console.log('views and date filter are gone — list is the only view');
ok(!$('#layouts'), 'the ⋯ menu View section (layouts) is gone');
ok(!$('#date-range'), 'the ⋯ menu Date section is gone');
ok(!$('#menu-settings') && !$('#settings-modal'), 'the Settings entry and Reading-settings modal are gone');
ok(!$$('#mark-menu [data-read-age]').length, 'the "By when you read them" presets are gone');
ok($('#list').classList.contains('view-list'), 'the list view is the one and only view');
ok($('#list').className.includes('density-comfort'), 'the default density applies');
console.log('header menus: minimal and reordered — Today / Recently read / Multiple select are gone');
click('#btn-more');
await settle(30);
ok(!$('#header-menu').classList.contains('hidden'), 'header menu opens');
ok(!$$('#status-items [data-status="today"]').length, 'no Today status item');
ok(!$$('#status-items [data-status="recently-read"]').length, 'no Recently read status item');
ok($$('#status-items .dropdown-item').length === 2, 'exactly two list statuses remain (All / Unread)');
ok(!$('#menu-select-mode'), 'no Multiple select entry');
ok(!$('#bulk-bar'), 'the bulk action bar is gone');
ok(!$('#i-bulk') && !$('#i-today') && !$('#i-eyeoff'), 'dead SVG symbols removed (bulk, today, eye-off)');
const menuOrder = $$('#header-menu .dropdown-item').map((b) => b.id || b.dataset.status || b.dataset.sort);
ok(JSON.stringify(menuOrder) === JSON.stringify(['all', 'unread', 'menu-refresh', 'newest', 'oldest', 'menu-reset-read']), `menu order: statuses → refresh → sort → reset (${menuOrder.join(', ')})`);
ok(!$('#btn-show-filtered'), 'the "Show filtered-out articles" button is gone (hidden articles never reach the browser)');
ok(!html.includes('id="i-eye"'), 'the now-unused eye icon symbol is pruned with it');
ok(!$('.row [title="Filtered"]'), 'no [filtered] tags: filtering is server-side only');
click('#btn-more');
await settle(20);
console.log('reset read state (menu)');
click('#btn-more');
await settle(20);
click('#menu-reset-read');
await settle(20);
ok(!$('#confirm-modal').classList.contains('hidden'), 'reset read state asks for confirmation');
click('#confirm-yes');
await settle(50);
ok(Number($('#badge-all-items').textContent) === TOTAL, 'reset makes every article unread');
ok(window.localStorage.getItem('ghrss:read') === '{}', 'stored read state is emptied');
ok(window.localStorage.getItem('ghrss:kept') === '{}', 'stored keep-unread state is emptied');
console.log('tab title format');
const tRow = $('#list .row');
const tTitle = tRow.querySelector('.row-title').textContent;
ok($('#badge-all-items').dataset.markread === 'all', 'Newsfeed badge is a working mark-all tick');
const unreadBefore = Number($('#badge-all-items').textContent);
click(tRow);
await settle(50);
ok(window.document.title === `(${unreadBefore - 1}) My RSSFeed - ${tTitle}`, 'open article → "(N) My RSSFeed - Article title"');
await settle(20);
click($('#list .row')); 
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
click('#btn-mark-all-split');
await settle(20);
ok($('#mark-age-title').textContent === 'Mark as unread', 'caught up → the menu offers mark-as-unread');
click('#btn-mark-all-split');
await settle(20);
click('#btn-mark-all');
await settle(20);
ok(!$('#confirm-modal').classList.contains('hidden'), 'mark-as-unread asks for confirmation');
click('#confirm-yes');
await settle(50);
ok(rowCount() === rowsBeforeMarkAll, 'mark as unread restores every article');
ok($('#toast-text').textContent.includes('articles as unread'), 'restore toast reports the count');
ok($('#btn-mark-all').title === 'Mark all as read', 'button flips back once articles are unread');
click('#btn-mark-all-split');
await settle(20);
ok($('#mark-age-title').textContent === 'Mark as read', 'the menu flips back with the articles');
click('#btn-mark-all-split');
await settle(20);
click('#badge-all-items'); 
await settle(50);
ok(rowCount() === 0, 'badge tick re-marks everything read');
click('#btn-mark-all-split');
await settle(20);
setAge(window, 1);
await settle(20);
click('#mark-age-apply');
await settle(80);
ok($('#toast-text').textContent.includes('Marked 19 articles from a day ago as unread'), 'bulk mark-all-read, then from-a-day-ago: exactly the sub-day news returns');
ok(rowCount() === 19, 'exactly the nineteen sub-day articles came back');
ok($('#btn-mark-all').title === 'Mark all as read', 'with unread articles back, the button offers read again');
click('#badge-all-items');
await settle(50);
ok(rowCount() === 0, 'badge tick re-marks everything read for the caught-up restore');
click('#btn-mark-all'); 
await settle(20);
click('#confirm-yes');
await settle(50);
ok(rowCount() === rowsBeforeMarkAll, 'the plain caught-up restore still brings everything back');
console.log('the widest restore window un-reads everything');
click('#badge-all-items'); 
await settle(50);
ok(rowCount() === 0, 'badge tick re-marks everything read for the window test');
click('#btn-mark-all-split');
await settle(20);
setAge(window, 30);
await settle(20);
ok($('#mark-age-count').textContent === 'Will mark 21 articles', 'the 30-day restore window covers every read article');
click('#mark-age-apply');
await settle(120);
ok(rowCount() === rowsBeforeMarkAll, 'the widest window restores every read article');
console.log('zero-result toasts name the data boundary');
click('#btn-mark-all-split');
await settle(20);
setAge(window, 30);
await settle(20);
ok($('#mark-age-count').textContent === 'Nothing to mark here', 'nothing is older than 30 days (fixtures span ~27 h)');
click('#mark-age-apply');
await settle(120);
ok($('#toast-text').textContent.includes('No unread articles older than 30 days here'), 'read-side zero toast explains itself');
ok($('#toast-text').textContent.includes('data goes back to'), 'a cutoff past the data start names the boundary');
ok($('#toast-text').textContent.includes(new Date(FIX['fixture-hn'].articles.at(-1).date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })), 'the boundary date is the oldest article in the scope');
click('#tree .tree-item[data-scope="feed:fixture-hn"] .badge'); 
await settle(60);
click('.tree-item[data-scope="feed:fixture-hn"]'); 
await settle(60);
click('#btn-mark-all-split');
await settle(20);
ok($('#mark-age-title').textContent === 'Mark as unread', 'the caught-up feed view offers the restore direction');
setAge(window, 1);
await settle(20);
ok($('#mark-age-count').textContent === 'Will mark 8 articles', 'the preview names the eight sub-day reads in this feed');
click('#mark-age-apply');
await settle(120);
ok($('#toast-text').textContent.includes('Marked 8 articles from a day ago as unread'), 'from-a-day-ago un-reads exactly the eight sub-day reads in this feed');
click('#btn-mark-all-split');
await settle(20);
ok($('#mark-age-title').textContent === 'Mark as read', 'with the eight back, the read direction returns');
setAge(window, 1);
await settle(20);
ok($('#mark-age-count').textContent === 'Nothing to mark here', 'the eight unread articles are all sub-day');
click('#mark-age-apply');
await settle(120);
ok($('#toast-text').textContent === 'No unread articles older than a day here', 'cutoff within the data window: plain zero-result toast, no boundary clause');
click('.tree-item[data-scope="feed:fixture-hn"] .badge');
await settle(80);
click('#btn-mark-all');
await settle(20);
ok(!$('#confirm-modal').classList.contains('hidden'), 'caught up again → the button offers the mass un-read');
click('#confirm-yes');
await settle(80);
ok(rowCount() === 10, 'the caught-up restore brings the feed back (10 visible HN articles)');
click('.tree-item[data-scope="all"]'); 
await settle(60);
click('#badge-all-items'); 
await settle(60);
click('#btn-mark-all'); 
await settle(20);
click('#confirm-yes');
await settle(80);
ok(rowCount() === rowsBeforeMarkAll, 'state restored: everything unread again');
console.log('Newsfeed badge marks ALL feeds, even from inside a feed view');
click('.tree-item[data-scope="feed:fixture-verge"]'); 
await settle(60);
ok($('#scope-title').textContent === 'The Verge', 'viewing a single feed');
click('#badge-all-items'); 
await settle(150);
ok($('#toast-text').textContent.includes(`Marked ${TOTAL} articles as read`), `the Newsfeed badge covered every feed (${TOTAL}, not just the one in view)`);
click($('#toast-action'));
await settle(60);
click('.tree-item[data-scope="all"]'); 
await settle(60);
console.log('an info toast never stomps a live Undo');
click('#badge-all-items'); 
await settle(150);
ok($('#toast-action').style.display !== 'none', 'the mark-all toast carries a live Undo button');
const undoToastText = $('#toast-text').textContent;
click('#btn-more'); 
await settle(20);
click('#menu-refresh'); 
await settle(500);
ok($('#toast-text').textContent === undoToastText, 'the info toast does NOT replace the live Undo');
ok($('#toast-action').style.display !== 'none', 'the Undo button is still there');
click($('#toast-action')); 
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
const rowsMid = $$('#list .row').map((r) => r.dataset.id);
click(`#list .row[data-id="${rowsMid[3]}"]`);
await settle(60);
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
await settle(80);
ok($('#reader-slot .reader')?.dataset.id === rowsMid[2], 'k walks back to the article above (the just-read row lingers)');
click('#btn-mark-all-split');
await settle(20);
setAge(window, 3);
await settle(20);
ok(!$('#mark-menu').classList.contains('hidden'), 'slider input events keep the menu open');
click('#mark-age-slider');
await settle(20);
ok(!$('#mark-menu').classList.contains('hidden'), 'clicking the slider keeps the menu open');
click('#btn-mark-all-split');
await settle(20);
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
click('#badge-all-items'); 
await settle(50);
click('#btn-mark-all-split');
await settle(20);
setAge(window, 30);
await settle(20);
click('#mark-age-apply');
await settle(120);
ok(rowCount() === rowsBeforeMarkAll, 'the 30-day restore clears the navigation reads before the folder test');
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
click('.tree-item[data-scope="all"]'); 
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
console.log('YouTube chapter timestamps become seekable links (Inoreader parity)');
{
  const vid = 'dQw4w9WgXcQ';
  const watch = `https://www.youtube.com/watch?v=${vid}`;
  const ytArts = [
    { id: 'yts-1', title: 'The Linux video with chapters', link: watch, date: now - 3600e3, author: 'Chan', summary: 's',
      content: '<p>Chapters:<br>0:00 The Hacker News post<br>1:07 Some brief context<br>2:04 The bugs in question<br>6:40 And then there\'s Chainguard<br>8:43 Why talk about this on a Linux channel?<br>10:03 The other half of the title<br>14:55 Outtakes<br>1:02:03 Hour-form chapter</p>',
      text: null, enclosures: [], fetchedAt: now },
    { id: 'yts-2', title: 'Not a video', link: 'https://example.test/plain', date: now - 2 * 3600e3, author: null, summary: 's',
      content: '<p>clock 24:61, ratio a1:07, v1.2.3, 1:2, and 1:2345 must all stay plain</p>', text: null, enclosures: [], fetchedAt: now },
    { id: 'yts-3', title: 'Link-wrapped timestamps', link: watch, date: now - 3 * 3600e3, author: null, summary: 's',
      content: '<p><a href="https://example.test/x">inside 1:07 stays</a> — outside 2:04 links</p>', text: null, enclosures: [], fetchedAt: now },
    { id: 'yts-4', title: 'Rapid fire', link: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', date: now - 4 * 3600e3, author: null, summary: 's',
      content: '<p>also watch <a href="https://www.youtube.com/watch?v=bbbbbbbbbbb">https://www.youtube.com/watch?v=bbbbbbbbbbb</a><br>0:00 start<br>1:00 one<br>2:00 two<br>3:00 three</p>', text: null, enclosures: [], fetchedAt: now },
  ];
  const idxY = { generatedAt: now, folders: [], feeds: { 'fixture-yt': { title: 'Yt Chapters', site: 'https://y.test', folder: null, folders: [], count: ytArts.length, newest: now - 3600e3, oldest: now - 3 * 3600e3 } } };
  const domY = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wY = domY.window;
  wY.fetch = async (u) => {
    const p = String(u).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(idxY) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone({ articles: ytArts.map((a) => ({ ...a, _feed: 'fixture-yt' })) }) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  wY.eval(appSrc);
  await settle(1200);
  const rowY = (id) => [...wY.document.querySelectorAll('#list .row')].find((r) => r.dataset.id === id);
  const bodyY = () => wY.document.querySelector('#reader-slot .reader-body');
  const tsAll = () => [...bodyY().querySelectorAll('a.ts')];
  rowY('yts-1').dispatchEvent(new wY.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(tsAll().length === 8, `every chapter timestamp became a link (${tsAll().length})`);
  ok(tsAll().every((a) => a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noopener noreferrer'), 'timestamp links open safely (target _blank + noopener)');
  ok(tsAll().map((a) => a.dataset.t).join(',') === '0,67,124,400,523,603,895,3723', `seconds are computed from M:SS and H:MM:SS forms (${tsAll().map((a) => a.dataset.t).join(',')})`);
  ok(tsAll().every((a) => a.href === `${watch}&t=${a.dataset.t}s`), 'each href points at the same video at that second');
  ok(tsAll()[1].textContent === '1:07' && tsAll()[7].textContent === '1:02:03', 'the visible link text stays the raw timestamp');
  ok(tsAll().every((a) => a.title === 'Jump to this point'), 'each timestamp carries its jump title');
  const facade = bodyY().querySelector('.embed[data-self="1"] .embed-facade');
  ok(!!facade, 'the article video itself renders as the click-to-play facade');
  ok(facade.querySelector('img').src === `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, 'the facade uses the video thumbnail');
  ok(!bodyY().querySelector('.embed:not([data-self="1"])'), 'no other embed was created in this article');
  console.log('plain left-click on a timestamp mounts the player at that second');
  tsAll()[3].dispatchEvent(new wY.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(60);
  const ifr = bodyY().querySelector('.embed[data-self="1"] iframe');
  ok(!!ifr && ifr.src === `https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&enablejsapi=1&start=400`, 'the 6:40 click starts the embed at 400s (autoplay from that point)');
  ok(!bodyY().querySelector('.embed[data-self="1"] .embed-facade'), 'the facade is gone once the player mounts');
  console.log('a second timestamp seeks the live player in place (no remount)');
  const sent = [];
  ifr.contentWindow.postMessage = (m) => sent.push(m);
  tsAll()[7].dispatchEvent(new wY.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(60);
  ok(sent.length === 1 && sent[0].includes('"func":"seekTo"') && sent[0].includes('3723'), 'the 1:02:03 click posts a seekTo(3723) to the running player');
  ok(bodyY().querySelector('.embed[data-self="1"] iframe') === ifr, 'the iframe was not remounted (a seek, not a reload)');
  console.log('modified clicks keep the native open-in-new-tab behavior');
  const evCtrl = new wY.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  tsAll()[2].dispatchEvent(evCtrl);
  await settle(60);
  ok(!evCtrl.defaultPrevented && sent.length === 1, 'Ctrl-click is not intercepted (the browser opens the timestamped YouTube URL)');
  wY.document.querySelector('#reader-slot [data-act="collapse"]').dispatchEvent(new wY.MouseEvent('click', { bubbles: true }));
  await settle(50);
  rowY('yts-2').dispatchEvent(new wY.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(!wY.document.querySelector('#reader-slot .reader-body a.ts'), 'a non-YouTube article never linkifies its times');
  wY.document.querySelector('#reader-slot [data-act="collapse"]').dispatchEvent(new wY.MouseEvent('click', { bubbles: true }));
  await settle(50);
  rowY('yts-3').dispatchEvent(new wY.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(wY.document.querySelectorAll('#reader-slot .reader-body a.ts').length === 1, 'only the timestamp OUTSIDE the existing link was wrapped');
  const plain = wY.document.querySelector('#reader-slot .reader-body a:not(.ts)');
  ok(!!plain && plain.textContent.includes('1:07') && !plain.querySelector('a'), 'the time inside an existing link stayed plain text (no nested anchors)');
  wY.document.querySelector('#reader-slot [data-act="collapse"]').dispatchEvent(new wY.MouseEvent('click', { bubbles: true }));
  await settle(50);
  console.log('rapid timestamp spam + a competing video link in the description');
  rowY('yts-4').dispatchEvent(new wY.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(wY.document.querySelectorAll('#reader-slot .reader-body .embed').length === 2, 'the description\'s foreign video link ALSO became a facade (plus the article\'s own)');
  ok(!!wY.document.querySelector('#reader-slot .reader-body .embed[data-self="1"]'), 'the article\'s own embed is marked apart from the foreign one');
  const rapidAnchors = [...wY.document.querySelectorAll('#reader-slot .reader-body a.ts')];
  ok(rapidAnchors.length === 4, `the four chapter times linkified (${rapidAnchors.length})`);
  const sentRapid = [];
  const selfWrap = wY.document.querySelector('#reader-slot .reader-body .embed[data-self="1"]');
  selfWrap.querySelector('button').dispatchEvent(new wY.MouseEvent('click', { bubbles: true }));
  await settle(50);
  const rapidIfr = selfWrap.querySelector('iframe');
  ok(!!rapidIfr && rapidIfr.src.includes('/embed/aaaaaaaaaaa'), 'playing the article video mounts the self embed');
  rapidIfr.contentWindow.postMessage = (m) => sentRapid.push(m);
  for (let i = 0; i < 30; i++) rapidAnchors[i % rapidAnchors.length].dispatchEvent(new wY.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(150);
  ok(sentRapid.length === 30 && sentRapid.every((m) => m.includes('"func":"seekTo"')), `30 rapid timestamp clicks all became seeks (${sentRapid.length})`);
  ok(selfWrap.querySelector('iframe') === rapidIfr, 'the spam never remounted the player');
  ok(wY.document.querySelectorAll('#reader-slot .reader-body .embed').length === 2, 'both embeds stay exactly as they were');
  domY.window.close();
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
console.log('reset the stage: everything back to unread');
click('#badge-all-items');
await settle(150);
click('#btn-mark-all');
await settle(20);
click('#confirm-yes');
await settle(80);
ok(rowCount() === TOTAL, 'back in the Newsfeed with every article unread');
console.log('shareable folder/feed links (#folder/…, #feed/…)');
click('.tree-item[data-scope="folder:tech"]');
await settle(60);
ok(window.location.hash === '#folder/Technology', 'clicking a folder puts #folder/<name> in the URL');
ok(rowCount() === 15, 'the folder link scopes the list to its feeds');
ok($$('#list .row .feed-name').every((n) => ['Hacker News', 'The Verge'].includes(n.textContent)), 'only the folder\u2019s feeds are listed');
click('.tree-item[data-scope="feed:fixture-verge"]');
await settle(60);
ok(window.location.hash === '#feed/The%20Verge', 'clicking a feed puts #feed/<title> in the URL');
ok(rowCount() === 5, 'the feed link scopes the list to that feed');
window.location.hash = '#feed/hacker-news';
window.dispatchEvent(new window.Event('hashchange'));
await settle(60);
ok(rowCount() === 10, 'slug form (#feed/hacker-news) resolves the same feed');
window.location.hash = '#feed/hacker%20news';
window.dispatchEvent(new window.Event('hashchange'));
await settle(60);
ok(rowCount() === 10, 'lowercase-with-space form resolves the same feed');
window.location.hash = '#folder/nope';
window.dispatchEvent(new window.Event('hashchange'));
await settle(60);
ok(!window.location.hash, 'an unknown folder link clears the hash');
ok(!$('#toast').classList.contains('hidden'), 'an unknown folder link explains itself');
window.location.hash = '#folder/technology';
window.dispatchEvent(new window.Event('hashchange'));
await settle(60);
ok(rowCount() === 15, 'lowercase folder name still resolves');
click('.tree-item[data-scope="all"]');
await settle(60);
ok(!window.location.hash, 'returning to the Newsfeed clears the hash');
ok(rowCount() === TOTAL, 'the Newsfeed lists everything again');
console.log('boot with #folder/… and #feed/… in the URL');
{
  const domF = new JSDOM(html, { url: 'https://example.test/#folder/Technology', runScripts: 'outside-only', pretendToBeVisual: true });
  const wF = domF.window;
  wF.fetch = window.fetch;
  wF.eval(appSrc);
  await settle(1200);
  ok(wF.location.hash === '#folder/Technology', 'the folder hash survives boot');
  ok(!!wF.document.querySelector('.tree-item[data-scope="folder:tech"].active'), 'the folder row is marked active from the URL');
  ok(wF.document.querySelectorAll('#list .row').length === 15, 'booting on a folder link lists only that folder');
  domF.window.close();
}
{
  const domG = new JSDOM(html, { url: 'https://example.test/#feed/The%20Verge', runScripts: 'outside-only', pretendToBeVisual: true });
  const wG = domG.window;
  wG.fetch = window.fetch;
  wG.eval(appSrc);
  await settle(1200);
  ok(wG.location.hash === '#feed/The%20Verge', 'the feed hash survives boot');
  ok(wG.document.querySelectorAll('#list .row').length === 5, 'booting on a feed link lists only that feed');
  ok(!!wG.document.querySelector('.tree-item[data-scope="feed:fixture-verge"].active'), 'the feed row is marked active from the URL');
  domG.window.close();
}
{
  const domH = new JSDOM(html, { url: 'https://example.test/#feed/theverge', runScripts: 'outside-only', pretendToBeVisual: true });
  const wH = domH.window;
  wH.fetch = window.fetch;
  wH.eval(appSrc);
  await settle(1200);
  ok(wH.document.querySelectorAll('#list .row').length === 5, 'booting on the no-space slug form resolves the feed too');
  domH.window.close();
}
{
  const domI = new JSDOM(html, { url: 'https://example.test/#folder/Bogus', runScripts: 'outside-only', pretendToBeVisual: true });
  const wI = domI.window;
  wI.fetch = window.fetch;
  wI.eval(appSrc);
  await settle(1200);
  ok(!wI.location.hash, 'booting on an unknown folder link clears the hash');
  ok(!wI.document.querySelector('#toast').classList.contains('hidden'), 'booting on an unknown folder link explains itself');
  ok(wI.document.querySelectorAll('#list .row').length === TOTAL, 'the reader falls back to the Newsfeed');
  domI.window.close();
}
console.log('refresh/restore: boot with #article/<id> in the URL');
{
  const dom2 = new JSDOM(html, { url: 'https://example.test/#article/fixture-hn-1', runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.fetch = window.fetch; 
  w2.eval(appSrc);
  await settle(1200);
  const reader2 = w2.document.querySelector('#reader-slot .reader');
  ok(!!reader2 && reader2.dataset.id === 'fixture-hn-1', 'refresh reopens the article from the URL hash');
  ok(w2.document.querySelector('#reader-slot .reader-title a')?.href === 'https://example.com/fixture-hn/1', 'the restored article is the right one');
  ok(Number(w2.document.querySelector('#badge-all-items').textContent) === TOTAL - 1, 'hash-restore marks it read exactly like a click');
  ok(w2.location.hash === '#article/fixture-hn-1', 'the hash survives boot');
  dom2.window.close();
}
console.log('feed-storage version reset');
{
  const dom3 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w3 = dom3.window;
  w3.fetch = window.fetch;
  w3.localStorage.setItem('ghrss:read', JSON.stringify({ 'fixture-hn-0': 123 }));
  w3.localStorage.setItem('ghrss:kept', JSON.stringify({ 'fixture-hn-1': true }));
  w3.localStorage.setItem('ghrss:ui', JSON.stringify({ layout: 'cards', sortDir: 'newest', sortFlip: 1 }));
  w3.eval(appSrc);
  await settle(1200);
  ok(!Object.keys(JSON.parse(w3.localStorage.getItem('ghrss:read') || '{}')).length, 'old-version feed storage is wiped on upgrade');
  ok(w3.localStorage.getItem('ghrss:ver') === '3', 'the storage version is recorded');
  ok(Number(w3.document.querySelector('#badge-all-items').textContent) === TOTAL, 'all articles unread after the one-time reset');
  ok(w3.document.querySelector('#list').classList.contains('view-list'), 'the list view is forced (a stale saved layout is ignored)');
  ok([...w3.document.querySelectorAll('#list .row')].at(-1)?.dataset.id === 'fixture-hn-9', 'an explicit newest-first pref survives the one-time sort migration');
  dom3.window.close();
}
{
  const dom4 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w4 = dom4.window;
  w4.fetch = window.fetch;
  w4.localStorage.setItem('ghrss:ver', '3'); 
  w4.localStorage.setItem('ghrss:read', JSON.stringify({ 'fixture-hn-3': 123 }));
  w4.eval(appSrc);
  await settle(1200);
  ok(Number(w4.document.querySelector('#badge-all-items').textContent) === TOTAL - 1, 'same-version storage is kept (no re-reset)');
  dom4.window.close();
}
console.log('mark-on-open is unconditional now — old markReadOnOpen/delay config keys are inert');
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
  await settle(60);
  ok(badge5() === before5 - 1, 'opening marks read instantly — no setting can turn it off anymore');
  const r2 = w5.document.querySelectorAll('#list .row')[1];
  const id2 = r2.dataset.id;
  r2.dispatchEvent(new w5.MouseEvent('click', { bubbles: true }));
  await settle(60);
  w5.document.querySelector(`#list .row[data-id="${id2}"] [data-act="toggle-read"]`).dispatchEvent(new w5.MouseEvent('click', { bubbles: true }));
  await settle(60);
  ok(badge5() === before5 - 1, 'an explicit un-read on the open article sticks immediately (the first opened row stays read)');
  await settle(500);
  ok(badge5() === before5 - 1, 'no delayed timer ever reverts the explicit un-read (the machinery is gone)');
  dom5.window.close();
}
console.log('an explicit un-read beats a backend markRead flag — even after a reload (flags re-materialize at load)');
{
  const dom6 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w6 = dom6.window;
  const flagged6 = { articles: allFeeds.articles.map((a) => (a.title === 'Election update' ? { ...a, autoRead: true } : a)) };
  w6.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(flagged6) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  w6.eval(appSrc);
  await settle(1200);
  const badge6 = () => Number(w6.document.querySelector('#badge-all-items').textContent);
  const rowByTitle = (re) => [...w6.document.querySelectorAll('#list .row')].find((r) => re.test(r.querySelector('.row-title').textContent));
  ok(badge6() === TOTAL - 1, 'the backend markRead flag auto-reads its match at load (Election update)');
  w6.document.querySelector('#btn-more').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(20);
  w6.document.querySelector('#status-items [data-status="all"]').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(80);
  const electionRow = rowByTitle(/^Election update$/);
  ok(!!electionRow && !electionRow.classList.contains('unread'), 'the filter-read article shows as read');
  electionRow.querySelector('[data-act="toggle-read"]').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge6() === TOTAL, 'the user un-reads it');
  w6.document.querySelector('#menu-refresh').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok(badge6() === TOTAL, 'the explicit un-read SURVIVES the flag re-materializing (guard persisted, not session-scoped)');
  const electionRow2 = rowByTitle(/^Election update$/);
  ok(!!electionRow2 && electionRow2.classList.contains('unread'), 'the article is still unread after the reload');
  electionRow2.querySelector('[data-act="toggle-read"]').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge6() === TOTAL - 1, 're-reading it clears the guard (the flag owns it again)');
  w6.document.querySelector('#menu-refresh').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok(badge6() === TOTAL - 1, 'and stays read — no seesaw');
  dom6.window.close();
}
console.log('degraded network: hung feed fetches never wedge the UI');
{
  const domH = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wH = domH.window;
  const stalled = (opts) => new Promise((res, rej) => {
    opts?.signal?.addEventListener('abort', () => rej(new Error('The operation was aborted')));
  });
  wH.fetch = (url, opts) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return Promise.resolve({ ok: true, status: 200, json: async () => structuredClone(config) });
    if (p === 'data/index.json') return Promise.resolve({ ok: true, status: 200, json: async () => structuredClone(index) });
    return stalled(opts); 
  };
  wH.RSS_FETCH_TIMEOUT_MS = 120; 
  wH.eval(appSrc);
  await settle(700);
  const $$H = (s) => [...wH.document.querySelectorAll(s)];
  ok($$H('#tree .tree-item').length >= 4, 'sidebar renders from index.json even while feed fetches stall');
  ok(wH.document.querySelector('.btn-group-markread').classList.contains('hidden'), 'stalled loads hide the mark-all button entirely — a stalled feed never fakes "caught up"');
  ok(wH.document.querySelector('#empty h3').textContent === "Couldn't load articles", 'the empty state names the load failure instead of celebrating');
  ok(!!wH.document.querySelector('#empty [data-retry]'), 'the failed-load state offers a retry');
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
    await new Promise((r) => setTimeout(r, DELAY)); 
    const m = p.match(/^data\/feeds\/(.+)\.json$/);
    if (m && FIX[m[1]]) return { ok: true, status: 200, json: async () => structuredClone({ articles: FIX[m[1]].articles }) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  wS.eval(appSrc);
  await settle(300); 
  wS.document.querySelector('#btn-mark-all-split').dispatchEvent(new wS.MouseEvent('click', { bubbles: true }));
  await settle(30);
  setAge(wS, 30);
  wS.document.querySelector('#mark-age-apply').dispatchEvent(new wS.MouseEvent('click', { bubbles: true }));
  await settle(1700); 
  ok(wS.document.querySelector('#toast-text').textContent.includes('Still loading this view'), 'a click during a slow load announces itself instead of silently doing nothing');
  await settle(1800); 
  ok(wS.document.querySelector('#toast-text').textContent.includes('No unread articles older than 30 days here'), 'the action lands over the FULL data once loading completes');
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
  ok(rowsR() === TOTAL, 'boot loads rows via per-feed files (consolidated 404)');
  indexGen = now + 45 * 60000; 
  feedsFail = true; 
  wR.document.querySelector('#menu-refresh').dispatchEvent(new wR.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok(rowsR() === TOTAL, 'a failed reload keeps the previous articles (no blank feed)');
  ok(!wR.document.querySelector('#toast-text').textContent.includes('new article'), 'nothing is announced as synced when the reload fails');
  feedsFail = false;
  wR.document.querySelector('#menu-refresh').dispatchEvent(new wR.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok(rowsR() === TOTAL, 'the next successful refresh restores the normal flow');
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
  // array-of-blocks: OR across blocks (the 4chan X "type:subject,comment" pattern)
  const tpRe = '/(\\/tpg\\/|\\btpg\\b|thinkpad general)/i';
  const arrBlocks = { include: null, exclude: [fetchMod.compileBlockSrv({ subject: [tpRe] }), fetchMod.compileBlockSrv({ content: [tpRe] })] };
  ok(fetchMod.feedFilterDrop({ title: 'x', content: 'nothing here', subject: '/tpg/ - ThinkPad General' }, arrBlocks) === true, 'array-of-blocks exclude: a subject-only hit drops (OR across blocks)');
  ok(fetchMod.feedFilterDrop({ title: 'x', content: 'welcome to the thinkpad general thread', subject: '' }, arrBlocks) === true, 'array-of-blocks exclude: a comment-only hit drops');
  ok(fetchMod.feedFilterDrop({ title: 'x', content: 'unrelated', subject: 'desktop thread' }, arrBlocks) === false, 'array-of-blocks exclude: neither hit → kept');
  // capcode field (the 4chan X "type:capcode" pattern)
  const capBlock = fetchMod.compileBlockSrv({ capcode: ['/^Mod$/'] });
  ok(fetchMod.feedFilterDrop({ title: 't', content: '', capcode: 'Mod' }, { include: null, exclude: capBlock }) === true, 'the capcode field matches staff posts');
  ok(fetchMod.feedFilterDrop({ title: 't', content: '', capcode: 'Admin' }, { include: null, exclude: capBlock }) === false, 'the anchored ^Mod$ capcode never matches Admin');
  ok(fetchMod.feedFilterDrop({ title: 't', content: '' }, { include: null, exclude: capBlock }) === false, 'a missing capcode never matches');
  // the λ regex from the real ban list
  const lambdaRe = fetchMod.compileMatcherSrv('/(\\(λ\\)|lisp general)/i');
  ok(lambdaRe('(λ) - Lisp General') === true && lambdaRe('Lisp General 9000') === true && lambdaRe('desktop thread') === false, 'the λ ban matcher matches lisp generals and nothing else');
  // subject rules see ONLY real subjects (strict 4chan X semantics)
  const subjOnly = fetchMod.compileBlockSrv({ subject: ['/\\?/'] });
  ok(fetchMod.feedFilterDrop({ title: 'is this good?', content: 'x', subject: 'is this good?' }, { include: null, exclude: subjOnly }) === true, 'subject rules match real subjects');
  ok(fetchMod.feedFilterDrop({ title: 'is this good?', content: 'x' }, { include: null, exclude: subjOnly }) === false, 'a subjectless thread (title from the comment) is NOT matched by subject-only rules');
}
console.log('global filter rules compile server-side (scope + actions, the browser never sees them)');
{
  const fetchMod = await import('./fetch.mjs');
  const rules = fetchMod.compileConfigFilters([
    { id: 'bare', feeds: ['feed-x'], exclude: { title: ['spam'] } },
    { id: 'scoped-folder', feeds: ['folder-y'], include: { title: ['lisp'] }, actions: { markRead: true } },
    { id: 'multi', feeds: ['*'], actions: { highlight: true } },
    { id: 'off', enabled: false, include: { title: ['everything'] }, actions: { hide: true } },
  ]);
  ok(rules.length === 3, 'disabled rules are dropped at compile time');
  const art2 = (title) => ({ title, content: '', link: 'https://e.test/x' });
  ok(fetchMod.configFilterActions(art2('spam here'), 'feed-x', [], rules).hidden === true, 'a bare filter (no actions key) defaults to hide');
  ok(fetchMod.configFilterActions(art2('spam here'), 'feed-other', [], rules).hidden === false, 'feed scoping contains the bare rule');
  ok(fetchMod.configFilterActions(art2('lisp thread'), 'feed-z', ['folder-y'], rules).markRead === true, 'folder scoping matches a feed folder');
  ok(fetchMod.configFilterActions(art2('lisp thread'), 'feed-z', ['folder-other'], rules).markRead === false, 'a non-matching folder leaves the rule out');
  const res3 = fetchMod.configFilterActions(art2('anything at all'), 'any-feed', [], rules);
  ok(res3.highlight === true && res3.hidden === false, 'a bare star-scoped actions:{highlight} rule tints every feed (actions fire on bare matches)');
  ok(fetchMod.configFilterActions(art2('everything'), 'feed-x', [], rules).hidden === false, 'the disabled rule never matches');
  const resInc = fetchMod.configFilterActions(art2('off-topic'), 'feed-z', ['folder-y'], rules);
  ok(resInc.hidden === false && resInc.markRead === false, 'an include miss with no hide action leaves the article alone');
  const rules2 = fetchMod.compileConfigFilters([{ id: 'keep-only', feeds: ['feed-x'], include: { title: ['lisp'] }, actions: { hide: true } }]);
  ok(fetchMod.configFilterActions(art2('lisp thread'), 'feed-x', [], rules2).hidden === false, 'include-match survives a hide action');
  ok(fetchMod.configFilterActions(art2('off-topic'), 'feed-x', [], rules2).hidden === true, 'include-miss IS hidden when actions.hide is set (include = keep-only)');
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
  ok(JSON.stringify(passes({ minReplies: 300 })) === '[103,104,105,106]', 'minReplies window; closed threads included, stickies always skipped');
  ok(JSON.stringify(passes({ minReplies: 300, includeSticky: true, includeClosed: false })) === '[103,104,105,106]', 'legacy sticky/closed options ignored: closed always in, sticky always out');
  ok(JSON.stringify(passes({ minReplies: 300, maxReplies: 500 })) === '[103,105]', 'maxReplies caps the window (closed threads count too)');
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
  ok(noSub.subject === undefined, 'subjectless threads carry NO subject field (subject rules cannot false-positive on them)');
  ok(a.subject === 'Thinkpad thread', 'a real subject is carried for subject-scoped filters');
  const modA = chan.chanThreadToArticle(t({ no: 109, replies: 400, sub: 'mod post', capcode: 'Mod' }), { board: 'g', worksafe: true });
  ok(modA.capcode === 'Mod', 'staff capcodes are carried for capcode filters');
  ok(noSub.capcode === undefined, 'regular posts carry no capcode field');
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
console.log('RSS titles are capped at ingest (like 4chan/HN titles)');
{
  const fetchMod = await import('./fetch.mjs');
  ok(typeof fetchMod.pickTitle === 'function', 'pickTitle is exported');
  if (typeof fetchMod.pickTitle === 'function') {
    ok(fetchMod.pickTitle({ title: 'Normal title' }) === 'Normal title', 'a normal title passes through untouched');
    ok(fetchMod.pickTitle({}) === '(untitled)', 'a missing title falls back to (untitled)');
    ok(fetchMod.pickTitle({ title: '   ' }) === '(untitled)', 'a whitespace-only title falls back to (untitled)');
    ok(fetchMod.pickTitle({ title: '<b>XSS</b> attempt' }) === 'XSS attempt', 'title markup is flattened');
    const long = fetchMod.pickTitle({ title: 'T'.repeat(3000) });
    ok(long.length === 300, `a 3000-char title is capped to 300 (got ${long.length})`);
  }
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
  const NOWS = 1746000000; 
  const NOW = NOWS * 1000;
  const START = NOWS - 60 * 86400;
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
    if (f === START && !t) return { ok: true, status: 200, json: async () => ({ hits: mk(1, 1000), nbHits: 1388 }) }; 
    if (f > START && !t) return { ok: true, status: 200, json: async () => ({ hits: mk(2000, 705), nbHits: 705 }) };   
    return { ok: true, status: 200, json: async () => ({ hits: mk(3000, 683), nbHits: 683 }) };                          
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
    if (t > 0) return { ok: false, status: 500, json: async () => ({}) }; 
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
console.log('regression: marking with caught-up (badgeless) feeds in the tree must not freeze the counters');
{
  const dom10 = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w10 = dom10.window;
  w10.fetch = window.fetch;
  w10.localStorage.setItem('ghrss:ver', '3');
  const readSeed = {};
  for (const a of FIX['fixture-verge'].articles) readSeed[a.id] = now - 3600e3;
  for (const a of FIX['fixture-bbc'].articles) readSeed[a.id] = now - 3600e3;
  for (const a of FIX['fixture-junk'].articles) readSeed[a.id] = now - 3600e3; 
  w10.localStorage.setItem('ghrss:read', JSON.stringify(readSeed));
  w10.eval(appSrc);
  await settle(1200);
  const hnBadge = () => w10.document.querySelector('#tree .tree-item[data-scope="feed:fixture-hn"] .badge');
  const titleCount10 = () => Number((w10.document.title.match(/^\((\d+)\)/) || [])[1] || 0);
  const unreadN = 10;
  ok(Number(hnBadge()?.textContent) === unreadN, 'the HN badge starts at its unread count');
  ok(!w10.document.querySelector('#tree .tree-item[data-scope="feed:fixture-verge"] .badge'), 'the caught-up feed is badgeless (the trap is set)');
  const row10 = [...w10.document.querySelectorAll('#list .row')].find((r) => /AI model beats benchmark/.test(r.querySelector('.row-title').textContent));
  row10.dispatchEvent(new w10.MouseEvent('click', { bubbles: true }));
  await settle(150);
  ok(Number(w10.document.querySelector('#tree .tree-item[data-scope="feed:fixture-hn"] .badge').textContent) === unreadN - 1, 'the sidebar badge still updates with badgeless caught-up feeds in the tree');
  ok(titleCount10() === unreadN - 1, 'the (N) title counter updates too — the handler no longer dies mid-click');
  [...w10.document.querySelectorAll('#list .row')].find((r) => /AI model beats benchmark/.test(r.querySelector('.row-title').textContent)).dispatchEvent(new w10.MouseEvent('click', { bubbles: true })); 
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
  const cfg7 = { ...config };
  const flagged7 = { articles: allFeeds.articles.map((a) => (a.title === 'Election update' ? { ...a, autoRead: true } : a)) };
  w7.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(cfg7) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(flagged7) };
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
  w7.document.querySelector('#btn-more').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(20);
  w7.document.querySelector('#status-items [data-status="all"]').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge7() === TOTAL - 1, 'the backend markRead flag auto-reads its match at load (Election update)');
  rowByTitle7(/^Election update$/).querySelector('[data-act="toggle-read"]').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badge7() === TOTAL, 'explicit un-read wins for now');
  w7.document.querySelector('#btn-mark-all').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(30);
  w7.document.querySelector('#confirm-yes').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(200);
  ok(badge7() !== TOTAL, 'mark-all-as-read landed');
  const guardAfterRead = JSON.parse(w7.localStorage.getItem('ghrss:userUnread') || '{}');
  ok(!guardAfterRead['fixture-bbc-0'], 'mass read CLEARED the stale un-read guard (no ghost guard survives)');
  w7.document.querySelector('#btn-mark-all').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(30);
  w7.document.querySelector('#confirm-yes').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
  await settle(200);
  const guardAfterUnread = JSON.parse(w7.localStorage.getItem('ghrss:userUnread') || '{}');
  ok(guardAfterUnread['fixture-bbc-0'], 'mass unread ARMS a guard for the flag-owned article');
  await refresh7();
  ok(badge7() === TOTAL, 'after the refresh the flag-owned article is STILL unread — the guard beats the flag re-materializing (no seesaw)');
  ok(rowByTitle7(/^Election update$/).classList.contains('unread'), '…and the row shows unread');
  dom7.window.close();
}
console.log('mark-all button visibility: only with news to read, unread-restore only after a real clear');
{
  const emptyFix = { 'fixture-hn': FIX['fixture-hn'], 'fixture-empty': { title: 'Empty Feed', site: 'https://empty.test', folder: 'tech', articles: [] } };
  const idxE = { generatedAt: now, folders: index.folders, feeds: {
    'fixture-hn': index.feeds['fixture-hn'],
    'fixture-empty': { title: 'Empty Feed', site: 'https://empty.test', folder: 'tech', folders: ['tech'], count: 0, newest: null, oldest: null },
  } };
  const domE = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wE = domE.window;
  wE.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(idxE) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone({ articles: emptyFix['fixture-hn'].articles.map((a) => ({ ...a, _feed: 'fixture-hn' })) }) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  wE.eval(appSrc);
  await settle(1200);
  const wrapE = () => wE.document.querySelector('.btn-group-markread');
  const btnE = () => wE.document.querySelector('#btn-mark-all');
  ok(!wrapE().classList.contains('hidden') && btnE().title === 'Mark all as read', 'unread news exist → the button offers "Mark all as read"');
  wE.document.querySelector('.tree-item[data-scope="feed:fixture-empty"]').dispatchEvent(new wE.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(wrapE().classList.contains('hidden'), 'a scope with no articles at all hides the button (nothing to read, nothing to restore)');
  wE.document.querySelector('#scope-info').dispatchEvent(new wE.MouseEvent('click', { bubbles: true }));
  await settle(20);
  ok(!wE.document.querySelector('#feed-modal').classList.contains('hidden'), 'the info modal opens for an empty feed too');
  ok(wE.document.querySelector('#feed-modal-body').textContent.includes('Never'), 'Last post reads "Never" for a feed with no posts');
  wE.document.querySelector('#feed-modal-close').dispatchEvent(new wE.MouseEvent('click', { bubbles: true }));
  await settle(20);
  ok(wE.document.querySelector('#feed-modal').classList.contains('hidden'), 'the modal closes');
  wE.document.querySelector('.tree-item[data-scope="all"]').dispatchEvent(new wE.MouseEvent('click', { bubbles: true }));
  await settle(80);
  wE.document.querySelector('#badge-all-items').dispatchEvent(new wE.MouseEvent('click', { bubbles: true }));
  await settle(150);
  ok(!wrapE().classList.contains('hidden') && btnE().title === 'Mark all as unread', 'everything cleared by the user → the SAME button flips to "Mark all as unread"');
  wE.document.querySelector('#btn-mark-all').dispatchEvent(new wE.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wE.document.querySelector('#confirm-yes').dispatchEvent(new wE.MouseEvent('click', { bubbles: true }));
  await settle(150);
  ok(btnE().title === 'Mark all as read', 'unread articles exist again → the button flips back');
  domE.window.close();
}
console.log('hardened: read state survives a feed that transiently vanishes from the data');
{
  const gapAll = { articles: allFeeds.articles.filter((a) => a._feed !== 'fixture-bbc') };
  const mkDomGap = async (payloadAll, seed) => {
    const domG = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
    const wG = domG.window;
    wG.fetch = async (url) => {
      const p = String(url).split('?')[0];
      if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
      if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
      if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(payloadAll) };
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
    };
    if (seed) {
      wG.localStorage.setItem('ghrss:ver', '3');
      wG.localStorage.setItem('ghrss:read', JSON.stringify(seed));
    }
    wG.eval(appSrc);
    await settle(1200);
    return { wG, domG };
  };
  const readSeed = {};
  for (const a of allFeeds.articles) readSeed[a.id] = now - 60e3;
  const { wG: wGap, domG: domGap } = await mkDomGap(gapAll, readSeed);
  const lsGap = JSON.parse(wGap.localStorage.getItem('ghrss:read') || '{}');
  ok(lsGap['fixture-bbc-0'] === readSeed['fixture-bbc-0'], 'a feed missing from one publish does NOT delete its read keys (the old live-set prune destroyed them)');
  ok(!wGap.document.querySelector('.tree-item[data-scope="feed:fixture-bbc"] .badge'), 'the vanished feed shows no unread');
  ok(Number(wGap.document.querySelector('#badge-all-items').textContent) === 0, 'nothing appears as unread while the feed is missing');
  domGap.window.close();
  const { wG: wBack, domG: domBack } = await mkDomGap(allFeeds, readSeed);
  ok(Number(wBack.document.querySelector('#badge-all-items').textContent) === 0, 'the feed returns with its articles STILL READ — no phantom unread resurrection');
  wBack.document.querySelector('.tree-item[data-scope="folder:tech"]').dispatchEvent(new wBack.MouseEvent('click', { bubbles: true }));
  await settle(120);
  ok(wBack.document.querySelectorAll('#list .row').length === 0, 'THE USER\u2019S SCENARIO: mark-all-read → reload → click a folder → ZERO random unread news appear (same data)');
  const lsBack = JSON.parse(wBack.localStorage.getItem('ghrss:read') || '{}');
  ok(Object.keys(lsBack).length === Object.keys(readSeed).length, 'the read map is intact after the round trip');
  domBack.window.close();
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
  wB.document.querySelector('#list').dispatchEvent(new wB.Event('scroll', { bubbles: false }));
  await settle(120); 
  ok(wB.document.querySelectorAll('#list .row').length === 400, 'a scroll event materializes the rest of the list');
  ok(!wB.document.querySelector('#list-tail'), 'the sentinel retires once everything is rendered');
  wB.document.querySelector('#btn-mark-all').dispatchEvent(new wB.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wB.document.querySelector('#confirm-yes').dispatchEvent(new wB.MouseEvent('click', { bubbles: true }));
  await settle(200);
  ok(wB.document.querySelector('#badge-all-items').textContent === '', 'mark-all-as-read covered every article — rendered or not');
  const lsB = JSON.parse(wB.localStorage.getItem('ghrss:read') || '{}');
  ok(Object.keys(lsB).length === 400, 'all 400 ids landed in the read state');
  domB.window.close();
  const domD = new JSDOM(html, { url: 'https://example.test/#article/big-350', runScripts: 'outside-only', pretendToBeVisual: true });
  const wD = domD.window;
  await bootBig(wD, '#article/big-350');
  ok(!!wD.document.querySelector('#reader-slot .reader') && wD.document.querySelector('#reader-slot .reader').dataset.id === 'big-350', 'a deep link into the tail opens the article');
  ok(!!wD.document.querySelector('.row[data-id="big-350"]'), 'the deep-linked row is materialized in the DOM (renderUpTo)');
  domD.window.close();
}
console.log('mark-as-unread: the publication window (from N ago / since a date)');
{
  const D = 864e5;
  const nowU = Date.now();
  const art = (id, ageDays, title) => ({
    id, title, link: `https://example.test/${id}`, date: nowU - ageDays * D,
    author: null, summary: title, content: `<p>${title}</p>`, text: null, enclosures: [], fetchedAt: nowU,
  });
  const articles = [
    art('u-fresh', 0.02, 'Published half an hour ago'),
    art('u-1d', 0.98, 'Published a day ago'),
    art('u-3d', 3, 'Published three days ago'),
    art('u-10d', 10, 'Published ten days ago'),
    art('u-40d', 40, 'Published forty days ago'),
    art('u-55d', 55, 'Published fifty-five days ago'),
  ];
  const readSeed = {
    'u-fresh': nowU - 2 * 3600e3, 
    'u-3d': nowU - 1 * 3600e3,    
    'u-10d': nowU - 5 * D,        
    'u-40d': nowU - 5 * D,        
    'u-55d': nowU - 20 * D,       
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
  wU.localStorage.setItem('ghrss:ver', '3');
  wU.localStorage.setItem('ghrss:read', JSON.stringify(readSeed));
  wU.eval(appSrc);
  await settle(1200);
  const unreadRow = (id) => {
    const r = wU.document.querySelector(`#list .row[data-id="${id}"]`);
    return r ? r.classList.contains('unread') : null;
  };
  wU.document.querySelector('#btn-more').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  wU.document.querySelector('#status-items [data-status="all"]').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(wU.document.querySelectorAll('#list .row').length === 6, 'all six rows render in the All-articles view');
  ok(unreadRow('u-3d') === false && unreadRow('u-fresh') === false, 'sanity: the seeded reads render as read');
  ok(unreadRow('u-10d') === false && unreadRow('u-40d') === false && unreadRow('u-55d') === false, 'sanity: the old reads render as read');
  ok(unreadRow('u-3d') === false, 'THE REPORTED CASE, rendered: read an hour ago (published 3 days ago) → row stays READ');
  ok(unreadRow('u-fresh') === false, 'read 2 h ago → stays read');
  ok(unreadRow('u-10d') === false && unreadRow('u-40d') === false && unreadRow('u-55d') === false, 'the older reads stay read too (one clock — no reading-age restore exists to resurrect them)');
  ok(unreadRow('u-1d') === true, 'the never-read article is untouched');
  ok(Number(wU.document.querySelector('#badge-all-items').textContent) === 1, 'badge: only the never-read article is unread');
  wU.document.querySelector('#btn-mark-all-split').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  setAge(wU, 2);
  wU.document.querySelector('#mark-age-apply').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(300);
  ok(wU.document.querySelector('#toast-text').textContent.includes('No unread articles older than two days here'), 'mark-as-read counts by PUBLICATION age — the 0.98-day unread article is too new to match');
  ok(unreadRow('u-1d') === true, 'the day-old unread article survives mark-read-older-than-two-days (published < 2 days ago)');
  console.log('publication clock: mark-all-read, then from-a-day-ago, then from-a-week-ago');
  wU.document.querySelector('#btn-mark-all').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wU.document.querySelector('#confirm-yes').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(200);
  ok(Number(wU.document.querySelector('#badge-all-items').textContent) === 0, 'mark-all-read lands (fresh timestamps, seconds old)');
  wU.document.querySelector('#btn-mark-all-split').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  ok(wU.document.querySelector('#mark-age-title').textContent === 'Mark as unread', 'caught up → the restore direction is offered');
  setAge(wU, 1);
  wU.document.querySelector('#mark-age-apply').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(300);
  ok(wU.document.querySelector('#toast-text').textContent.includes('Marked 2 articles from a day ago as unread'), 'THE USER\u2019S CASE: freshly marked-all-read, from-a-day-ago brings back ONLY the sub-day news');
  ok(unreadRow('u-fresh') === true && unreadRow('u-1d') === true, 'the fresh and 0.98-day articles are unread again');
  ok(unreadRow('u-3d') === false && unreadRow('u-10d') === false && unreadRow('u-40d') === false && unreadRow('u-55d') === false, 'everything published more than a day ago stays read');
  ok(Number(wU.document.querySelector('#badge-all-items').textContent) === 2, 'badge: 2 restored');
  const lsP = JSON.parse(wU.localStorage.getItem('ghrss:read') || '{}');
  ok(JSON.stringify(Object.keys(lsP).sort()) === JSON.stringify(['u-10d', 'u-3d', 'u-40d', 'u-55d']), 'persisted: only the beyond-a-day articles keep their read entries');
  wU.document.querySelector('#btn-mark-all').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wU.document.querySelector('#confirm-yes').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(200);
  wU.document.querySelector('#btn-mark-all-split').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(20);
  setAge(wU, 7);
  wU.document.querySelector('#mark-age-apply').dispatchEvent(new wU.MouseEvent('click', { bubbles: true }));
  await settle(300);
  ok(wU.document.querySelector('#toast-text').textContent.includes('Marked 3 articles from a week ago as unread'), 're-marked, then from-a-week-ago: exactly the three sub-week articles restore');
  ok(unreadRow('u-3d') === true && unreadRow('u-1d') === true && unreadRow('u-fresh') === true, 'the fresh, 0.98-day and three-day articles are unread');
  ok(unreadRow('u-10d') === false && unreadRow('u-40d') === false && unreadRow('u-55d') === false, 'the week-plus articles stay read (outside the window)');
  ok(Number(wU.document.querySelector('#badge-all-items').textContent) === 3, 'badge: 3 restored');
  domU.window.close();
}
console.log('unread-side zero result: a caught-up scope whose reads all predate the window');
{
  const D = 864e5;
  const nowB = Date.now();
  const mkB = (id, ageDays) => ({ id, title: `Old read ${id}`, link: `https://example.test/${id}`, date: nowB - ageDays * D, author: null, summary: `Old read ${id}`, content: '<p>old</p>', text: null, enclosures: [], fetchedAt: nowB });
  const articles = [mkB('b-45', 45), mkB('b-60', 60)];
  const idxB = { generatedAt: nowB, folders: [], feeds: { 'fixture-bound': { title: 'Boundary Feed', site: 'https://b.test', folder: null, folders: [], count: 2, newest: articles[0].date, oldest: articles[1].date } } };
  const domB = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wB = domB.window;
  wB.fetch = async (reqUrl) => {
    const p = String(reqUrl).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(idxB) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone({ articles: articles.map((a) => ({ ...a, _feed: 'fixture-bound' })) }) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  wB.localStorage.setItem('ghrss:ver', '3');
  wB.localStorage.setItem('ghrss:read', JSON.stringify({ 'b-45': nowB - 5 * D, 'b-60': nowB - 10 * D }));
  wB.eval(appSrc);
  await settle(1200);
  wB.document.querySelector('#btn-mark-all-split').dispatchEvent(new wB.MouseEvent('click', { bubbles: true }));
  await settle(20);
  ok(wB.document.querySelector('#mark-age-title').textContent === 'Mark as unread', 'caught up → the restore direction is offered');
  setAge(wB, 30);
  await settle(20);
  ok(wB.document.querySelector('#mark-age-count').textContent === 'Nothing to mark here', 'both reads predate the 30-day window');
  wB.document.querySelector('#mark-age-apply').dispatchEvent(new wB.MouseEvent('click', { bubbles: true }));
  await settle(300);
  ok(wB.document.querySelector('#toast-text').textContent === 'No read articles from 30 days ago here', 'unread-side zero toast is honest (cutoff inside the data window: no boundary clause)');
  domB.window.close();
}
console.log('read ⇄ unread toggles on the open article are immediate and final');
{
  const domW = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wW = domW.window;
  wW.fetch = window.fetch;
  wW.eval(appSrc);
  await settle(1200);
  const badgeW = () => Number(wW.document.querySelector('#badge-all-items').textContent);
  const beforeW = badgeW();
  const rowW = wW.document.querySelector('#list .row');
  const idW = rowW.dataset.id;
  rowW.dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badgeW() === beforeW - 1, 'opening the article marks it read on the spot');
  wW.document.querySelector('#reader-slot [data-act="toggle-read"]').dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(badgeW() === beforeW, 'explicit mark-as-unread on the open article lands');
  await settle(900);
  ok(badgeW() === beforeW, 'the explicit unread sticks — nothing delayed can revert it');
  ok(!!wW.document.querySelector(`#list .row[data-id="${idW}"]`)?.classList.contains('unread'), 'the row still shows unread');
  wW.document.querySelector('#btn-mark-all').dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wW.document.querySelector('#confirm-yes').dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(200);
  ok(badgeW() === 0, 'mark-all-as-read lands');
  wW.document.querySelector('#btn-mark-all').dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wW.document.querySelector('#confirm-yes').dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(200);
  ok(badgeW() === beforeW, 'mark-all-as-unread restores everything');
  wW.document.querySelector(`#list .row[data-id="${idW}"]`).dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(120);
  wW.document.querySelector('#btn-mark-all').dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wW.document.querySelector('#confirm-yes').dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(200);
  wW.document.querySelector('#btn-mark-all').dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(30);
  wW.document.querySelector('#confirm-yes').dispatchEvent(new wW.MouseEvent('click', { bubbles: true }));
  await settle(400);
  ok(badgeW() === beforeW, 'mass unread over an open article is not reverted either');
  domW.window.close();
}
console.log('search: a trailing OR no longer matches everything; OR still unions groups');
{
  click('#search-open');
  await settle(20);
  const s = $('#search-input');
  s.value = 'zzz-nothing-matches-this OR';
  s.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(400);
  ok(rowCount() === 0, 'a trailing OR with a dead term does not degrade into match-everything');
  s.value = 'zzz-nothing-matches OR AI model';
  s.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(400);
  ok(rowCount() === 1, 'OR still unions groups (dead term OR real term = the real one)');
  click('#search-close');
  await settle(50);
}
console.log('author shown only when it differs from the feed title');
{
  const domX = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wX = domX.window;
  const fixX = {
    'fixture-tect': {
      title: 'Tectone', site: 'https://youtube.test/tect', folder: 'tech',
      articles: [
        { id: 'x-1', title: 'Same author as channel', link: 'https://example.test/x1', date: now - 3600e3, author: 'Tectone', summary: 's', content: '<p>b</p>', text: null, enclosures: [], fetchedAt: now },
        { id: 'x-2', title: 'Guest author', link: 'https://example.test/x2', date: now - 2 * 3600e3, author: 'Someone Else', summary: 's', content: '<p>b</p>', text: null, enclosures: [], fetchedAt: now },
      ],
    },
  };
  const idxX = { generatedAt: now, folders: [], feeds: { 'fixture-tect': { title: 'Tectone', site: 'https://youtube.test/tect', folder: 'tech', folders: ['tech'], count: 2, newest: now, oldest: now - 2 * 3600e3 } } };
  wX.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(idxX) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone({ articles: fixX['fixture-tect'].articles.map((a) => ({ ...a, _feed: 'fixture-tect' })) }) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  wX.eval(appSrc);
  await settle(1200);
  const rowsX = [...wX.document.querySelectorAll('#list .row')];
  const sameAuthorRow = rowsX.find((r) => r.dataset.id === 'x-1');
  const guestRow = rowsX.find((r) => r.dataset.id === 'x-2');
  ok(!sameAuthorRow.querySelector('.author'), 'no redundant "Tectone by Tectone" in the row meta');
  ok(!!guestRow.querySelector('.author') && guestRow.querySelector('.author').textContent === 'Someone Else', 'a genuinely different author still renders');
  guestRow.dispatchEvent(new wX.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(wX.document.querySelector('.reader-sub').textContent.includes('Someone Else'), 'the reader keeps the distinct author');
  wX.document.querySelector('#list .row[data-id="x-1"]').dispatchEvent(new wX.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(!wX.document.querySelector('.reader-sub').textContent.includes('by Tectone'), 'the reader drops the duplicate author too');
  domX.window.close();
}
console.log('backend filter flags: keepUnread guards its matches (verified from a cold empty profile — the private-browsing case)');
{
  const domK = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wK = domK.window;
  const flaggedK = { articles: allFeeds.articles.map((a) => {
    if (a.title === 'Climate summit') return { ...a, keepUnread: true };
    if (a.title === 'Election update') return { ...a, autoRead: true };
    return a;
  }) };
  wK.fetch = async (url) => {
    const p = String(url).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(flaggedK) };
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  };
  wK.eval(appSrc);
  await settle(1200);
  const badgeK = () => Number(wK.document.querySelector('#badge-all-items').textContent);
  ok(badgeK() === TOTAL - 1, 'the autoRead flag read its match at load; the keepUnread flag stays unread');
  const climate = [...wK.document.querySelectorAll('#list .row')].find((r) => /Climate summit/.test(r.querySelector('.row-title').textContent));
  ok(!!climate && climate.classList.contains('unread'), 'the keepUnread-flagged article renders unread');
  climate.dispatchEvent(new wK.MouseEvent('click', { bubbles: true }));
  await settle(150);
  ok(badgeK() === TOTAL - 1, 'opening a keepUnread-guarded article does NOT mark it read');
  ok(!!wK.document.querySelector('#list .row[data-id="fixture-bbc-1"]')?.classList.contains('unread'), 'the guarded row stays unread after open (reader open, row lingers)');
  wK.document.querySelector('#reader-slot [data-act="collapse"]').dispatchEvent(new wK.MouseEvent('click', { bubbles: true }));
  await settle(50);
  domK.window.close();
}
console.log('feed information modal — the info icon beside the scope title');
{
  ok($('#scope-info').classList.contains('hidden'), 'no info icon in the Newsfeed scope');
  click('.tree-item[data-scope="feed:fixture-bbc"]');
  await settle(80);
  ok(!$('#scope-info').classList.contains('hidden'), 'the info icon appears beside a feed\u2019s title');
  ok($('#scope-title').textContent === 'BBC News', 'sanity: the feed scope is active');
  click('#scope-info');
  await settle(20);
  ok(!$('#feed-modal').classList.contains('hidden'), 'clicking the icon opens the centered modal');
  const fb = () => $('#feed-modal-body');
  ok($('#feed-modal-title').textContent === 'BBC News', 'the modal names the feed');
  ok(!fb().textContent.includes('Original title'), 'no Original-title row when the config did not rename the feed');
  const webA = fb().querySelector('a[href="https://www.bbc.com/news"]');
  ok(!!webA && webA.getAttribute('rel') === 'noopener noreferrer', 'the Website row links out safely (noopener)');
  ok(!!fb().querySelector('a[href="https://bbc.test/rss"]'), 'the XML address row links the raw feed URL');
  ok(fb().textContent.includes('News'), 'the Folder row names the feed\u2019s folder');
  ok(/Last post/.test(fb().textContent) && /\d+[mh] ago/.test(fb().textContent), 'the Last post row shows a relative age');
  ok(fb().textContent.includes('Success'), 'Last crawled reports the success state');
  ok(fb().querySelector('.fi-pfp img')?.src === 'https://www.bbc.test/logo.png', 'a feed-provided image serves as the pfp');
  ok(/\d+ articles · \d+ unread/.test(fb().textContent), 'the modal carries article and unread counts');
  click('#feed-modal-close');
  await settle(20);
  ok($('#feed-modal').classList.contains('hidden'), 'the close button dismisses it');
  click('#scope-info');
  await settle(20);
  $('#feed-modal').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(20);
  ok($('#feed-modal').classList.contains('hidden'), 'clicking the backdrop dismisses it');
  click('#scope-info');
  await settle(20);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(20);
  ok($('#feed-modal').classList.contains('hidden'), 'Escape dismisses it');
  click('.tree-item[data-scope="feed:fixture-verge"]');
  await settle(80);
  click('#scope-info');
  await settle(20);
  ok(fb().textContent.includes('Original title') && fb().textContent.includes('The Verge (source self-title)'), 'the Original-title row appears when the config renamed the feed');
  click('#feed-modal-close');
  await settle(20);
  click('.tree-item[data-scope="feed:fixture-junk"]');
  await settle(80);
  click('#scope-info');
  await settle(20);
  ok(fb().textContent.includes('Failed'), 'a failing feed reports the failed crawl state');
  ok(fb().textContent.includes('HTTP 500'), 'the crawl error is surfaced');
  ok(fb().textContent.includes('1h ago'), '…with the failed attempt\u2019s age');
  click('#feed-modal-close');
  await settle(20);
  click('.tree-item[data-scope="all"]');
  await settle(80);
  ok($('#scope-info').classList.contains('hidden'), 'the info icon hides again outside feed scopes');
}
console.log('resizable divider between the list and article panes');
{
  const domD = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const wD = domD.window;
  wD.fetch = window.fetch;
  wD.localStorage.setItem('ghrss:ver', '3');
  wD.localStorage.setItem('ghrss:ui', JSON.stringify({ listW: 500 }));
  wD.eval(appSrc);
  await settle(1200);
  const rootD = wD.document.documentElement;
  const prop = (k) => rootD.style.getPropertyValue(k);
  ok(prop('--list-w') === '500px', 'a saved split restores on boot');
  ok(prop('--article-cap') === 'none', 'the 940px default cap lifts once a custom split exists');
  const rz = wD.document.querySelector('#reader_resizer');
  ok(!!rz, 'the resizer element exists');
  ok(wD.document.querySelector('#list_pane').nextElementSibling === rz && rz.nextElementSibling === wD.document.querySelector('#article_pane'), 'it sits exactly between the list and article panes');
  const drag = (from, to) => {
    rz.dispatchEvent(new wD.MouseEvent('pointerdown', { bubbles: true, clientX: from }));
    wD.document.dispatchEvent(new wD.MouseEvent('pointermove', { bubbles: true, clientX: to }));
    wD.document.dispatchEvent(new wD.MouseEvent('pointerup', { bubbles: true, clientX: to }));
  };
  drag(500, 640);
  await settle(20);
  ok(prop('--list-w') === '640px', 'dragging moves the split');
  ok(JSON.parse(wD.localStorage.getItem('ghrss:ui') || '{}').listW === 640, 'the split persists to localStorage on release');
  drag(500, 10);
  await settle(20);
  ok(prop('--list-w') === '260px', 'the split clamps at the list-pane minimum (260px)');
  drag(500, 5000);
  await settle(20);
  ok(prop('--list-w') === '704px', 'the split clamps so the article pane keeps at least 320px (jsdom viewport 1024)');
  rz.dispatchEvent(new wD.MouseEvent('dblclick', { bubbles: true }));
  await settle(20);
  ok(prop('--list-w') === '' && prop('--article-cap') === '', 'double-click resets to the default 44/56 split');
  ok(!('listW' in JSON.parse(wD.localStorage.getItem('ghrss:ui') || '{}')), 'the saved split is forgotten on reset');
  domD.window.close();
}
console.log('config.json contract — the shipped feed list itself');
{
  const cfgFile = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  const feeds = cfgFile.feeds || [];
  ok(feeds.length > 50, `the feed list is intact (${feeds.length} feeds)`);
  ok(feeds.every((f) => typeof f.title === 'string' && f.title.trim()), 'every feed carries a title (the config reads like a list of what you follow)');
  const chanFeed = feeds.find((f) => f.type === '4chan');
  ok(!!chanFeed, 'the 4chan feed exists');
  ok(chanFeed.board === 'g', 'the 4chan feed still points at /g/');
  ok(Number(chanFeed.minReplies) === 70, 'the /g/ reply floor is 70 (threads at 70+ replies count as news)');
  ok(chanFeed.site === 'https://boards.4channel.org/g/#catalog/reply-count', 'the /g/ website link opens the catalog sorted by reply count');
  const blocks = chanFeed.filter?.exclude;
  ok(Array.isArray(blocks) && blocks.length >= 38, `the 4chan X ban list is transferred (${Array.isArray(blocks) ? blocks.length : 0} blocks)`);
  if (Array.isArray(blocks)) {
    const flat = JSON.stringify(blocks);
    ok(blocks.some((b) => b.capcode?.length), 'the Mod capcode ban is there');
    ok(blocks.some((b) => b.subject?.some((s) => s.includes('?'))), 'the question-mark subject ban is there');
    ok(flat.includes('λ'), 'the lisp-general ban carries the λ glyph');
    let compileOk = true;
    for (const b of blocks) for (const arr of Object.values(b)) for (const m of arr) {
      const mm = String(m).match(/^\/(.+)\/([a-z]*)$/);
      if (mm) { try { new RegExp(mm[1], mm[2]); } catch { compileOk = false; } }
    }
    ok(compileOk, 'every ban-list matcher compiles');
    const FIELDS = new Set(['title', 'content', 'author', 'authors', 'link', 'links', 'subject', 'capcode']);
    ok(blocks.every((b) => Object.keys(b).every((k) => FIELDS.has(k))), 'no unknown field names in the ban list');
  }
}
console.log('');
console.log(`${pass} passed, ${fail} failed`);
dom.window.close();
process.exit(fail ? 1 : 0);