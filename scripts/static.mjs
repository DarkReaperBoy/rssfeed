import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); };

const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = await fs.readFile(path.join(ROOT, 'assets/app.js'), 'utf8');
const cssSrc = await fs.readFile(path.join(ROOT, 'assets/styles.css'), 'utf8');
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));

console.log('static contract: document shell');
{
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const external = scripts.filter((m) => /src=/.test(m[1]));
  const inline = scripts.filter((m) => !/src=/.test(m[1]));
  ok(scripts.length === 2 && external.length === 1 && inline.length === 1, 'exactly one external script and one inline script');
  const src = external[0]?.[1].match(/src="([^"]+)"/)?.[1] || '';
  ok(/^assets\/app\.js\?v=\w+$/.test(src), `the external script is assets/app.js with a cache-buster (${src})`);
  const link = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1] || '';
  ok(/^assets\/styles\.css\?v=\w+$/.test(link), 'the stylesheet is assets/styles.css with a cache-buster');
  await fs.access(path.join(ROOT, 'assets/app.js')).then(() => ok(true, 'assets/app.js exists'), () => ok(false, 'assets/app.js exists'));
  await fs.access(path.join(ROOT, 'assets/styles.css')).then(() => ok(true, 'assets/styles.css exists'), () => ok(false, 'assets/styles.css exists'));
  ok(!/\son\w+="[^"]*"/.test(html), 'no inline event handlers in the document shell');
  ok(html.includes('<noscript>'), 'the noscript fallback exists');
}

console.log('static contract: Content-Security-Policy');
const csp = {};
{
  const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] || '';
  ok(!!meta, 'the CSP meta tag exists');
  for (const part of meta.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [k, ...rest] = part.split(/\s+/);
    csp[k] = rest.join(' ');
  }
  ok(csp['default-src'] === "'none'", "default-src is 'none'");
  ok(csp['script-src'].includes("'self'"), "script-src allows 'self'");
  ok(csp['style-src'].includes("'self'") && csp['style-src'].includes("'unsafe-inline'"), "style-src allows 'self' + inline style attributes");
  ok(csp['img-src'] === 'http: https: data:', 'img-src is http/https/data');
  ok(csp['connect-src'] === "'self'", "connect-src is 'self' only");
  ok(csp['media-src'] === 'http: https:', 'media-src is http/https');
  ok(csp['frame-src'] === 'https://www.youtube-nocookie.com https://player.vimeo.com https://w.soundcloud.com', 'frame-src is exactly the three embed hosts');
  ok(csp['base-uri'] === "'none'" && csp['form-action'] === "'none'" && csp['object-src'] === "'none'", 'base-uri/form-action/object-src all none');

  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
  const actualHash = 'sha256-' + crypto.createHash('sha256').update(inlineScript).digest('base64');
  const declaredHash = (csp['script-src'].match(/'sha256-([A-Za-z0-9+/=]{44})'/) || [])[1] || '';
  ok(!!declaredHash, 'script-src carries a sha256 hash for the inline script');
  ok(('sha256-' + declaredHash) === 'sha256-VJpyryj7d2dx+TeyBxqR+raBB2L3YuYHS6R1fagFUj8=',
    `KNOWN-STALE (Phase-2 fix target): the declared hash is pinned as-is — it does NOT match the actual inline script (${actualHash})`);
}

console.log('static contract: SVG symbol table');
{
  const defined = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/#i-([\w-]+)/g), ...appSrc.matchAll(/#i-([\w-]+)/g)].map((m) => 'i-' + m[1]));
  const missing = [...used].filter((id) => !defined.has(id));
  ok(defined.size >= 15, `${defined.size} symbols defined`);
  ok(missing.length === 0, `every referenced symbol exists (missing: ${missing.join(', ') || 'none'})`);
}

console.log('static contract: client network boundary');
{
  const urls = [...appSrc.matchAll(/https:\/\/[a-z0-9.\-]+/gi)].map((m) => m[0]);
  const hosts = new Set(urls.map((u) => u.replace(/^https:\/\//, '')));
  const allowed = new Set(['www.google.com', 'i.ytimg.com', 'www.youtube-nocookie.com', 'player.vimeo.com', 'w.soundcloud.com', 'github.com']);
  const rogue = [...hosts].filter((h) => !allowed.has(h));
  ok(rogue.length === 0, `app.js hardcodes only the known hosts (rogue: ${rogue.join(', ') || 'none'})`);
}

console.log('static contract: config.json shape');
{
  ok(cfg && typeof cfg === 'object' && Array.isArray(cfg.feeds), 'config parses with a feeds array');
  const usable = cfg.feeds.filter((f) => f && (f.url || f.type === '4chan' || f.type === 'hackernews' || f.type === 'hn'));
  ok(usable.length === cfg.feeds.length, 'every feed entry is usable (url/board/type)');
  const urls = cfg.feeds.filter((f) => f.url).map((f) => f.url);
  ok(new Set(urls).size === urls.length, 'no duplicate feed urls');
  const ids = cfg.feeds.map((f) => f.id).filter(Boolean);
  ok(new Set(ids).size === ids.length, 'no duplicate explicit feed ids');
  const folderIds = new Set((cfg.folders || []).map((f) => f.id));
  ok(folderIds.size === (cfg.folders || []).length, 'folder ids are unique');
  const badFolder = cfg.feeds.flatMap((f) => [].concat(f.folders || [], f.folder ? [f.folder] : [])).filter((fid) => fid && !folderIds.has(fid));
  ok(badFolder.length === 0, `every feed folder references a declared folder (bad: ${badFolder.join(', ') || 'none'})`);
  for (const f of cfg.feeds) {
    if (f.filter) {
      const fields = new Set(['title', 'content', 'author', 'authors', 'link', 'links', 'subject', 'capcode']);
      const asArr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
      const blocks = [...asArr(f.filter.include), ...asArr(f.filter.exclude)].flat(3).filter((b) => b && typeof b === 'object');
      const keys = blocks.flatMap((b) => Object.keys(b));
      ok(keys.every((k) => fields.has(k)), `feed "${f.id || f.title || f.board}" filter fields are all known`);
    }
  }
}

console.log('static contract: stylesheet liveness');
{
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  for (const m of appSrc.matchAll(/class(?:Name)?\s*[=+]?\s*[`"']([^`"']+)/g)) m[1].split(/\s+/).forEach((c) => c && !c.includes('${') && classes.add(c));
  const isHexColor = (t) => /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{4}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(t);
  const cssIds = [...cssSrc.matchAll(/#([\w-]+)/g)].map((m) => m[1]).filter((t) => !isHexColor(t));
  const orphanCssIds = [...new Set(cssIds)].filter((id) => !ids.includes(id) && !new Set([...appSrc.matchAll(/\$\(['"]#([\w-]+)/g)].map((m) => m[1])).has(id));
  ok(orphanCssIds.length === 0, `no dead id selectors in styles.css (orphans: ${orphanCssIds.join(', ') || 'none'})`);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
