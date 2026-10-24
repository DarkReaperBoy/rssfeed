import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const now = Date.now();
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(0xC405);

const mkArticles = (feedId, n) => Array.from({ length: n }, (_, i) => ({
  id: `${feedId}-${i}`, title: `Chaos story ${feedId} ${i}`, link: `https://example.com/${feedId}/${i}`,
  date: now - i * 1800e3 - 60e3, author: 'Chaos Author', summary: `summary ${i}`,
  content: `<p>body ${i} with <b>markup</b> and a <a href="https://example.com/out">link</a></p>`,
  text: null, enclosures: [], fetchedAt: now,
}));
const FIX = {
  'chaos-a': { title: 'Chaos A', site: 'https://a.test', folder: 'fold1', articles: mkArticles('chaos-a', 30) },
  'chaos-b': { title: 'Chaos B', site: 'https://b.test', folder: 'fold2', articles: mkArticles('chaos-b', 25) },
};
const TOTAL = 55;
const config = {
  settings: { siteName: 'Chaos', theme: 'auto', refreshMinutes: 60 },
  folders: [{ id: 'fold1', name: 'Fold One' }, { id: 'fold2', name: 'Fold Two' }],
  feeds: [
    { id: 'chaos-a', title: 'Chaos A', url: 'https://a.test/rss', site: 'https://a.test', folder: 'fold1' },
    { id: 'chaos-b', title: 'Chaos B', url: 'https://b.test/rss', site: 'https://b.test', folder: 'fold2' },
  ],
};
let gen = 1;
const index = () => ({
  generatedAt: now + gen, folders: config.folders,
  feeds: Object.fromEntries(Object.entries(FIX).map(([id, f]) => [id, {
    title: f.title, site: f.site, xml: `https://${id}.test/rss`, folder: f.folder, folders: [f.folder],
    count: f.articles.length, newest: f.articles[0].date, oldest: f.articles.at(-1).date,
    status: { ok: true, disabled: false, lastAttempt: now, lastSuccess: now, consecutiveFailures: 0, error: null },
  }])),
});
const allFeeds = { articles: Object.entries(FIX).flatMap(([id, f]) => f.articles.map((a) => ({ ...a, _feed: id }))) };

const html = (await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'))
  .replace(/<script src="assets\/app\.js\?v=[^"]*"><\/script>/, '');
const appSrc = await fs.readFile(path.join(ROOT, 'assets/app.js'), 'utf8');

const vc = new VirtualConsole();
const jsErrors = [];
vc.on('jsdomError', (e) => jsErrors.push(String(e?.detail?.stack || e?.detail || e?.message || e)));
vc.on('error', (m) => jsErrors.push(String(m)));
const unhandled = [];
const onUnhandled = (e) => unhandled.push(String(e?.reason?.stack || e?.reason || e));
process.on('unhandledRejection', onUnhandled);

const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window;
w.open = () => null;
w.fetch = async (url) => {
  const p = String(url).split('?')[0];
  if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
  if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index()) };
  if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone(allFeeds) };
  const m = p.match(/^data\/feeds\/(.+)\.json$/);
  if (m && FIX[m[1]]) return { ok: true, status: 200, json: async () => structuredClone({ articles: FIX[m[1]].articles }) };
  return { ok: false, status: 404, statusText: 'NF', json: async () => { throw new Error('404'); } };
};
w.eval(appSrc);
await settle(1200);

