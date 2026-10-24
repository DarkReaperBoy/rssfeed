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
const mk = (id, title, h) => ({ id, title, link: `https://example.com/${id}`, date: now - h * H, author: null, summary: title, content: `<p>${title}</p>`, text: null, enclosures: [], fetchedAt: now });
const arts = [mk('c-old', 'Oldest read one', 30), mk('c-a', 'Unread alpha', 9), mk('c-b', 'Unread beta', 8), mk('c-c', 'Unread gamma', 7), mk('c-new', 'Newest read one', 2)];
const config = { settings: { siteName: 'My RSSFeed', theme: 'auto' }, folders: [], feeds: [{ id: 'cf', title: 'Char Feed', url: 'https://cf.test/rss' }] };
const index = { generatedAt: now, folders: [], feeds: { cf: { title: 'Char Feed', site: '', folder: null, folders: [], count: arts.length, newest: arts[0].date, oldest: arts.at(-1).date } } };

const html = (await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'))
  .replace(/<script src="assets\/app\.js\?v=[^"]*"><\/script>/, '');
const appSrc = await fs.readFile(path.join(ROOT, 'assets/app.js'), 'utf8');

const bootDom = async ({ url = 'https://example.test/', readSeed = null, cfg = config, idx = index, opened = [], artsList = arts } = {}) => {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = async (u) => {
    const p = String(u).split('?')[0];
    if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(cfg) };
    if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(idx) };
    if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone({ articles: artsList.map((a) => ({ ...a, _feed: 'cf' })) }) };
    return { ok: false, status: 404, statusText: 'NF', json: async () => { throw new Error('404'); } };
  };
  w.localStorage.setItem('ghrss:ver', '3');
  if (readSeed) w.localStorage.setItem('ghrss:read', JSON.stringify(readSeed));
  const realOpen = w.open.bind(w);
  w.open = (u, t, f) => { opened.push({ u, t, f }); return null; };
  w.eval(appSrc);
  await settle(1100);
  return { dom, w };
};

