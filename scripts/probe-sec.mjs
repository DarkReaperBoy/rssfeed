import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const now = Date.now();
const arts = [
  { id: 's-1', title: 'Evil enclosure link', link: 'https://example.com/s1', date: now - 3600e3, author: null, summary: 's',
    content: '<p>body</p>', text: null,
    enclosures: [{ url: 'javascript:alert(1)', type: 'audio/mpeg' }, { url: 'https://ok.example/audio.mp3', type: 'audio/mpeg' }], fetchedAt: now },
  { id: 's-2', title: 'Evil thumb from content img', link: 'https://example.com/s2', date: now - 2 * 3600e3, author: null, summary: 's',
    content: '<p><img src="javascript:alert(2)" onerror="alert(3)"> body</p>', text: null,
    enclosures: [{ url: 'https://ok.example/pic.jpg', type: 'image/jpeg' }], fetchedAt: now },
  { id: 's-3', title: 'Data-URL thumb', link: 'https://example.com/s3', date: now - 3 * 3600e3, author: null, summary: 's',
    content: '<p>body</p>', text: null,
    enclosures: [{ url: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', type: 'image/png' }], fetchedAt: now },
];
const config = { settings: {}, folders: [], feeds: [{ id: 'sf', title: 'Sec Feed', url: 'https://sf.test' }], filters: [] };
const index = { generatedAt: now, folders: [], feeds: { sf: { title: 'Sec Feed', site: '', folder: null, folders: [], count: 3, newest: now, oldest: now - 3 * 3600e3 } } };
const html = (await fs.readFile(path.join(ROOT, 'index.html'), 'utf8')).replace(/<script src="assets\/app\.js\?v=[^"]*"><\/script>/, '');
const appSrc = await fs.readFile(path.join(ROOT, 'assets/app.js'), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.fetch = async (u) => {
  const p = String(u).split('?')[0];
  if (p === 'config.json') return { ok: true, status: 200, json: async () => structuredClone(config) };
  if (p === 'data/index.json') return { ok: true, status: 200, json: async () => structuredClone(index) };
  if (p === 'data/all-feeds.json') return { ok: true, status: 200, json: async () => structuredClone({ articles: arts.map((a) => ({ ...a, _feed: 'sf' })) }) };
  return { ok: false, status: 404, statusText: 'NF', json: async () => { throw new Error('404'); } };
};
w.eval(appSrc);
await new Promise((r) => setTimeout(r, 1100));
const $$ = (s) => [...w.document.querySelectorAll(s)];
let problems = 0;
const bad = (msg) => { problems++; console.log('  ✗ ' + msg); };
const good = (msg) => console.log('  ✓ ' + msg);
const jsHref = $$('a[href^="javascript:"]');
jsHref.length ? bad(`${jsHref.length} javascript: href(s) rendered`) : good('no javascript: hrefs anywhere in the DOM');
for (const row of $$('#list .row')) {
  const id = row.dataset.id;
  const thumb = row.querySelector('.row-thumb');
  if (id === 's-2' && thumb?.getAttribute('src') && !/^https?:/i.test(thumb.getAttribute('src'))) bad(`s-2 thumb scheme not validated: ${thumb.getAttribute('src')}`);
}
const thumbs = $$('.row-thumb').map((t) => t.getAttribute('src'));
thumbs.some((s) => s && !/^https?:/i.test(s)) ? bad(`non-http thumb rendered: ${thumbs.join(', ')}`) : good(`all ${thumbs.length} rendered thumbs are http(s)`);
w.document.querySelector('#list .row[data-id="s-1"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 300));
const attHrefs = $$('#reader-slot .reader-attachments a').map((a) => a.getAttribute('href'));
attHrefs.some((h) => h && h !== '#' && !/^https?:/i.test(h)) ? bad(`reader attachment renders non-http href: ${attHrefs.join(', ')}`) : good(`all ${attHrefs.length} reader attachment hrefs are http(s) or the # degradation`);
const imgAtt = $$('#reader-slot .reader-attachments a img').map((i) => i.getAttribute('src'));
imgAtt.some((s) => s && !/^https?:/i.test(s)) ? bad(`attachment image non-http src: ${imgAtt.join(', ')}`) : good(`all ${imgAtt.length} attachment image srcs are http(s)`);
console.log(problems ? `SECURITY GAPS: ${problems}` : 'client boundaries clean');
dom.window.close();
process.exit(problems ? 1 : 0);
