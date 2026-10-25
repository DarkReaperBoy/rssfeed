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
let ftEtag = '"ft1"';
let ftFeedHits = 0;
let art1Hits = 0;
let art2Hits = 0;
const item = (i, t, extra = '') => `<item><title>${t}</title><link>https://example.test/a/${i}</link><guid>https://example.test/a/${i}</guid><pubDate>${new Date(now - i * 3600e3).toUTCString()}</pubDate><description>Body of ${t}${extra}</description></item>`;
const rss1Real = () => {
  const undated = '<item><title>Undated post</title><link>https://example.test/a/3</link><guid>https://example.test/a/3</guid><description>No date here</description></item>';
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed One</title><link>https://example.test/one</link>${item(1, retitle ? 'First post (EDITED TITLE)' : 'First post')}${item(2, 'Second post')}${undated}</channel></rss>`;
};
let rss1Body = rss1Real();
const rss2 = () => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed Two</title><link>https://example.test/two</link><image><url>https://example.test/two.png</url><title>Feed Two</title></image>${item(10, 'Other feed post')}</channel></rss>`;
const hostileRss = () => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Hostile Feed</title><link>javascript:alert(1)</link><description>evil channel</description>
<item><title>Script payload item</title><link>javascript:alert(document.domain)</link><guid>h-1</guid><description><![CDATA[<p>real text</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">evil link</a><iframe src="https://evil.example/embed"></iframe>]]></description></item>
<item><title>${'T'.repeat(3000)}</title><link>https://example.test/long</link><guid>h-2</guid><enclosure url="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" type="image/png"/><enclosure url="javascript:alert(4)" type="audio/mpeg"/><enclosure url="https://ok.example/pic.jpg" type="image/jpeg"/><description>enclosure boundary test</description></item>
<item><title>Duplicate guid one</title><link>https://example.test/dup1</link><guid>h-dup</guid><description>first</description></item>
<item><title>Duplicate guid two</title><link>https://example.test/dup2</link><guid>h-dup</guid><description>second</description></item>
</channel></rss>`;
const brokenRss = '<?xml version="1.0"?><rss><channel><title>Broken</title><item><title>never closes';
const ftItem = (i, link, desc) => `<item><title>FT story ${i}</title><link>${link}</link><guid>ft-${i}</guid><pubDate>${new Date(now - i * 3600e3).toUTCString()}</pubDate><description>${desc}</description></item>`;
const ftRss = () => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>FT Feed</title><link>https://example.test/ft</link>${ftItem(1, `http://127.0.0.1:${port}/article1.html`, 'short teaser one')}${ftItem(2, `http://127.0.0.1:${port}/article2.html`, 'short teaser two')}${ftItem(3, `http://127.0.0.1:${port}/article3.html`, 'short teaser three')}${ftItem(4, `http://127.0.0.1:${port}/article4.html`, 'X'.repeat(420))}</channel></rss>`;
const article1Html = `<!doctype html><html><head><title>FT Article One</title></head><body><article><h1>FT Article One</h1><p>This is the extracted body of article one. It carries the READABILITY_MARKER_PHRASE deep inside a paragraph so the pipeline can prove the text landed. Around it sit more sentences with ordinary words so the extractor sees enough content to keep the page. The quick brown fox jumps over the lazy dog again and again while the reader keeps counting words toward the extraction threshold.</p><p>A second paragraph with more plain prose ensures the result comfortably clears the one hundred twenty character minimum imposed on extracted text.</p><script>EVIL_SCRIPT_BODY()</script></article></body></html>`;
const article2Html = '<!doctype html><html><head><title>FT Two</title></head><body><p>tiny</p></body></html>';
let chanMode = 'ok';
const CHAN_LM = 'Mon, 01 Jan 2024 00:00:00 GMT';
const chanCatalog = () => JSON.stringify([{ threads: [
  { no: 9001, time: Math.floor(now / 1000) - 3600, replies: 120, sub: 'Fresh thread', com: 'fresh op' },
  { no: 9002, time: Math.floor(now / 1000) - 90 * 86400, replies: 400, sub: 'Ninety-day-old thread', com: 'old op' },
] }]);
const chanRoutes = (req, res) => {
  if (req.url === '/boards.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ boards: [{ board: 'g', ws_board: 1, title: '/g/ - Technology' }] }));
    return true;
  }
  if (req.url === '/g/catalog.json') {
    if (chanMode === 'error') { res.writeHead(500); res.end(); return true; }
    if (chanMode === 'same' && req.headers['if-modified-since'] === CHAN_LM) { res.writeHead(304); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Last-Modified': CHAN_LM });
    res.end(chanCatalog());
    return true;
  }
  return false;
};
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
  } else if (req.url === '/feed3.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(hostileRss());
  } else if (req.url === '/feed4.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(brokenRss);
  } else if (chanRoutes(req, res)) { /* served */ }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
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
await new Promise((r) => setTimeout(r, 1100)); 
server.close();
let liveEtag = '"v2"';
const server2 = http.createServer((req, res) => {
  const etag = liveEtag;
  if (req.url === '/feed1.xml') {
    feed1Hits++;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', ETag: etag });
    res.end(rss1Body);
  } else if (req.url === '/feed2.xml') {
    feed2Hits++;
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(rss2());
  } else if (req.url === '/feed3.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(hostileRss());
  } else if (req.url === '/feed4.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(brokenRss);
  } else if (req.url === '/ftfeed.xml') {
    ftFeedHits++;
    if (req.headers['if-none-match'] === ftEtag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', ETag: ftEtag });
    res.end(ftRss());
  } else if (req.url === '/article1.html') {
    art1Hits++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(article1Html);
  } else if (req.url === '/article2.html') {
    art2Hits++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(article2Html);
  } else if (chanRoutes(req, res)) { /* served */ }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server2.listen(port, '127.0.0.1', r));
out = await run();
const one3 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/one.json'), 'utf8'));
ok(one3.articles.length === 3, `retitle run: still 3 articles, no duplicate (${one3.articles.length})`);
const edited = one3.articles.find((a) => a.title === 'First post (EDITED TITLE)');
ok(!!edited, 'retitled article present under the new title');
ok(edited && edited.id === first1.id, `retitled article KEPT its id (${edited?.id} vs ${first1.id}) — read state and deep links survive`);
ok(one3.articles.filter((a) => a.title === 'First post').length === 0, 'old-title copy is gone (no duplicate)');
console.log('run 4: minimal config — no id/title/site; the backend derives everything it can from the feed');
fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
  settings: { retentionDays: 30, fullTextDefault: false },
  feeds: [
    { url: `http://127.0.0.1:${port}/feed1.xml` },
    { url: `http://127.0.0.1:${port}/feed2.xml`, title: 'Custom Two' },
  ],
}, null, 2));
await new Promise((r) => setTimeout(r, 1100));
out = await run();
const idOne = '127-0-0-1-feed1', idTwo = '127-0-0-1-feed2';
ok(fs.existsSync(path.join(SANDBOX, 'data/feeds', `${idOne}.json`)), `the data file is named by the URL-derived id (${idOne}.json)`);
const idx4 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
ok(idx4.feeds[idOne] && idx4.feeds[idOne].title === 'Feed One', 'title comes from the feed itself when the config omits it');
ok(idx4.feeds[idOne].site === 'https://example.test/one', 'site comes from the channel link when the config omits it');
ok(idx4.feeds[idOne].xml === `http://127.0.0.1:${port}/feed1.xml`, 'the index records the raw feed URL (xml)');
ok(idx4.feeds[idOne].origTitle === null, 'no origTitle when nothing was renamed');
ok(idx4.feeds[idTwo].title === 'Custom Two', 'a config title still wins when set');
ok(idx4.feeds[idTwo].origTitle === 'Feed Two', 'the source self-title is preserved as origTitle under a rename');
ok(idx4.feeds[idTwo].image === 'https://example.test/two.png', 'a channel image is captured for the modal pfp');
ok(!fs.existsSync(path.join(SANDBOX, 'data/feeds/one.json')) && !fs.existsSync(path.join(SANDBOX, 'data/feeds/two.json')), 'the old explicit-id files for the same URLs are wiped (config no longer names them)');
ok(!('one' in idx4.feeds) && !('two' in idx4.feeds), 'the index carries no trace of the old ids');
const one4 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds', `${idOne}.json`), 'utf8'));
ok(one4.articles.find((a) => a.title === 'First post (EDITED TITLE)').id === first1.id, 'article ids survive the feed-id change (guid-keyed) — read state and deep links keep working');
console.log('run 5: removing a feed from the config wipes its cached data (and orphans are swept)');
fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
  settings: { retentionDays: 30, fullTextDefault: false },
  feeds: [{ url: `http://127.0.0.1:${port}/feed1.xml` }],
}, null, 2));
fs.writeFileSync(path.join(SANDBOX, 'data/feeds/ghost.json'), JSON.stringify({ articles: [] }));
await new Promise((r) => setTimeout(r, 1100));
out = await run();
ok(!fs.existsSync(path.join(SANDBOX, 'data/feeds', `${idTwo}.json`)), 'the removed feed\u2019s data file is deleted');
ok(!fs.existsSync(path.join(SANDBOX, 'data/feeds/ghost.json')), 'an orphan file with no config entry is swept too');
const idx5 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
ok(!(idTwo in idx5.feeds), 'the removed feed leaves the index');
const all5 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/all-feeds.json'), 'utf8'));
ok(all5.articles.length > 0 && all5.articles.every((a) => a._feed === idOne), 'the removed feed leaves all-feeds.json entirely');
console.log('run 6: renaming a feed id adopts the previous data (lossless id migration)');
fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
  settings: { retentionDays: 30, fullTextDefault: false },
  feeds: [{ id: 'renamed-one', url: `http://127.0.0.1:${port}/feed1.xml` }],
}, null, 2));
await new Promise((r) => setTimeout(r, 1100));
out = await run();
ok(/adopted 3 articles from previous id/.test(out), 'the run logs the adoption');
ok(fs.existsSync(path.join(SANDBOX, 'data/feeds/renamed-one.json')), 'the renamed id owns the data file now');
const one6 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/renamed-one.json'), 'utf8'));
ok(one6.articles.length === 3, `the renamed id kept all 3 articles (${one6.articles.length})`);
ok(one6.articles.find((a) => a.title === 'First post (EDITED TITLE)').id === first1.id, '…with identical article ids (read state survives the rename)');
ok(!fs.existsSync(path.join(SANDBOX, 'data/feeds/127-0-0-1-feed1.json')), 'the pre-rename file is wiped');
const idx6 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
ok(!('127-0-0-1-feed1' in idx6.feeds) && 'renamed-one' in idx6.feeds, 'the index carries only the new id');
ok(idx6.feeds['renamed-one'].status.ok === true, 'the adopted status keeps the crawl healthy');
console.log('run 7: global filters run in the backend — hide drops, markRead/keepUnread/highlight become article flags');
fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
  settings: { retentionDays: 30, fullTextDefault: false },
  feeds: [{ id: 'renamed-one', url: `http://127.0.0.1:${port}/feed1.xml` }],
  filters: [
    { id: 'f-hide', name: 'hide', feeds: ['renamed-one'], exclude: { title: ['Second'] }, actions: { hide: true } },
    { id: 'f-read', name: 'mr', feeds: ['renamed-one'], include: { title: ['First'] }, actions: { markRead: true } },
    { id: 'f-keep', name: 'ku', feeds: ['renamed-one'], include: { title: ['Undated'] }, actions: { keepUnread: true } },
    { id: 'f-hl', name: 'hl', feeds: ['renamed-one'], include: { title: ['Undated'] }, actions: { highlight: true } },
  ],
}, null, 2));
await new Promise((r) => setTimeout(r, 1100));
out = await run();
{
  const one7 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/renamed-one.json'), 'utf8'));
  ok(one7.articles.length === 2, `the hidden article is dropped retroactively — even on a 304 run (${one7.articles.length} left)`);
  ok(!one7.articles.some((a) => a.title === 'Second post'), 'no banned article slips: "Second post" never reaches the data files');
  const first7 = one7.articles.find((a) => /First post/.test(a.title));
  const undated7 = one7.articles.find((a) => a.title === 'Undated post');
  ok(first7?.autoRead === true, 'the markRead filter bakes an autoRead flag into the article');
  ok(undated7?.keepUnread === true && undated7?.highlight === true, 'the keepUnread and highlight filters bake their flags');
  ok(first7?.keepUnread === undefined && first7?.highlight === undefined, 'unmatched actions leave no flag keys behind');
  const all7 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/all-feeds.json'), 'utf8'));
  ok(!all7.articles.some((a) => a.title === 'Second post') && all7.articles.length === 2, 'all-feeds.json carries the filtered set only');
  const idx7 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(idx7.feeds['renamed-one'].count === 2, 'the index count reflects the post-filter list');
  ok(/dropped 1 by config filter/.test(out), 'the run logs the config-filter drop');
}
console.log('run 8: a failing feed still re-applies filters to retained data (no banned article slips back during an outage)');
fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
  settings: { retentionDays: 30, fullTextDefault: false },
  feeds: [{ id: 'renamed-one', url: 'http://127.0.0.1:9/feed1.xml' }],
  filters: [
    { id: 'f-hide', name: 'hide', feeds: ['renamed-one'], exclude: { title: ['Second'] }, actions: { hide: true } },
    { id: 'f-read', name: 'mr', feeds: ['renamed-one'], include: { title: ['First'] }, actions: { markRead: true } },
  ],
}, null, 2));
await new Promise((r) => setTimeout(r, 1100));
out = await run();
{
  const one8 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/renamed-one.json'), 'utf8'));
  ok(/FETCH FAILED/.test(out), 'the feed genuinely failed (connection refused)');
  ok(one8.articles.length === 2 && !one8.articles.some((a) => a.title === 'Second post'), 'the failure path kept the RETAINED data minus the banned article — nothing slipped back');
  ok(one8.articles.find((a) => /First post/.test(a.title))?.autoRead === true, 'flags survive the failure path');
}
console.log('run 9: removing a filter clears its flags and restores retention on the next run');
liveEtag = '"v3"';
fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
  settings: { retentionDays: 30, fullTextDefault: false },
  feeds: [{ id: 'renamed-one', url: `http://127.0.0.1:${port}/feed1.xml` }],
}, null, 2));
await new Promise((r) => setTimeout(r, 1100));
out = await run();
{
  const one9 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/renamed-one.json'), 'utf8'));
  ok(one9.articles.length === 3, 'the un-banned article returns with the retained set (3 again)');
  ok(one9.articles.every((a) => a.autoRead === undefined && a.keepUnread === undefined && a.highlight === undefined), 'removing the filters clears every stale flag');
}
console.log('run 10: adversarial ingest — hostile payloads neutralized at every boundary');
fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
  settings: { retentionDays: 30, fullTextDefault: false },
  feeds: [{ id: 'three', title: 'Hostile Feed', url: `http://127.0.0.1:${port}/feed3.xml` }],
}, null, 2));
await new Promise((r) => setTimeout(r, 1100));
out = await run();
{
  const three = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/three.json'), 'utf8'));
  const allTen = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/all-feeds.json'), 'utf8'));
  const idxTen = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(three.articles.length === 3, `four hostile items with duplicate guids collapse to three stored (${three.articles.length})`);
  const scriptItem = three.articles.find((a) => a.title === 'Script payload item');
  ok(!!scriptItem, 'the hostile item survives as data');
  ok(scriptItem.link === '', 'a javascript: item link degrades to empty (never an executable href)');
  ok(!/<script/i.test(scriptItem.content) && !/onerror/i.test(scriptItem.content), 'script tags and onerror attributes are stripped from stored content');
  ok(!/href="javascript:/i.test(scriptItem.content), 'no javascript: href survives in stored content');
  ok(!/<iframe[^>]+evil\.example/.test(scriptItem.content) && scriptItem.content.includes('data-blocked-embed'), 'an off-allowlist iframe becomes the blocked-embed marker, never a live frame');
  const longItem = three.articles.find((a) => /^T{300}$/.test(a.title));
  ok(!!longItem, `the 3000-char title is capped to 300 (${three.articles.find((a) => a.title.length > 300)?.title.length || 'none over'})`);
  const encItem = three.articles.find((a) => a.title.length === 300);
  ok(!!encItem && encItem.enclosures.length === 1 && encItem.enclosures[0].url === 'https://ok.example/pic.jpg', `RSS <enclosure> reaches the data: only the http(s) one survives, data: and javascript: dropped (${JSON.stringify(encItem?.enclosures)})`);
  ok(idxTen.feeds.three.site === '', 'a javascript: channel link never becomes the feed site');
  ok(allTen.articles.length === 3 && allTen.articles.every((a) => a._feed === 'three'), 'all-feeds.json carries the cleaned set');
  const dupTitles = three.articles.filter((a) => /^Duplicate guid (one|two)$/.test(a.title));
  ok(dupTitles.length === 1, `same-guid items merge into one stored article (${dupTitles.map((a) => a.title).join('/')})`);
}
console.log('run 11: malformed XML — parse failure keeps the retained set');
fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
  settings: { retentionDays: 30, fullTextDefault: false },
  feeds: [{ id: 'three', title: 'Hostile Feed', url: `http://127.0.0.1:${port}/feed4.xml` }],
}, null, 2));
await new Promise((r) => setTimeout(r, 1100));
out = await run();
{
  const three = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/three.json'), 'utf8'));
  const idxEleven = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(/PARSE FAILED/.test(out), 'the malformed feed reports a parse failure');
  ok(three.articles.length === 3, 'the parse failure keeps the previous cleaned set (3)');
  ok(idxEleven.feeds.three.status.ok === false && /Parse error/.test(idxEleven.feeds.three.status.error || ''), 'the crawl status records the parse error');
}
console.log('run 12: 4chan feeds — retention trims on EVERY write path (success, 304, failure)');
{
  const chanCfg = (retentionDays) => JSON.stringify({
    settings: { retentionDays, fullTextDefault: false },
    feeds: [{ type: '4chan', board: 'g', id: 'chang', title: '/g/ - Technology' }],
  }, null, 2);
  const readChang = () => JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/chang.json'), 'utf8'));
  const runChan = async (retentionDays) => run({ GHRSS_CHAN_API: `http://127.0.0.1:${port}` });

  chanMode = 'ok';
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), chanCfg(120));
  await new Promise((r) => setTimeout(r, 1100));
  out = await runChan();
  ok(readChang().articles.length === 2, `baseline: both live threads stored under a 120-day retention (${readChang().articles.length})`);
  ok(readChang().articles.some((a) => a.title === 'Ninety-day-old thread'), 'the 90-day-old thread is inside the wide window');

  fs.writeFileSync(path.join(SANDBOX, 'config.json'), chanCfg(30));
  await new Promise((r) => setTimeout(r, 1100));
  out = await runChan();
  ok(readChang().articles.length === 1 && readChang().articles[0].title === 'Fresh thread', `success path: a 30-day retention drops the 90-day-old live thread at ingest (${readChang().articles.length})`);

  fs.writeFileSync(path.join(SANDBOX, 'config.json'), chanCfg(120));
  await new Promise((r) => setTimeout(r, 1100));
  out = await runChan();
  ok(readChang().articles.length === 2, 're-widened: the old thread is back (catalog still live)');

  chanMode = 'same';
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), chanCfg(30));
  await new Promise((r) => setTimeout(r, 1100));
  out = await runChan();
  ok(/not modified/.test(out), 'the catalog answered 304');
  ok(readChang().articles.length === 1 && readChang().articles[0].title === 'Fresh thread', `304 path: retention re-trims the retained set (${readChang().articles.length})`);

  chanMode = 'error';
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), chanCfg(30));
  await new Promise((r) => setTimeout(r, 1100));
  out = await runChan();
  ok(/FETCH FAILED/.test(out), 'the catalog failed');
  ok(readChang().articles.length === 1 && readChang().articles[0].title === 'Fresh thread', `failure path: retained data stays retention-trimmed (${readChang().articles.length})`);
  chanMode = 'ok';
}
console.log('run 13: feeds.opml import — merge with config, folder nesting, url dedup');
{
  fs.writeFileSync(path.join(SANDBOX, 'feeds.opml'), `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>subs</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Feed One" xmlUrl="http://127.0.0.1:${port}/feed1.xml" htmlUrl="https://opml.example/one"/>
      <outline type="rss" text="Custom Two" xmlUrl="http://127.0.0.1:${port}/feed2.xml"/>
    </outline>
    <outline type="rss" text="Duplicate Of Two" xmlUrl="http://127.0.0.1:${port}/feed2.xml"/>
  </body>
</opml>`);
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
    settings: { retentionDays: 30, fullTextDefault: false },
    folders: [{ id: 'f-config', name: 'From Config' }],
    feeds: [{ id: 'cfg-one', url: `http://127.0.0.1:${port}/feed1.xml`, folder: 'f-config' }],
  }, null, 2));
  await new Promise((r) => setTimeout(r, 1100));
  out = await run();
  ok(/feeds\.opml: imported 3 feeds in 1 folders \(merged with config\.json: 2 feeds total\)/.test(out), 'the run logs the OPML merge');
  const idx13 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(fs.existsSync(path.join(SANDBOX, 'data/feeds/cfg-one.json')), 'the config-owned id wins for the shared feed (cfg-one.json exists)');
  ok(fs.existsSync(path.join(SANDBOX, 'data/feeds/custom-two.json')), 'an OPML-only feed joins under its derived id (custom-two.json exists)');
  ok(Object.keys(idx13.feeds).length === 2, `exactly two feeds ship (url dedup dropped the duplicate outline) (${Object.keys(idx13.feeds).length})`);
  ok(idx13.feeds['cfg-one'].title === 'Feed One', 'the OPML title survives when the config names no title');
  ok(idx13.feeds['cfg-one'].folder === 'f-config', 'the config folder wins over the OPML folder for the merged feed');
  ok(idx13.feeds['cfg-one'].site === 'https://opml.example/one', 'the OPML htmlUrl becomes the feed site');
  ok(idx13.feeds['custom-two'].title === 'Custom Two' && idx13.feeds['custom-two'].folder === 'tech', 'an OPML-only feed lands in its nested OPML folder');
  ok(idx13.folders.map((f) => f.id).join(',') === 'tech,f-config', 'both the OPML folder and the config folder ship in the index');
  const cfgOne13 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/cfg-one.json'), 'utf8'));
  ok(cfgOne13.articles.length === 3 && JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/custom-two.json'), 'utf8')).articles.length === 1, 'both merged feeds carry their articles');
  ok(cfgOne13.articles.find((a) => /First post/.test(a.title))?.id === first1.id, 'article ids are unchanged by the OPML merge (read state and deep links survive)');
}
console.log('run 14: full-text extraction — extract once, reuse across runs, respect the feed-is-long-enough skip');
{
  fs.rmSync(path.join(SANDBOX, 'feeds.opml'), { force: true });
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
    settings: { retentionDays: 30, fullTextDefault: true },
    feeds: [{ id: 'ft', url: `http://127.0.0.1:${port}/ftfeed.xml` }],
  }, null, 2));
  await new Promise((r) => setTimeout(r, 1100));
  out = await run();
  ok(/extracted text: FT story 1/.test(out), 'the run logs the one successful extraction');
  const ft = () => JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/ft.json'), 'utf8'));
  ok(ft().articles.length === 4, 'all four items stored');
  const a1 = () => ft().articles.find((a) => a.title === 'FT story 1');
  ok(a1()?.text?.includes('READABILITY_MARKER_PHRASE'), 'the readable page text landed in a.text');
  ok(!a1()?.text?.includes('EVIL_SCRIPT_BODY'), 'script bodies never reach the extracted text');
  ok(ft().articles.find((a) => a.title === 'FT story 2')?.text === null, 'a too-thin page yields no text (the 120-char floor)');
  ok(ft().articles.find((a) => a.title === 'FT story 3')?.text === null, 'a 404 page yields no text (extraction failure is non-fatal)');
  ok(ft().articles.find((a) => a.title === 'FT story 4')?.text === null, 'a feed description over 400 chars skips extraction entirely');
  ok(ft().articles.find((a) => a.title === 'FT story 4')?.content?.includes('X'.repeat(420)), 'the long feed description is still stored as content');
  ok(art1Hits === 1 && art2Hits === 1, 'each page fetched exactly once on the cold run');
  await new Promise((r) => setTimeout(r, 1100));
  out = await run();
  ok(ftFeedHits === 2 && /not modified/.test(out), 'the second run is a conditional 304');
  ok(art1Hits === 1, 'the 304 path re-extracts nothing');
  ok(a1()?.text?.includes('READABILITY_MARKER_PHRASE'), 'the stored text survives the 304 run');
  ftEtag = '"ft2"';
  await new Promise((r) => setTimeout(r, 1100));
  out = await run();
  ok(ftFeedHits === 3 && !/not modified/.test(out), 'the third run re-parses the feed (new etag)');
  ok(art1Hits === 1 && art2Hits === 2, 'an item with stored text is never re-fetched; a textless item retries its page');
  ok(a1()?.text?.includes('READABILITY_MARKER_PHRASE'), 'the reused text is still intact after the re-parse');
}
console.log('id-migration matchers (unit)');
{
  const { pathToFileURL } = await import('node:url');
  const { channelKeyOf, findPrevIdFor } = await import(pathToFileURL(path.join(ROOT, 'scripts/fetch.mjs')).href);
  ok(channelKeyOf('https://www.youtube.com/feeds/videos.xml?channel_id=UCAbC') === 'ucabc', 'channelKeyOf extracts a lowercase channel id');
  ok(channelKeyOf('https://example.com/feed.xml') === null, 'non-YouTube urls have no channel key');
  const fakePrev = {
    'yt-ucabc': { site: 'https://www.youtube.com/channel/UCAbC', xml: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCAbC' },
    'old-xml': { site: '', xml: 'https://example.com/feed.xml' },
    'unrelated': { site: 'https://other.test', xml: 'https://other.test/rss' },
  };
  ok(findPrevIdFor({ url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCAbC' }, fakePrev) === 'yt-ucabc', 'a YouTube feed matches its predecessor via the channel id in the old site URL');
  ok(findPrevIdFor({ url: 'https://example.com/feed.xml' }, fakePrev) === 'old-xml', 'an exact xml match adopts too');
  ok(findPrevIdFor({ url: 'https://nowhere.test/x' }, fakePrev) === null, 'no false adoptions');
  ok(findPrevIdFor({ url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCXYZ' }, fakePrev) === null, 'a different channel never adopts');
}
server2.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);