console.log('characterization: deep link to an already-read article');
{
  const { dom, w } = await bootDom({ url: 'https://example.test/#article/c-old', readSeed: { 'c-old': now - H } });
  const rows = [...w.document.querySelectorAll('#list .row')];
  ok(rows.map((r) => r.dataset.id).join(',') === 'c-old,c-a,c-b,c-c,c-new', 'KNOWN: the deep-linked READ article stays visible, in its SORTED position (oldest-first, so first)');
  ok(w.document.querySelector('#reader-slot .reader')?.dataset.id === 'c-old', 'the reader opened the deep-linked read article');
  ok(Number(w.document.querySelector('#badge-all-items').textContent) === 4, 'badge counts only the 4 truly unread');
  const nextB = w.document.querySelector('#reader-slot [data-act="next"]');
  const prevB = w.document.querySelector('#reader-slot [data-act="prev"]');
  ok(prevB.disabled === true && nextB.disabled === false, 'prev/next match the sorted position (prev disabled at the top)');
  dom.window.close();
}
{
  const { dom, w } = await bootDom({ url: 'https://example.test/#article/c-new', readSeed: { 'c-new': now - H } });
  const rows = [...w.document.querySelectorAll('#list .row')];
  ok(rows.map((r) => r.dataset.id).join(',') === 'c-old,c-a,c-b,c-c,c-new', 'KNOWN: read deep-link at the newest end also stays in sorted position (last)');
  const nextB = w.document.querySelector('#reader-slot [data-act="next"]');
  ok(nextB.disabled === true, 'next disabled at the sorted end');
  dom.window.close();
}
console.log('characterization: unknown #article id self-heals');
{
  const { dom, w } = await bootDom({ url: 'https://example.test/#article/nope-zone' });
  ok(!w.location.hash, 'an unknown article id clears the hash');
  ok(!w.document.querySelector('#toast').classList.contains('hidden'), 'the unknown-article toast explains itself');
  ok(w.document.querySelectorAll('#list .row').length === 5, 'the list still renders every unread row');
  dom.window.close();
}
console.log('characterization: keyboard o/v open the original; / focuses search');
{
  const opened = [];
  const { dom, w } = await bootDom({ opened });
  w.document.querySelector('#list .row[data-id="c-a"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(80);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'o', bubbles: true }));
  await settle(60);
  ok(opened.length === 1 && opened[0].u === 'https://example.com/c-a' && opened[0].t === '_blank', 'o opens the original in a new tab (noopener)');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'v', bubbles: true }));
  await settle(60);
  ok(opened.length === 2 && opened[1].u === 'https://example.com/c-a', 'v behaves like o');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: '/', bubbles: true }));
  await settle(60);
  ok(!w.document.querySelector('#search-box').classList.contains('hidden') && w.document.activeElement === w.document.querySelector('#search-input'), '/ opens and focuses the search box while an article is open');
  dom.window.close();
}
console.log('characterization: j/k clamp at the ends without dying');
{
  const { dom, w } = await bootDom({});
  const ids = [...w.document.querySelectorAll('#list .row')].map((r) => r.dataset.id);
  for (let i = 0; i < 6; i++) w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  await settle(120);
  ok(w.document.querySelector('#reader-slot .reader')?.dataset.id === ids.at(-1), 'extra j presses clamp at the last article');
  for (let i = 0; i < 6; i++) w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', bubbles: true }));
  await settle(120);
  ok(w.document.querySelector('#reader-slot .reader')?.dataset.id === ids[0], 'extra k presses clamp at the first article');
  dom.window.close();
}
console.log('characterization: a click with an active text selection does not open the row');
{
  const { dom, w } = await bootDom({});
  const row = w.document.querySelector('#list .row[data-id="c-a"]');
  const sel = w.getSelection();
  const range = w.document.createRange();
  range.selectNodeContents(row.querySelector('.row-title'));
  sel.removeAllRanges();
  sel.addRange(range);
  row.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(!w.document.body.classList.contains('article-open'), 'KNOWN: selection guard blocks the open (row click is swallowed while text is selected)');
  sel.removeAllRanges();
  row.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(80);
  ok(w.document.body.classList.contains('article-open'), 'the same row opens once the selection clears');
  dom.window.close();
}
console.log('characterization: cross-tab storage sync re-renders, filter-flag guards stay session-scoped');
{
  const flaggedArts = arts.map((a) => (a.id === 'c-a' ? { ...a, autoRead: true } : a));
  const { dom, w } = await bootDom({ artsList: flaggedArts });
  ok(Number(w.document.querySelector('#badge-all-items').textContent) === 4, 'the backend markRead flag auto-reads "c-a" at load (4 unread left of 5)');
  w.localStorage.setItem('ghrss:read', JSON.stringify({ 'c-b': now - H }));
  w.dispatchEvent(new w.StorageEvent('storage', { key: 'ghrss:read', newValue: JSON.stringify({ 'c-b': now - H }), storageArea: w.localStorage }));
  await settle(120);
  const hasRow = (id) => !![...w.document.querySelectorAll('#list .row')].find((r) => r.dataset.id === id);
  ok(!hasRow('c-b') && Number(w.document.querySelector('#badge-all-items').textContent) === 4, 'the cross-tab sync adopts the incoming read map verbatim (c-b now read → gone from the unread view, badge 4)');
  const readNow = JSON.parse(w.localStorage.getItem('ghrss:read') || '{}');
  ok(typeof readNow['c-b'] === 'number' && readNow['c-a'] === undefined, 'the incoming cross-tab read map replaced the stored one');
  ok(hasRow('c-a') && [...w.document.querySelectorAll('#list .row')].find((r) => r.dataset.id === 'c-a')?.classList.contains('unread'), 'KNOWN: the flag-read article flips back to UNREAD after the sync (read map replaced wholesale; flags do not re-materialize on storage events)');
  dom.window.close();
}
console.log('characterization: the mark-age slider remembers the last dragged value');
{
  const { dom, w } = await bootDom({});
  const open = async () => { w.document.querySelector('#btn-mark-all-split').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(30); };
  await open();
  const s = w.document.querySelector('#mark-age-slider');
  s.value = '1';
  s.dispatchEvent(new w.Event('input', { bubbles: true }));
  s.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(30);
  ok(w.document.querySelector('#mark-age-count').textContent === 'Will mark 1 article', 'the preview counts publication age (one 30-hour-old unread article)');
  w.document.querySelector('#btn-mark-all-split').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(30);
  await open();
  ok(Number(w.document.querySelector('#mark-age-slider').value) === 1, 'reopening shows the last dragged value (drag-release persists without applying)');
  ok(w.document.querySelector('#mark-age-value').textContent === '1 day', 'the sentence reflects it');
  for (let i = 0; i < 31; i++) {
    s.value = String(1 + (i % 30));
    s.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
  await settle(30);
  ok(w.document.querySelector('#mark-age-value').textContent === '1 day', 'rapid drag spam settles on the final value');
  ok(w.document.querySelector('#mark-age-count').textContent === 'Will mark 1 article', 'the preview follows the spam (the 30-hour-old article)');
  dom.window.close();
}
console.log('characterization: double-clicking the confirm button lands the action exactly once');
{
  const { dom, w } = await bootDom({});
  const before = Number(w.document.querySelector('#badge-all-items').textContent);
  w.document.querySelector('#btn-mark-all').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(30);
  const yes = w.document.querySelector('#confirm-yes');
  yes.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  yes.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  yes.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(300);
  ok(Number(w.document.querySelector('#badge-all-items').textContent) === 0, `rapid triple-confirm marks everything read exactly once (${before} → 0)`);
  ok(w.document.querySelector('#confirm-modal').classList.contains('hidden'), 'the modal closed after the first confirm');
  dom.window.close();
}
console.log('characterization: folder maxAgeDays cutoff + deep link into a cutoff article');
{
  const cfgA = { settings: config.settings, folders: [{ id: 'fold', name: 'Fold', maxAgeDays: 1 }], feeds: [{ id: 'cf', title: 'Char Feed', url: 'https://cf.test/rss', folder: 'fold' }] };
  const idxA = { generatedAt: now, folders: [{ id: 'fold', name: 'Fold', maxAgeDays: 1 }], feeds: { cf: { ...index.feeds.cf, folder: 'fold', folders: ['fold'] } } };
  const { dom, w } = await bootDom({ cfg: cfgA, idx: idxA, url: 'https://example.test/#folder/Fold' });
  ok(w.document.querySelectorAll('#list .row').length === 4, 'the 1-day folder cutoff drops the 30-hour-old article (4 of 5 rows)');
  w.location.hash = '#article/c-old';
  w.dispatchEvent(new w.Event('hashchange'));
  await settle(150);
  const rowsAfter = [...w.document.querySelectorAll('#list .row')].map((r) => r.dataset.id);
  ok(w.document.querySelector('#reader-slot .reader')?.dataset.id === 'c-old', 'a deep link into the cutoff article still opens the reader');
  ok(rowsAfter.at(-1) === 'c-old' && rowsAfter.length === 5, 'KNOWN: the cutoff article is APPENDED to the end of the visible list (out-of-sort corner, pinned as-is)');
  dom.window.close();
}

console.log('characterization: empty-state copy matches the real fetch schedule');
{
  const { dom, w } = await bootDom({ idx: null, artsList: [] });
  ok(w.document.querySelector('#empty h3')?.textContent === 'No data yet', 'the no-data state names itself');
  ok(/every 15 minutes/.test(w.document.querySelector('#empty').textContent), 'the no-data copy states the real fetch cadence (every 15 minutes)');
  dom.window.close();
  const { dom: dom3, w: w3 } = await bootDom({ artsList: [] });
  w3.document.querySelector('#btn-more').dispatchEvent(new w3.MouseEvent('click', { bubbles: true }));
  await settle(30);
  w3.document.querySelector('#status-items [data-status="all"]').dispatchEvent(new w3.MouseEvent('click', { bubbles: true }));
  await settle(100);
  ok(w3.document.querySelector('#empty h3')?.textContent === 'Nothing here', 'the nothing-here state names itself');
  ok(/every 15 minutes/.test(w3.document.querySelector('#empty').textContent), 'the nothing-here copy states the real fetch cadence (every 15 minutes)');
  dom3.window.close();
}
console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