const $ = (s) => w.document.querySelector(s);
const $$ = (s) => [...w.document.querySelectorAll(s)];
const click = (el) => { el?.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

console.log('chaos: 150 rapid j/k + m + o/s toggles with zero settling');
{
  for (let i = 0; i < 150; i++) {
    const k = pick(['j', 'k', 'j', 'j', 'm', 'm', 's', 's', 'o', 'v']);
    key(k);
  }
  await settle(150);
}
console.log('chaos: 80 rapid row clicks (open/close churn) + Escape bursts');
{
  for (let i = 0; i < 80; i++) {
    const rows = $$('#list .row');
    if (rows.length) click(pick(rows));
    if (i % 7 === 0) { key('Escape'); key('Escape'); }
  }
  await settle(150);
}
console.log('chaos: 60 scope switches (folder/feed/all) with sidebar churn');
{
  const targets = ['.tree-item[data-scope="all"]', '.tree-item[data-scope="folder:fold1"]', '.tree-item[data-scope="folder:fold2"]',
    '.tree-item[data-scope="feed:chaos-a"]', '.tree-item[data-scope="feed:chaos-b"]'];
  for (let i = 0; i < 60; i++) {
    click($(pick(targets)));
    if (i % 5 === 0) {
      const chev = $('#tree .tree-folder .tree-item .chev');
      if (chev) click(chev);
    }
    if (i % 11 === 0) click($('#menu-toggle')), click($('#scrim'));
  }
  await settle(200);
}
console.log('chaos: 50 hash + popstate events (valid, invalid, article, folder, feed)');
{
  const hashes = ['#article/chaos-a-3', '#article/nope', '#folder/Fold%20One', '#folder/bogus', '#feed/chaos-b',
    '#feed/Chaos%20A', '#article/chaos-b-19', '', '#article/chaos-a-0'];
  for (let i = 0; i < 50; i++) {
    w.location.hash = pick(hashes);
    w.dispatchEvent(new w.Event(pick(['hashchange', 'popstate'])));
  }
  await settle(250);
}
console.log('chaos: search input spam with operators, OR groups, and hostile strings');
{
  click($('#search-open'));
  const s = $('#search-input');
  const queries = ['chaos', 'feed:chaos-a', 'title:3', 'unread:true', 'is:read', 'zzz OR chaos',
    'before:2026-01-01 after:2020-01-01', '"quoted phrase"', 'a OR b OR c', '%%%&&&', 'λ', ' OR ',
    'chaos story 1', 'feed:', 'title:', 'before:not-a-date', 'unread:maybe', ' '.repeat(20)];
  for (let i = 0; i < 40; i++) {
    s.value = pick(queries);
    s.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
  await settle(500);
  s.value = 'zzz-nothing';
  s.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle(400);
  key('Escape');
  click($('#search-close'));
  await settle(200);
}
console.log('chaos: menu + mark slider + apply/undo spam');
{
  for (let i = 0; i < 30; i++) {
    click($('#btn-more'));
    click($('#btn-mark-all-split'));
    const slider = $('#mark-age-slider');
    if (slider && !$('#mark-menu').classList.contains('hidden')) {
      slider.value = String(1 + Math.floor(rand() * 30));
      slider.dispatchEvent(new w.Event('input', { bubbles: true }));
    }
    if (i % 4 === 0) {
      const apply = $('#mark-age-apply');
      if (apply && !$('#mark-menu').classList.contains('hidden')) { click(apply); await settle(60); }
    }
    if (i % 6 === 0) { click($('#toast-action')); click($('#toast-action-2')); }
    if (i % 9 === 0) key('Escape');
  }
  await settle(300);
}
console.log('chaos: badge ticks + confirm-dialog double-fire + refresh spam');
{
  for (let i = 0; i < 25; i++) {
    click($('#badge-all-items'));
    click($('#btn-mark-all'));
    const yes = $('#confirm-yes');
    if (yes && !$('#confirm-modal').classList.contains('hidden')) { click(yes); click(yes); click(yes); }
    await settle(40);
    if (i % 3 === 0) { gen++; click($('#menu-refresh')); }
    if (i % 4 === 0) click($('#toast-action'));
  }
  await settle(600);
}
console.log('chaos: cross-tab storage events with mixed read maps');
{
  for (let i = 0; i < 15; i++) {
    const map = {};
    for (const a of allFeeds.articles) if (rand() < 0.5) map[a.id] = now - Math.floor(rand() * 7200e3);
    w.localStorage.setItem('ghrss:read', JSON.stringify(map));
    w.dispatchEvent(new w.StorageEvent('storage', { key: 'ghrss:read', newValue: JSON.stringify(map), storageArea: w.localStorage }));
    await settle(30);
  }
  await settle(300);
}
console.log('chaos: modal churn (feed info + Escape + backdrop + scrim)');
{
  click($('.tree-item[data-scope="feed:chaos-a"]'));
  await settle(80);
  for (let i = 0; i < 20; i++) {
    click($('#scope-info'));
    click($('#feed-modal'));
    click($('#feed-modal-close'));
    key('Escape');
    click($('#menu-toggle'));
    click($('#scrim'));
  }
  click($('.tree-item[data-scope="all"]'));
  await settle(200);
}
console.log('chaos: final coherence + zero-error verdict');
{
  await settle(800);
  const badge = Number($('#badge-all-items').textContent || '0');
  const readMap = JSON.parse(w.localStorage.getItem('ghrss:read') || '{}');
  const trulyUnread = allFeeds.articles.filter((a) => !readMap[a.id]).length;
  ok(jsErrors.length === 0, `zero jsdom errors across the whole chaos run (${jsErrors.length ? jsErrors[0].split('\n')[0] + '…' : 'none'})`);
  ok(unhandled.length === 0, `zero unhandled promise rejections (${unhandled.length ? unhandled[0].split('\n')[0] + '…' : 'none'})`);
  ok(badge === trulyUnread, `the unread badge is coherent with persisted state after chaos (${badge} vs ${trulyUnread})`);
  ok($$('#list .row').length > 0, 'the list still renders rows');
  ok(!!$('.tree-item[data-scope="all"]') && $$('#tree .tree-item').length >= 2, 'the sidebar still renders');
}

process.off('unhandledRejection', onUnhandled);
dom.window.close();
console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
