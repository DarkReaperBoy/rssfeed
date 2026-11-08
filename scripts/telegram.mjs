import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

export const TG_DEFAULT_MAX_PAGES = 12;
const TG_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);
const TG_RESERVED = new Set(['joinchat', 'addstickers', 'share', 'proxy', 'socks', 'bg', 'invoice', 'login', 'contact', 'verify', 'iv']);
const TG_CHANNEL_RE = /^[A-Za-z0-9_]{3,64}$/;

export function stripTgHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|blockquote|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function tgChannelFromUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!TG_HOSTS.has(host)) return null;
    let seg = u.pathname.replace(/^\/+/, '').split('/')[0] || '';
    if (/^s$/i.test(seg)) seg = u.pathname.replace(/^\/+/, '').split('/')[1] || '';
    seg = seg.replace(/^@/, '');
    if (!seg || TG_RESERVED.has(seg.toLowerCase()) || !TG_CHANNEL_RE.test(seg)) return null;
    return seg;
  } catch {
    return null;
  }
}

export function tgChannelOf(feed) {
  const direct = String(feed?.channel || '').replace(/^@/, '');
  if (TG_CHANNEL_RE.test(direct)) return direct;
  return tgChannelFromUrl(feed?.url);
}

export function isTelegramFeed(f) {
  if (f?.type === 'telegram' || f?.type === 'tg') return true;
  return !!tgChannelFromUrl(f?.url);
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const bgUrl = (style) => {
  const m = /url\(\s*['"]?\s*(\/\/[^\s'")]+|https?:\/\/[^\s'")]+)/.exec(String(style || ''));
  if (!m) return null;
  const u = m[1];
  return u.startsWith('//') ? `https:${u}` : u;
};
const absUrl = (u) => {
  if (typeof u !== 'string' || !u.trim()) return null;
  const s = u.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  return null;
};

