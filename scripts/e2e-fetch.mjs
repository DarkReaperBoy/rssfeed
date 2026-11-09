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
const tgMsg = (channel, m) => `
    <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="${channel}/${m.id}" data-view="x">
      <div class="tgme_widget_message_bubble">
        <div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/${channel}"><span dir="auto">${channel}</span></a></div>
        ${m.inner}
        <div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info short js-message_info"><span class="tgme_widget_message_views">1.2K</span><span class="copyonly"> views</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${channel}/${m.id}"><time datetime="${new Date(now - m.mins * 60000).toISOString()}" class="time">10:00</time></a></span></div></div>
      </div>
    </div></div>`;
const tgText = (t) => `<div class="tgme_widget_message_text js-message_text" dir="auto">${t}</div>`;
const tgPhoto = (u) => `<a class="tgme_widget_message_photo_wrap 1 2" href="#" style="width:653px;background-image:url('${u}')"><div class="tgme_widget_message_photo" style="padding-top:100%"></div></a>`;
const tgVideo = `<a class="tgme_widget_message_video_player js-message_video_player" href="#"><i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/vthumb.jpg')"></i><div class="tgme_widget_message_video_wrap" style="width:100px;padding-top:50%"><video src="https://cdn4.telesco.pe/file/v.mp4?token=expiring" class="tgme_widget_message_video js-message_video" width="100%" height="100%"></video></div><div class="message_video_play js-message_video_play"></div><time class="message_video_duration js-message_video_duration">0:21</time></a>`;
const tgBigVideo = `<a class="tgme_widget_message_video_player not_supported js-message_video_player" href="https://t.me/bigchan/501"><i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/vbigthumb.jpg')"></i><div class="tgme_widget_message_video_wrap" style="width:880px;padding-top:81.81%"></div><div class="message_video_play js-message_video_play"></div><time class="message_video_duration js-message_video_duration">1:05</time><div class="message_media_not_supported_wrap"><div class="message_media_not_supported"><div class="message_media_not_supported_label">Media is too big</div><span class="message_media_view_in_telegram">VIEW IN TELEGRAM</span></div></div></a>`;
const tgLinkPreview = (id) => `<a class="tgme_widget_message_link_preview" href="https://howtogeek.com/sysinternals-linux-arrival"><div class="link_preview_site_name accent_color" dir="auto">How-To Geek</div><i class="link_preview_image" style="background-image:url('https://cdn4.telesco.pe/file/lp.jpg');padding-top:52.375%"></i><div class="link_preview_title" dir="auto">Linux finally gets one of Microsoft's most useful Windows utilities</div><div class="link_preview_description" dir="auto">Sysinternals just went cross-platform.</div></a>`;
const tgGifPlayer = `<a class="tgme_widget_message_video_player blured js-message_video_player" href="#"><i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/gifthumb.jpg')"></i><video src="https://cdn4.telesco.pe/file/gif.mp4?token=looping" class="tgme_widget_message_video blured js-message_video_blured" muted=""></video><div class="tgme_widget_message_video_wrap" style="width:720px;padding-top:133.33333333%"><video src="https://cdn4.telesco.pe/file/gif.mp4?token=looping" class="tgme_widget_message_video js-message_video" width="100%" height="100%"></video></div><div class="message_video_play js-message_video_play"></div><time class="message_video_duration js-message_video_duration">0:01</time></a>`;
const tgMediaMsgs = () => [
  { id: 701, mins: 30, inner: tgGifPlayer },
  { id: 708, mins: 40, inner: tgText('read this: sysinternals on linux') + tgLinkPreview(708) },
  { id: 707, mins: 50, inner: tgLinkPreview(707) },
];
let tgNewMessage = null;
let tgEdited108 = false;
let tgDeepExtra = [];
const tgRequests = {};
const tgChannels = () => {
  const demo = [
    { id: 108, mins: 60, inner: tgText(tgEdited108 ? 'Fresh text post (edited) <b>bold</b>' : 'Fresh text post <b>bold</b>') },
    { id: 104, mins: 2 * 24 * 60, inner: tgPhoto('https://cdn4.telesco.pe/file/one.jpg') + tgPhoto('https://cdn4.telesco.pe/file/two.jpg') + tgText('Album caption') },
    { id: 103, mins: 3 * 24 * 60, inner: tgVideo },
    { id: 102, mins: 4 * 24 * 60, inner: tgText('Plain announcement') },
    { id: 101, mins: 5 * 24 * 60, inner: tgPhoto('https://cdn4.telesco.pe/file/solo.jpg') },
    { id: 99, mins: 35 * 24 * 60, inner: tgPhoto('https://cdn4.telesco.pe/file/ancient.jpg') },
  ];
  if (tgNewMessage) demo.unshift(tgNewMessage);
  return {
    demochan: { title: 'Demo Channel', messages: demo },
    burstchan: {
      title: 'Burst Feed',
      messages: Array.from({ length: 12 }, (_, i) => ({ id: 212 - i, mins: 30 + i * 55, inner: tgText(`Burst message ${212 - i}`) })),
    },
    deepchan: {
      title: 'Deep Channel',
      messages: [...tgDeepExtra, ...Array.from({ length: 9 }, (_, i) => ({ id: 309 - i, mins: 40 + i * 90, inner: tgText(`Deep message ${309 - i}`) }))],
    },
    bigchan: {
      title: 'Big Media Channel',
      messages: [{ id: 501, mins: 90, inner: tgBigVideo }],
    },
    mediachan: {
      title: 'Media Zoo Channel',
      messages: tgMediaMsgs(),
    },
  };
};
const tgRoutes = (req, res) => {
  const u = new URL(req.url, 'http://t.me');
  const m = /^\/s\/([A-Za-z0-9_]+)$/.exec(u.pathname);
  if (!m) return false;
  const channel = m[1];
  const chan = tgChannels()[channel];
  tgRequests[channel] = (tgRequests[channel] || 0) + 1;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (!chan) {
    res.end(`<!DOCTYPE html><html><head><title>Telegram Messenger</title></head><body><div class="tgme_page_wrap"><div class="tgme_page"><a href="https://t.me/">If you have Telegram, you can contact @${channel} right away.</a></div></div></body></html>`);
    return true;
  }
  const before = Number(u.searchParams.get('before') || 0);
  const filtered = chan.messages.filter((x) => !before || x.id < before).sort((a, b) => b.id - a.id);
  const PAGE = 3;
  const pageMsgs = filtered.slice(0, PAGE);
  const moreBefore = filtered.length > PAGE ? pageMsgs[pageMsgs.length - 1].id : null;
  const body = pageMsgs.slice().reverse().map((x) => tgMsg(channel, x)).join('');
  res.end(`<!DOCTYPE html><html><head><meta property="og:title" content="${chan.title}"><meta property="og:image" content="https://cdn4.telesco.pe/file/${channel}-avatar.jpg"></head><body><div class="tgme_container"><section class="tgme_channel_history js-message_history">${moreBefore ? `<div class="tgme_widget_message_centered js-messages_more_wrap"><a href="/s/${channel}?before=${moreBefore}" class="tme_messages_more js-messages_more" data-before="${moreBefore}"></a></div>` : ''}${body}</section></div></body></html>`);
  return true;
};
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
  else if (tgRoutes(req, res)) { /* served */ }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, 'scripts'), { recursive: true });
