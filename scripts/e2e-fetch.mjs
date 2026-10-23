// E2E check of the refactored fetch.mjs main(): spin up a local HTTP server
// serving controllable RSS feeds, run the fetcher against it twice, and assert
// the data pipeline (pool, conditional GET, retitle-stable ids, undated items).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = path.join(HERE, '.e2e-sandbox');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const now = Date.now();
let feed1Hits = 0;
let feed2Hits = 0;
let retitle = false;

const item = (i, t, extra = '') => `<item><title>${t}</title><link>https://example.test/a/${i}</link><guid>https://example.test/a/${i}</guid><pubDate>${new Date(now - i * 3600e3).toUTCString()}</pubDate><description>Body of ${t}${extra}</description></item>`;
const rss1 = () => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed One</title>${item(1, 'First post')}${item(2, 'Second post')}${item(3, 'Undated post')}</item>`.replace('</item>$', '') + '</channel></rss>';
// build feed1 with item 3 carrying no pubDate
const rss1Real = () => {
  const undated = '<item><title>Undated post</title><link>https://example.test/a/3</link><guid>https://example.test/a/3</guid><description>No date here</description></item>';
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed One</title>${item(1, retitle ? 'First post (EDITED TITLE)' : 'First post')}${item(2, 'Second post')}${undated}</channel></rss>`;
};
let rss1Body = rss1Real();
const rss2 = () => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed Two</title>${item(10, 'Other feed post')}</channel></rss>`;

const server = http.createServer((req, res) => {
  const etag = '"v1"';
  if (req.url === '/feed1.xml') {
    feed1Hits++;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', ETag: etag });
    res.end(rss1Body);
  } else if (req.url === '/feed2.xml') {
    feed2Hits++;
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(rss2());
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// sandbox: scripts copied so ROOT resolves inside the sandbox
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, 'scripts'), { recursive: true });
for (const f of ['fetch.mjs', '4chan.mjs', 'hackernews.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(SANDBOX, 'scripts', f));
fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
  settings: { retentionDays: 30, fullTextDefault: false },
  feeds: [
    { id: 'one', title: 'Feed One', url: `http://127.0.0.1:${port}/feed1.xml` },
    { id: 'two', title: 'Feed Two', url: `http://127.0.0.1:${port}/feed2.xml` },
  ],
}, null, 2));

// async exec: a SYNC child would block this process's event loop and freeze
// the fixture HTTP server mid-request.
const run = (env) => new Promise((resolve, reject) => {
  execFile('node', ['scripts/fetch.mjs'], { cwd: SANDBOX, encoding: 'utf8', env: { ...process.env, ...env } }, (err, stdout, stderr) => {
    if (err && !stdout) reject(err); else resolve(stdout + (stderr ? '\n' + stderr : ''));
  });
});
let pass = 0, fail = 0;
const ok = (c, name) => { c ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };

console.log('run 1: cold fetch');
let out = await run();
const one1 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/one.json'), 'utf8'));
const two1 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/two.json'), 'utf8'));
const all1 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/all-feeds.json'), 'utf8'));
const idx1 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
ok(one1.articles.length === 3, `feed one stores 3 articles (${one1.articles.length})`);
ok(two1.articles.length === 1, 'feed two stores 1 article');
ok(all1.articles.length === 4, `all-feeds.json carries all 4 with _feed (${all1.articles.length})`);
ok(idx1.feeds.one.status.ok === true && idx1.feeds.one.status.etag === '"v1"', 'etag stored in status for conditional GET');
const first1 = one1.articles.find((a) => a.title === 'First post');
const undated1 = one1.articles.find((a) => a.title === 'Undated post');
ok(!!undated1 && undated1.date > now - 60000, 'undated item got a first-seen date (now)');
console.log(out.trim().split('\n').map((l) => '    ' + l).join('\n'));

console.log('run 2: conditional GET (304) + retitle migration');
await new Promise((r) => setTimeout(r, 1100));
out = await run();
ok(feed1Hits === 2 && /not modified/.test(out), 'feed one answered 304 → kept stored set');
const one2 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/one.json'), 'utf8'));
ok(one2.articles.length === 3 && one2.articles.some((a) => a.title === 'Undated post'), '304 path keeps stored articles');
const undated2 = one2.articles.find((a) => a.title === 'Undated post');
ok(undated2.date === undated1.date, 'undated item did NOT get re-stamped now on the 304 run');
ok(idx1 !== null, 'index parsed');

console.log('run 3: retitle — the id must survive an edited title');
retitle = true;
rss1Body = rss1Real();
await new Promise((r) => setTimeout(r, 1100)); // let the ETag go stale? ETag unchanged → 304 keeps OLD copy. Change the etag to force a refetch:
server.close();
const server2 = http.createServer((req, res) => {
  const etag = '"v2"';
  if (req.url === '/feed1.xml') {
    feed1Hits++;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', ETag: etag });
    res.end(rss1Body);
  } else if (req.url === '/feed2.xml') {
    feed2Hits++;
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(rss2());
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server2.listen(port, '127.0.0.1', r));
out = await run();
const one3 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/one.json'), 'utf8'));
ok(one3.articles.length === 3, `retitle run: still 3 articles, no duplicate (${one3.articles.length})`);
const edited = one3.articles.find((a) => a.title === 'First post (EDITED TITLE)');
ok(!!edited, 'retitled article present under the new title');
ok(edited && edited.id === first1.id, `retitled article KEPT its id (${edited?.id} vs ${first1.id}) — read state and deep links survive`);
ok(one3.articles.filter((a) => a.title === 'First post').length === 0, 'old-title copy is gone (no duplicate)');

server2.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
