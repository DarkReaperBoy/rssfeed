import crypto from 'node:crypto';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

export function stripChanHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chanThreadsFromCatalog(catalog) {
  const out = [];
  for (const page of Array.isArray(catalog) ? catalog : []) {
    for (const t of page?.threads || []) if (t && t.no) out.push(t);
  }
  return out;
}

export function chanThreadPasses(t, o = {}) {
  if (!t || !t.no) return false;
  if (t.sticky) return false;
  const reps = Number(t.replies) || 0;
  const imgs = Number(t.images) || 0;
  if (o.minReplies > 0 && reps < o.minReplies) return false;
  if (o.maxReplies > 0 && reps > o.maxReplies) return false;
  if (o.minImages > 0 && imgs < o.minImages) return false;
  if (o.maxImages > 0 && imgs > o.maxImages) return false;
  return true;
}

const cdn = (board, tail) => `https://i.4cdn.org/${board}/${tail}`;

export function chanThreadToArticle(t, { board, worksafe = true, now = Date.now() } = {}) {
  const host = worksafe ? 'boards.4channel.org' : 'boards.4chan.org';
  const link = `https://${host}/${board}/thread/${t.no}`;
  const plain = stripChanHtml(t.com || '');
  const firstLine = plain.split('\n').map((s) => s.trim()).filter(Boolean)[0] || `Thread #${t.no}`;
  const title = (t.sub ? stripChanHtml(t.sub) : firstLine).slice(0, 140);
  const name = stripChanHtml(t.name || '');
  const replies = Number(t.replies) || 0;
  const images = Number(t.images) || 0;
  const parts = [];
  if (t.tim && t.ext) {
    parts.push(`<p><a href="${cdn(board, `${t.tim}${t.ext}`)}"><img src="${cdn(board, `${t.tim}s.jpg`)}" alt="OP image"></a></p>`);
  }
  if (t.com) {
    const com = String(t.com)
      .replace(/href="#p(\d+)"/g, `href="${link}#p$1"`)
      .replace(/href="\/([a-z0-9]+)\/thread\/(\d+)(#[^"]*)?"/gi, 'href="https://boards.4chan.org/$1/thread/$2$3"');
    for (const ln of com.split(/<br\s*\/?>/i)) {
      const gt = /^<span class="quote">([\s\S]*?)<\/span>$/.exec(ln.trim());
      if (gt) parts.push(`<blockquote>${gt[1]}</blockquote>`);
      else if (ln.trim()) parts.push(`<p>${ln}</p>`);
    }
  }
  parts.push(`<p>${replies} replies · ${images} images · <a href="${link}">Open the thread</a></p>`);
  const subject = t.sub ? stripChanHtml(t.sub).slice(0, 300) : null;
  return {
    id: sha1(link).slice(0, 16),
    title,
    link,
    author: name && name !== 'Anonymous' ? name.slice(0, 120) : null,
    date: (Number(t.time) || Math.floor(now / 1000)) * 1000,
    summary: plain.slice(0, 300),
    content: parts.join('\n'),
    text: null,
    enclosures: t.tim ? [{ url: cdn(board, `${t.tim}s.jpg`), type: 'image/thumbnail' }] : [],
    fetchedAt: now,
    // Filter plumbing: the real subject (only when the OP set one) and staff capcode
    // travel with the article so subject/capcode-scoped filters stay exact — including
    // when retained data is re-filtered on a 304 or during an outage.
    ...(subject ? { subject } : {}),
    ...(t.capcode ? { capcode: String(t.capcode).slice(0, 32) } : {}),
  };
}