for (const f of ['fetch.mjs', '4chan.mjs', 'hackernews.mjs', 'telegram.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(SANDBOX, 'scripts', f));
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
  else if (tgRoutes(req, res)) { /* served */ }
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
console.log('run 15: telegram channels — every message is an article, images ride along, bursts paginate');
{
  const TG = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
    settings: { retentionDays: 30, fullTextDefault: false },
    feeds: [
      { id: 'tgdemo', title: 'Demo Telegram', url: 'https://t.me/demochan' },
      { id: 'tgburst', url: 'https://t.me/burstchan' },
      { id: 'tgdeep', url: 'https://t.me/deepchan', maxPages: 2 },
      { id: 'tgbig', url: 'https://t.me/bigchan' },
      { id: 'tgmissing', url: 'https://t.me/missingchan' },
    ],
  }, null, 2));
  await new Promise((r) => setTimeout(r, 1100));
  out = await run({ GHRSS_TG_BASE: TG });
  const tgFeed = (id) => JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds', `${id}.json`), 'utf8'));
  const demo15 = tgFeed('tgdemo').articles;
  ok(demo15.length === 5, `five demochan messages stored — the 35-day-old one is outside the 30-day window (${demo15.length})`);
  ok(demo15.every((a) => /^https:\/\/t\.me\/s\/demochan\/\d+$/.test(a.link)), 'every article links to its t.me web-preview message');
  const byLink = (n) => demo15.find((a) => a.link === `https://t.me/s/demochan/${n}`);
  const a104 = byLink(104);
  ok(!!a104 && a104.title === 'Album caption', 'the album caption is the title');
  ok(a104?.enclosures.length === 2 && a104.enclosures[0].type === 'image/thumbnail' && a104.enclosures[1].type === 'image/jpeg', 'album photos land in enclosures: first is the row thumbnail, the rest are attachments');
  ok(a104?.content.includes('https://cdn4.telesco.pe/file/one.jpg') && a104?.content.includes('https://cdn4.telesco.pe/file/two.jpg'), 'album photos are embedded in the article body');
  const a103 = byLink(103);
  ok(a103?.title === 'Video (0:21)' && a103.enclosures[0].type === 'image/thumbnail', 'video messages carry the poster thumbnail and a duration title');
  ok(/<video controls preload="metadata" poster="https:\/\/cdn4\.telesco\.pe\/file\/vthumb\.jpg" src="https:\/\/cdn4\.telesco\.pe\/file\/v\.mp4\?token=expiring"><\/video>/.test(a103?.content || ''), 'videos embed natively in the browser player: controls, metadata preload, poster, and the tokened src all survive the sanitizer');
  ok(a103 && /View on Telegram/.test(a103.content), 'the body still links to the post when the token expires');
  ok(byLink(102)?.title === 'Plain announcement', 'text message titles come from the first line');
  ok(byLink(101)?.title === 'Photo', 'a captionless photo still titles itself');
  const a108 = byLink(108);
  ok(a108?.content.includes('<b>bold</b>') && a108?.title === 'Fresh text post bold', 'markup survives into the body, the title is the flattened first line');
  ok(demo15.every((a) => a.content.includes('View on Telegram')), 'every message body links back to the post');
  const burst15 = tgFeed('tgburst').articles;
  ok(burst15.length === 12, `all 12 burst messages captured across 3-message pages (${burst15.length})`);
  ok(new Set(burst15.map((a) => a.link)).size === 12, 'each burst message is a distinct article');
  ok(burst15[0].link === 'https://t.me/s/burstchan/212' && burst15[11].link === 'https://t.me/s/burstchan/201', 'articles are ordered newest first');
  const deep15 = tgFeed('tgdeep').articles;
  ok(deep15.length === 9 && new Set(deep15.map((a) => a.link)).size === 9, `maxPages=2 stops the fresh walk after 6 of 9, then the same-run gap walk heals the other 3 (${deep15.length} stored, unique)`);
  ok(deep15.some((a) => a.link === 'https://t.me/s/deepchan/301'), 'message 301 — beyond the page budget — is stored in the very run that first saw the channel');
  ok(/page budget/.test(out) && /healed 3 message\(s\) from tracked gap\(s\)/.test(out), 'the run log names the budget stop and the same-run gap heal');
  ok(tgRequests.deepchan === 3, `the cold crawl = fresh walk (2 pages) + gap walk (1 page) (${tgRequests.deepchan} requests)`);
  const big15 = tgFeed('tgbig').articles;
  ok(big15.length === 1 && big15[0].title === 'Video (1:05)', `a too-big video (player without a <video> tag) still titles itself with the duration (${big15[0]?.title})`);
  ok(big15[0].enclosures.length === 1 && big15[0].enclosures[0].url === 'https://cdn4.telesco.pe/file/vbigthumb.jpg' && big15[0].enclosures[0].type === 'image/thumbnail', 'the too-big video poster is carried as the row thumbnail');
  ok(big15[0].content.includes('vbigthumb.jpg') && big15[0].content.includes('View on Telegram'), 'the too-big video poster is embedded in the body next to the post link');
  const miss15 = tgFeed('tgmissing').articles;
  ok(miss15.length === 0, 'a channel with no public preview stores nothing');
  const idx15 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(idx15.feeds.tgdemo.status.ok === true, 'the demo channel crawl is healthy');
  ok(idx15.feeds.tgdemo.title === 'Demo Telegram' && idx15.feeds.tgdemo.origTitle === 'Demo Channel', 'a config rename keeps the channel self-title as origTitle');
  ok(idx15.feeds.tgdemo.site === 'https://t.me/s/demochan' && idx15.feeds.tgdemo.image === 'https://cdn4.telesco.pe/file/demochan-avatar.jpg', 'site and avatar come from the channel page (site points at the web preview)');
  ok(idx15.feeds.tgburst.title === 'Burst Feed' && idx15.feeds.tgburst.origTitle === null, 'an untitled feed derives its title from the channel');
  ok(idx15.feeds.tgmissing.status.ok === false && /no public posts/.test(idx15.feeds.tgmissing.status.error || ''), 'a missing/private channel reports NO_POSTS in the crawl status');
  ok(idx15.feeds.tgdeep.status.tgBacklog === false, 'the cold-start gap healed in the same run — no backlog flag remains');
  ok(!idx15.feeds.tgdeep.status.tgGaps, 'no unfetched gap intervals persist once the gap walk reaches the start of history');
  const all15tg = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/all-feeds.json'), 'utf8'));
  ok(all15tg.articles.length === 5 + 12 + 9 + 1, `all-feeds.json carries every telegram article (${all15tg.articles.length})`);
  const demoBefore = Object.fromEntries(demo15.map((a) => [a.link, a.id]));

  console.log('run 16: telegram incremental — new + edited messages, overlap stop, failure keeps retained');
  tgNewMessage = { id: 109, mins: 5, inner: tgText('Brand new post') };
  tgEdited108 = true;
  await new Promise((r) => setTimeout(r, 1100));
  const reqBefore = { ...tgRequests };
  out = await run({ GHRSS_TG_BASE: TG });
  const demo16 = tgFeed('tgdemo').articles;
  ok(demo16.length === 6, `the new message landed, everything retained (${demo16.length})`);
  const a109 = demo16.find((a) => a.link === 'https://t.me/s/demochan/109');
  ok(a109?.title === 'Brand new post', 'message 109 is present');
  const a108e = demo16.find((a) => a.link === 'https://t.me/s/demochan/108');
  ok(a108e?.title === 'Fresh text post (edited) bold' && a108e?.id === demoBefore['https://t.me/s/demochan/108'], 'an author edit (re-scraped while still on the newest page) updates the title but NEVER the article id — read state survives');
  ok(demo16.find((a) => a.link === 'https://t.me/s/demochan/102')?.title === 'Plain announcement', 'older messages beyond the first page keep their stored form (same as any RSS feed)');
  ok(demo16.filter((a) => demoBefore[a.link]).every((a) => a.id === demoBefore[a.link]), 'every previously-stored message kept its id across runs');
  ok(tgRequests.demochan === reqBefore.demochan + 1, `the second run walked exactly one page (overlap stop: ${tgRequests.demochan - reqBefore.demochan} request)`);
  ok(tgRequests.burstchan === reqBefore.burstchan + 1, `an unchanged channel also stops after one page (${tgRequests.burstchan - reqBefore.burstchan} request)`);
  const deep16 = tgFeed('tgdeep').articles;
  ok(deep16.length === 9, `the fully-caught-up channel retains all 9 messages across runs (${deep16.length})`);
  ok(new Set(deep16.map((a) => a.link)).size === 9, 'each deepchan message is stored exactly once (no duplicates across runs)');
  ok(deep16.some((a) => a.link === 'https://t.me/s/deepchan/301'), 'the oldest message 301 — beyond the original page budget — is present after healing');
  ok(tgRequests.deepchan === reqBefore.deepchan + 1, `a caught-up channel costs exactly one page per run (overlap stop: ${tgRequests.deepchan - reqBefore.deepchan} request)`);
  const idxDeep = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(idxDeep.feeds.tgdeep.status.tgBacklog === false, 'the backlog flag stays clear while the walk keeps up');

  await new Promise((r) => setTimeout(r, 1100));
  out = await run({ GHRSS_TG_BASE: 'http://127.0.0.1:9' });
  ok(/FETCH FAILED/.test(out), 'the network died (connection refused)');
  const demoFail = tgFeed('tgdemo').articles;
  ok(demoFail.length === 6 && demoFail.some((a) => a.link === 'https://t.me/s/demochan/109'), 'the failure path keeps every retained message');
  const deepFail = tgFeed('tgdeep').articles;
  ok(deepFail.length === 9, 'a failed run keeps the healed deepchan history too');
  const idxFail = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(idxFail.feeds.tgdemo.status.ok === false && (idxFail.feeds.tgdemo.status.consecutiveFailures || 0) >= 1, 'the crawl status records the failure');

  console.log('run 17: telegram flood — a burst past the budget leaves no hole the same run');
  tgDeepExtra = Array.from({ length: 9 }, (_, i) => ({ id: 318 - i, mins: 3 + i, inner: tgText(`Flood message ${318 - i}`) }));
  await new Promise((r) => setTimeout(r, 1100));
  const req17 = { ...tgRequests };
  out = await run({ GHRSS_TG_BASE: TG });
  const idsOf = (arts) => arts.map((a) => Number(/(\d+)$/.exec(a.link)[1]));
  const deep17 = tgFeed('tgdeep').articles;
  const ids17 = idsOf(deep17);
  ok(deep17.length === 18 && new Set(deep17.map((a) => a.link)).size === 18, `an 18-message channel fully stores in one run despite maxPages=2 (${deep17.length})`);
  ok([310, 311, 312].every((n) => ids17.includes(n)), 'the hole between the budget stop (#313) and the old watermark (#309) is filled the same run');
  ok(tgRequests.deepchan === req17.deepchan + 4, `fresh walk (2 pages) + gap walk (2 pages) (${tgRequests.deepchan - req17.deepchan} requests)`);
  const idx17 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(idx17.feeds.tgdeep.status.tgBacklog === false && !idx17.feeds.tgdeep.status.tgGaps, 'the burst left no tracked gap behind');

  console.log('run 18: sustained overflow — what exceeds the budget persists as a tracked gap');
  tgDeepExtra = [...Array.from({ length: 18 }, (_, i) => ({ id: 336 - i, mins: 2 + i, inner: tgText(`Flood two ${336 - i}`) })), ...tgDeepExtra];
  await new Promise((r) => setTimeout(r, 1100));
  const req18 = { ...tgRequests };
  out = await run({ GHRSS_TG_BASE: TG });
  const deep18 = tgFeed('tgdeep').articles;
  const ids18 = idsOf(deep18);
  ok(deep18.length === 30, `2×maxPages stores 30 of 36 messages in one run (${deep18.length})`);
  ok(ids18.every((n) => !(n >= 319 && n <= 324)), 'messages 319–324 are the honest known-missing hole — nothing silently dropped');
  ok([325, 336].every((n) => ids18.includes(n)), 'the two walks reached down to #325 and up to #336');
  const idx18 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  const gaps18 = idx18.feeds.tgdeep.status.tgGaps || [];
  ok(gaps18.length === 1 && gaps18[0].floor === 318 && gaps18[0].ceil === 325, `the unfetched hole is persisted as a gap interval {floor:318, ceil:325} (${JSON.stringify(gaps18)})`);
  ok(idx18.feeds.tgdeep.status.tgBacklog === true, 'a remaining gap keeps the backlog flag raised');
  ok(/raise "maxPages" \(now 2\)/.test(out), 'the log tells the operator the page budget is the limit');
  ok(tgRequests.deepchan === req18.deepchan + 4, `fresh (2) + gap chew (2) pages (${tgRequests.deepchan - req18.deepchan} requests)`);

  console.log('run 19: the persisted gap heals on the next run');
  await new Promise((r) => setTimeout(r, 1100));
  const req19 = { ...tgRequests };
  out = await run({ GHRSS_TG_BASE: TG });
  const deep19 = tgFeed('tgdeep').articles;
  const ids19 = idsOf(deep19);
  ok(deep19.length === 36 && new Set(deep19.map((a) => a.link)).size === 36, `all 36 messages stored after the gap heals (${deep19.length})`);
  ok([319, 320, 321, 322, 323, 324].every((n) => ids19.includes(n)), 'the hole 319–324 is closed');
  const idx19 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(!idx19.feeds.tgdeep.status.tgGaps && idx19.feeds.tgdeep.status.tgBacklog === false, 'the gap list empties and the flag clears');
  ok(tgRequests.deepchan === req19.deepchan + 3, `fresh (1, overlap stop) + gap chew (2) (${tgRequests.deepchan - req19.deepchan} requests)`);

  console.log('run 20: a bigger flood re-opens a gap, then the network dies with the gap in flight');
  tgDeepExtra = [...Array.from({ length: 15 }, (_, i) => ({ id: 351 - i, mins: 2 + i, inner: tgText(`Flood three ${351 - i}`) })), ...tgDeepExtra];
  await new Promise((r) => setTimeout(r, 1100));
  out = await run({ GHRSS_TG_BASE: TG });
  const idx20 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  const gaps20 = idx20.feeds.tgdeep.status.tgGaps || [];
  ok(gaps20.length === 1 && gaps20[0].floor === 336 && gaps20[0].ceil === 340, `the 15-message flood leaves gap {floor:336, ceil:340} (${JSON.stringify(gaps20)})`);
  ok(idx20.feeds.tgdeep.status.tgBacklog === true, 'flag raised mid-overflow');

  await new Promise((r) => setTimeout(r, 1100));
  out = await run({ GHRSS_TG_BASE: 'http://127.0.0.1:9' });
  ok(/FETCH FAILED/.test(out), 'the network died again (connection refused)');
  const idxFail2 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  const gapsFail = idxFail2.feeds.tgdeep.status.tgGaps || [];
  ok(gapsFail.length === 1 && gapsFail[0].floor === 336 && gapsFail[0].ceil === 340, `a failed run keeps the in-flight gap so healing resumes after recovery (${JSON.stringify(gapsFail)})`);
  ok(idxFail2.feeds.tgdeep.status.tgBacklog === true, 'the backlog flag survives the failure');

  console.log('run 21: recovery — the surviving gap closes');
  await new Promise((r) => setTimeout(r, 1100));
  out = await run({ GHRSS_TG_BASE: TG });
  const deep21 = tgFeed('tgdeep').articles;
  const ids21 = idsOf(deep21);
  ok(deep21.length === 51 && [337, 338, 339].every((n) => ids21.includes(n)), `all 51 messages stored, the in-flight gap 337–339 closed (${deep21.length})`);
  const idx21 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/index.json'), 'utf8'));
  ok(!idx21.feeds.tgdeep.status.tgGaps && idx21.feeds.tgdeep.status.tgBacklog === false, 'gap list empty, flag clear after recovery');

  console.log('run 22: a legacy tgBacklog flag migrates into the gap list');
  const idxPath = path.join(SANDBOX, 'data/index.json');
  const idxLegacy = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  idxLegacy.feeds.tgdeep.status.tgBacklog = true;
  delete idxLegacy.feeds.tgdeep.status.tgGaps;
  fs.writeFileSync(idxPath, JSON.stringify(idxLegacy));
  await new Promise((r) => setTimeout(r, 1100));
  const req22 = { ...tgRequests };
  out = await run({ GHRSS_TG_BASE: TG });
  const idx22 = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  ok(idx22.feeds.tgdeep.status.tgBacklog === false && !idx22.feeds.tgdeep.status.tgGaps, 'a legacy flag heals as a gap below the oldest stored message and clears');
  ok(tgRequests.deepchan === req22.deepchan + 2, `fresh walk (1) + migrated-gap probe (1) (${tgRequests.deepchan - req22.deepchan} requests)`);

  tgNewMessage = null;
  tgEdited108 = false;
  tgDeepExtra = [];
}
console.log('run 23: telegram link previews — the real link_preview markup rides along');
{
  const TG = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(SANDBOX, 'config.json'), JSON.stringify({
    settings: { retentionDays: 60, fullTextDefault: false },
    feeds: [
      { id: 'tgmedia', url: 'https://t.me/mediachan' },
    ],
  }, null, 2));
  await new Promise((r) => setTimeout(r, 1100));
  out = await run({ GHRSS_TG_BASE: TG });
  const media23 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'data/feeds/tgmedia.json'), 'utf8')).articles;
  ok(media23.length === 3, `every media-zoo message stored (${media23.length})`);
  const a701 = media23.find((a) => a.link === 'https://t.me/s/mediachan/701');
  ok(a701?.title === 'GIF', `a gif-only message titles itself GIF (${a701?.title})`);
  ok((a701?.content.match(/<video/g) || []).length === 1, `a GIF's blurred backdrop layer never double-embeds the video (${(a701?.content.match(/<video/g) || []).length} tag(s))`);
  ok(/<video autoplay loop muted playsinline preload="metadata" poster="https:\/\/cdn4\.telesco\.pe\/file\/gifthumb\.jpg" src="https:\/\/cdn4\.telesco\.pe\/file\/gif\.mp4\?token=looping"><\/video>/.test(a701?.content || ''), 'gifs embed as a silent autoplaying loop with poster and src');
  ok(a701?.enclosures.length === 1 && a701.enclosures[0].url === 'https://cdn4.telesco.pe/file/gifthumb.jpg' && a701.enclosures[0].type === 'image/thumbnail', 'the gif poster rides along as the row thumbnail');
  const a707 = media23.find((a) => a.link === 'https://t.me/s/mediachan/707');
  ok(a707?.title === "Linux finally gets one of Microsoft's most useful Windows utilities", `a preview-only message titles itself from the preview (${a707?.title})`);
  ok(/<a href="https:\/\/howtogeek\.com\/sysinternals-linux-arrival"/.test(a707?.content || ''), 'the preview is a clickable block to the shared page');
  ok(a707?.content.includes('Sysinternals just went cross-platform.'), 'the preview description lands in the body');
  ok(a707?.content.includes('https://cdn4.telesco.pe/file/lp.jpg'), 'the preview image embeds in the body');
  ok(/View on Telegram/.test(a707?.content || ''), 'the post link still closes the body');
  const a708 = media23.find((a) => a.link === 'https://t.me/s/mediachan/708');
  ok(a708?.title === 'read this: sysinternals on linux', 'text over a preview titles from the first line');
  ok(a708?.content.includes('How-To Geek'), 'a text-plus-preview message carries the site attribution too');
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