export function tgParsePage(html) {
  const dom = new JSDOM(String(html || ''), { url: 'https://t.me/', runScripts: 'outside-only' });
  try {
    const doc = dom.window.document;
    const meta = (prop) => (doc.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') || '').trim();
    const page = {
      title: stripTgHtml(meta('og:title')).slice(0, 300),
      description: stripTgHtml(meta('og:description')).slice(0, 600),
      image: absUrl(meta('og:image')) || '',
      moreBefore: null,
      messages: [],
    };
    const more = doc.querySelector('.tme_messages_more[data-before]');
    if (more) {
      const b = Number(more.getAttribute('data-before'));
      if (Number.isFinite(b) && b > 0) page.moreBefore = b;
    }
    for (const el of doc.querySelectorAll('.tgme_widget_message[data-post]')) {
      const post = el.getAttribute('data-post') || '';
      const slash = post.lastIndexOf('/');
      const id = Number(post.slice(slash + 1));
      const channel = post.slice(0, slash);
      if (!Number.isFinite(id) || id <= 0 || !channel) continue;
      const dt = el.querySelector('.tgme_widget_message_date time[datetime]')?.getAttribute('datetime') || '';
      const parsedDate = dt ? Date.parse(dt) : NaN;
      const msg = {
        id,
        channel,
        date: Number.isNaN(parsedDate) ? null : parsedDate,
        textHtml: el.querySelector('.tgme_widget_message_text')?.innerHTML.trim() || '',
        photos: [],
        videos: [],
        webpage: null,
        forwarded: stripTgHtml(el.querySelector('.tgme_widget_message_forwarded_from')?.textContent || '').slice(0, 200),
        signature: stripTgHtml(el.querySelector('.tgme_widget_message_signature')?.textContent || '').slice(0, 120),
        pollText: '',
        link: `https://t.me/${channel}/${id}`,
      };
      for (const w of el.querySelectorAll('.tgme_widget_message_photo_wrap')) {
        const u = absUrl(bgUrl(w.getAttribute('style')));
        if (u) msg.photos.push(u);
      }
      for (const v of el.querySelectorAll('.tgme_widget_message_video')) {
        const wrap = v.closest('.tgme_widget_message_video_player') || el;
        const thumb = absUrl(bgUrl(wrap.querySelector('.tgme_widget_message_video_thumb')?.getAttribute('style')));
        const src = absUrl(v.getAttribute('src'));
        if (thumb || src) {
          msg.videos.push({
            thumb,
            src,
            duration: stripTgHtml(wrap.querySelector('.message_video_duration')?.textContent || '').slice(0, 12),
          });
        }
      }
      for (const player of el.querySelectorAll('.tgme_widget_message_video_player')) {
        if (player.querySelector('.tgme_widget_message_video')) continue;
        const thumb = absUrl(bgUrl(player.querySelector('.tgme_widget_message_video_thumb')?.getAttribute('style')));
        const duration = stripTgHtml(player.querySelector('.message_video_duration')?.textContent || '').slice(0, 12);
        if (thumb || duration) msg.videos.push({ thumb, src: null, duration });
      }
      const wp = el.querySelector('.tgme_widget_message_webpage');
      if (wp) {
        const a = wp.closest('a') || wp.querySelector('a');
        msg.webpage = {
          href: absUrl(a?.getAttribute('href')) || '',
          site: stripTgHtml(wp.querySelector('.tgme_widget_message_webpage_site')?.textContent || '').slice(0, 200),
          title: stripTgHtml(wp.querySelector('.tgme_widget_message_webpage_title')?.textContent || '').slice(0, 300),
          description: stripTgHtml(wp.querySelector('.tgme_widget_message_webpage_description')?.textContent || '').slice(0, 500),
          photo: absUrl(bgUrl(wp.querySelector('[style*="background-image"]')?.getAttribute('style'))),
        };
        if (!(msg.webpage.href || msg.webpage.title || msg.webpage.description || msg.webpage.photo)) msg.webpage = null;
      }
      const poll = el.querySelector('.tgme_widget_message_poll');
      if (poll) msg.pollText = stripTgHtml(poll.textContent).slice(0, 1000);
      page.messages.push(msg);
    }
    return page;
  } finally {
    dom.window.close();
  }
}

export function tgArticleId(msg) {
  return sha1(`tg|${msg.channel}/${msg.id}`).slice(0, 16);
}

export function tgMessageToArticle(msg, { now = Date.now(), prevDate } = {}) {
  const plain = stripTgHtml(msg.textHtml);
  const firstLine = plain.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  let title = firstLine.slice(0, 140);
  if (!title) {
    if (msg.photos.length > 1) title = `Photo album (${msg.photos.length})`;
    else if (msg.photos.length) title = 'Photo';
    else if (msg.videos.length) title = msg.videos[0].duration ? `Video (${msg.videos[0].duration})` : 'Video';
    else if (msg.webpage?.title) title = msg.webpage.title.slice(0, 140);
    else if (msg.pollText) title = msg.pollText.split('\n')[0].slice(0, 140);
    else title = `Message #${msg.id}`;
  }
  const parts = [];
  if (msg.forwarded) parts.push(`<p><em>${esc(msg.forwarded)}</em></p>`);
  for (const p of msg.photos) {
    parts.push(`<p><a href="${esc(msg.link)}"><img src="${esc(p)}" alt=""></a></p>`);
  }
  for (const v of msg.videos) {
    if (v.thumb) {
      const alt = v.duration ? `video, ${v.duration}` : 'video';
      parts.push(`<p><a href="${esc(msg.link)}"><img src="${esc(v.thumb)}" alt="${esc(alt)}"></a></p>`);
    } else {
      const label = v.duration ? `Video (${v.duration})` : 'Video';
      parts.push(`<p><a href="${esc(msg.link)}">${esc(label)}</a></p>`);
    }
  }
  if (msg.textHtml) {
    for (const p of msg.textHtml.split(/<br\s*\/?>\s*<br\s*\/?>/i)) {
      if (p.trim()) parts.push(`<p>${p.trim()}</p>`);
    }
  }
  if (msg.pollText) parts.push(`<p>${esc(msg.pollText).replace(/\n/g, '<br>')}</p>`);
  if (msg.webpage) {
    const wp = msg.webpage;
    const head = wp.title || wp.site;
    if (wp.href) parts.push(`<p><a href="${esc(wp.href)}">${esc(head || wp.href)}</a>${wp.site && wp.title && wp.site !== wp.title ? ` — ${esc(wp.site)}` : ''}</p>`);
    if (wp.description) parts.push(`<p>${esc(wp.description)}</p>`);
    if (wp.photo) parts.push(`<p><a href="${esc(wp.href || msg.link)}"><img src="${esc(wp.photo)}" alt=""></a></p>`);
  }
  parts.push(`<p><a href="${esc(msg.link)}">View on Telegram</a></p>`);
  const media = [
    ...msg.photos.map((u) => ({ url: u, type: 'image/jpeg' })),
    ...msg.videos.filter((v) => v.thumb).map((v) => ({ url: v.thumb, type: 'image/jpeg' })),
  ];
  if (media.length) media[0] = { ...media[0], type: 'image/thumbnail' };
  return {
    id: tgArticleId(msg),
    title,
    link: msg.link,
    author: msg.signature || null,
    date: msg.date ?? prevDate ?? now,
    summary: (plain || title).slice(0, 300),
    content: parts.join('\n'),
    text: null,
    enclosures: media,
    fetchedAt: now,
  };
}

export async function tgFetchChannel(doFetch, channel, { cutoffMs = 0, knownMaxId = 0, maxPages = TG_DEFAULT_MAX_PAGES, base = null, maxBytes = 3_000_000 } = {}) {
  const root = String(base || process.env.GHRSS_TG_BASE || 'https://t.me').replace(/\/+$/, '');
  const cap = Number(maxPages) > 0 ? Math.floor(Number(maxPages)) : TG_DEFAULT_MAX_PAGES;
  const messages = new Map();
  let pages = 0;
  let stopReason = 'page budget';
  let info = null;
  let before = 0;
  while (pages < cap) {
    const url = `${root}/s/${encodeURIComponent(channel)}${before ? `?before=${before}` : ''}`;
    let res;
    try {
      res = await doFetch(url);
    } catch (err) {
      if (pages === 0) throw err;
      stopReason = `network error after ${pages} page(s): ${err.message}`;
      break;
    }
    if (!res.ok) {
      if (pages === 0) {
        const e = new Error(`HTTP ${res.status}`);
        e.code = 'HTTP';
        throw e;
      }
      stopReason = `HTTP ${res.status} after ${pages} page(s)`;
      break;
    }
    let html = await res.text();
    if (typeof html !== 'string' || !html) {
      if (pages === 0) throw new Error('empty response');
      stopReason = `empty response after ${pages} page(s)`;
      break;
    }
    if (html.length > maxBytes) html = html.slice(0, maxBytes);
    let page;
    try {
      page = tgParsePage(html);
    } catch (err) {
      if (pages === 0) throw new Error(`parse error: ${err.message}`);
      stopReason = `parse error after ${pages} page(s): ${err.message}`;
      break;
    }
    if (!page.messages.length) {
      if (pages === 0) {
        const e = new Error('no public posts (channel missing, private, or preview disabled)');
        e.code = 'NO_POSTS';
        throw e;
      }
      stopReason = 'start of history';
      break;
    }
    pages++;
    if (!info) info = { title: page.title, description: page.description, image: page.image };
    for (const m of page.messages) messages.set(m.id, m);
    let oldest = page.messages[0];
    for (const m of page.messages) if (m.id < oldest.id) oldest = m;
    if (!page.moreBefore) {
      stopReason = 'start of history';
      break;
    }
    if (before && page.moreBefore >= before) {
      stopReason = 'pagination stalled';
      break;
    }
    if (knownMaxId > 0 && oldest.id <= knownMaxId) {
      stopReason = 'caught up with stored messages';
      break;
    }
    if (cutoffMs > 0 && oldest.date && oldest.date < cutoffMs) {
      stopReason = 'retention window covered';
      break;
    }
    before = page.moreBefore;
  }
  return {
    messages: [...messages.values()].sort((a, b) => a.id - b.id),
    pages,
    stopReason,
    info: info || { title: '', description: '', image: '' },
  };
}
