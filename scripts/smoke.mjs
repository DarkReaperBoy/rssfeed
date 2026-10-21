// Smoke test: boot the real UI in jsdom against the real data/ on disk.
// Run: node scripts/smoke.mjs  (requires a prior `npm run fetch`)
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
// Activate a test filter: hide HN articles whose title contains "Show HN".
config.filters = [{
  id: 'test-filter', name: 'test', feeds: ['hacker-news'],
  exclude: { title: ['show hn'] }, actions: { hide: true },
}];

const html = (await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'))
  .replace(/<script src="assets\/app.js"><\/script>/, '');
const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

window.fetch = async (url) => {
  const p = String(url).split('?')[0];
  const file = p === 'config.json' ? null : p;
  try {
    const txt = file ? await fs.readFile(path.join(ROOT, file), 'utf8') : JSON.stringify(config);
    return { ok: true, status: 200, json: async () => JSON.parse(txt) };
  } catch {
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => { throw new Error('404'); } };
  }
};

const appSrc = await fs.readFile(path.join(ROOT, 'assets/app.js'), 'utf8');
window.eval(appSrc);
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
await settle(1200); // let lazy feed loads finish

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];

console.log('boot + sidebar');
ok($('#tree').textContent.includes('All articles'), 'system views render');
ok($('#tree').textContent.includes('Technology'), 'folder renders');
ok($('#tree').textContent.includes('Hacker News'), 'feed renders');
ok($('#tree').textContent.includes('BBC News'), 'second feed renders');

console.log('list rendering');
const rows = $$('#list .row');
ok(rows.length > 10, `rows rendered (${rows.length})`);
ok(rows.every((r) => r.classList.contains('unread')), 'all rows unread initially');
const hnHidden = $$('#list .row').filter((r) => r.querySelector('.feed-name')?.textContent === 'Hacker News' && /show hn/i.test(r.querySelector('.row-title').textContent));
ok(hnHidden.length === 0, 'exclude filter hides matching articles');
ok($$('#list .row').some((r) => r.querySelector('.feed-name')?.textContent === 'Hacker News'), 'non-matching HN articles still visible');
const badgeBefore = $('#tree .tree-item[data-scope="unread"] .badge')?.textContent;

console.log('reading + mark read');
const firstRow = $('#list .row');
const firstId = firstRow.dataset.id;
firstRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);
ok(!!$('#list .row.expanded .reader-body'), 'row expands into reading pane');
ok(!!$('#list .row.expanded .reader-title'), 'reader shows title');
const badgeAfter = $('#tree .tree-item[data-scope="unread"] .badge')?.textContent;
ok(Number(badgeAfter) === Number(badgeBefore) - 1, `opening marked read, unread count ${badgeBefore} → ${badgeAfter}`);

console.log('mark unread via row action');
const toggleBtn = $('#list .row.expanded [data-act="toggle-read"]');
toggleBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);
ok($('#tree .tree-item[data-scope="unread"] .badge')?.textContent === badgeBefore, 'mark unread restores count');
// mark it read again for the read-filter test
$('#list .row.expanded [data-act="toggle-read"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);

console.log('status filters');
$('#status-chips .chip[data-status="read"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);
const readRows = $$('#list .row');
ok(readRows.length === 1 && readRows[0].dataset.id === firstId, 'read filter shows only the read article');
$('#status-chips .chip[data-status="all"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);
ok($$('#list .row').length > readRows.length, 'all filter shows everything');
$('#status-chips .chip[data-status="unread"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);

console.log('scope switching');
$('.tree-item[data-scope="feed:bbc-news"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);
ok($('#scope-title').textContent === 'BBC News', 'feed scope title updates');
ok($$('#list .row').every((r) => r.querySelector('.feed-name')?.textContent === 'BBC News'), 'feed scope shows only that feed');
$('.tree-item[data-folder="tech"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);
$('.tree-item[data-scope="folder:tech"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);
const folderFeeds = new Set($$('#list .row .feed-name').map((n) => n.textContent));
ok(folderFeeds.size > 0 && !folderFeeds.has('BBC News'), `folder scope limited to folder (${[...folderFeeds].join(', ')})`);
$('.tree-item[data-scope="all"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(50);

console.log('search operators');
const search = $('#search-input');
search.value = 'feed:bbc';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await settle(500);
ok($$('#list .row').length > 0 && $$('#list .row').every((r) => r.querySelector('.feed-name')?.textContent === 'BBC News'), 'feed: operator scopes search');
search.value = 'missiles OR russia OR glee';
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

console.log('read state persistence');
const stored = JSON.parse(window.localStorage.getItem('ghrss:read') || '{}');
ok(Object.keys(stored).length >= 1, 'read map persisted to localStorage');

console.log(`\n${pass} passed, ${fail} failed`);
window.close?.();
process.exit(fail ? 1 : 0);
