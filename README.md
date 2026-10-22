# ghrss — Inoreader on GitHub Actions + Pages

A self-hosted RSS reader with **no server and no database**:

- **GitHub Actions** fetches every feed **hourly** (RSS + Atom), extracts clean full text, and publishes the site to the **`gh-pages` branch**
- **GitHub Pages** serves the Inoreader-style UI
- **`config.json`** is the entire configuration: settings, folders, feeds and content filters — plus an optional **`feeds.opml`** export (e.g. Inoreader's) that can provide the feed list, imported server-side by the fetcher
- **Read/unread state** lives in your browser (`localStorage`) — nothing is ever auto-marked read; articles stay unread until you read or mark them. Note: articles older than `settings.retentionDays` are dropped from the data files for everyone — the fetcher can't see read state, so retention applies regardless of unread.

## Setup (3 minutes)

1. **Push this repo to GitHub** (default branch, e.g. `main`):
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. **Enable Pages**: repo → *Settings → Pages* → Source: **Deploy from a branch** → Branch: **`gh-pages`** / `/ (root)` → Save. (The branch appears after the first workflow run.)
3. **Run the workflow once**: *Actions → "Fetch feeds & publish" → Run workflow*. After it finishes, the site is live at `https://<you>.github.io/<repo>/`.
4. **Edit `config.json`** on GitHub (web editor is fine) to add your feeds/folders/filters, or drop an Inoreader OPML export as `feeds.opml`, then run the workflow again (or wait for the hourly cron).

That's it. Every hour the Action re-fetches feeds and force-updates `gh-pages` (which Pages auto-deploys).

## config.json

There is no settings modal and no database: **you configure everything by editing files and pushing**. Preferences without an in-UI toggle are re-read from `config.json` on **every** page load — edit, push, reload. Only your own UI toggles (layout, article-list status, date filter, sort direction, show-filtered, multi-select, folder collapse, sidebar width) are remembered per browser in `localStorage`.

```jsonc
{
  "settings": {
    "siteName": "My Inoreader",    // tab title
    "theme": "auto",               // auto | light | dark
    "view": "list",                // default layout for new visitors: list | expanded | column | cards | magazine
    "retentionDays": 30,           // fetcher prunes everything older (read and unread alike)
    "markReadOnOpen": true,        // opening an article marks it read
    "markReadAfterSeconds": 0,     // …after a delay instead (cancelled if you close it first)
    "refreshMinutes": 60,         // UI polls data/index.json for refreshes
    "fullTextDefault": false,      // extract full article text for every feed (unless feed.fullText overrides)
    "density": "comfort",          // list density: comfort | compact | ultra
    "titlesOnly": false,           // hide row excerpts everywhere
    "openOriginal": false,         // clicking a row opens the original site in a new tab
    "showFavicons": true,          // favicons on rows
    "sideFavicons": true,          // favicons in the sidebar
    "compactSidebar": false,       // icons-only 72px sidebar
    "absoluteDates": false,        // full timestamps instead of "2h"
    "fontSize": "14.5px",          // article title font size
    "columnThumbs": true,          // thumbnails in column view
    "scrollTracking": false,       // mark items read as you scroll past them
    "autoScroll": true,            // reader starts at the top when you open an article
    "updatedOnly": false,          // sidebar shows only feeds with unread items
    "dimRead": false,              // dim sidebar rows with nothing unread
    "sortAZ": false,               // sort the sidebar A–Z
    "countersClickable": true,     // sidebar badge click marks that feed/folder read
    "titleCounter": true,          // "(N) unread" prefix in the tab title
    "showToday": false             // show the Today row in the sidebar
  },
  "folders": [
    { "id": "tech", "name": "Technology" },
    { "id": "quick", "name": "Quick news", "maxAgeDays": 2 }  // folder view only shows last N days
  ],
  "feeds": [
    { "id": "hacker-news", "title": "Hacker News", "url": "https://hnrss.org/frontpage",
      "site": "https://news.ycombinator.com", "folders": ["tech"], "fullText": false, "enabled": true }
    // "folder": "tech" also works for a single folder; "folders" lets a feed sit in several
  ],
  "filters": [ /* see below */ ]
}
```

### Feeds from OPML (optional)

Don't want to hand-write feeds? Export OPML from Inoreader (or any reader), save it as **`feeds.opml`** at the repo root, push. The hourly fetcher imports it server-side — there is no frontend import UI because the frontend never decides what to fetch. Rules:

- a feed is any `<outline>` with an `xmlUrl`; its folder is the enclosing `<outline>` title
- the feed id is a slug of its title (`data/feeds/<id>.json` keys on it, so keep titles stable to keep read state)
- a `config.json` feed entry with the same id (or url) **overrides** the imported fields — set `fullText`, `enabled`, folders there
- config-only feeds are appended; duplicate urls are skipped
- `config.folders` renames/limits OPML folders by id (e.g. add `maxAgeDays`)
- remove `feeds.opml` and you're back to config.json-only feeds

### Filters (inclusion + exclusion, all in JSON)

```jsonc
{
  "id": "hide-crypto",
  "name": "Hide crypto spam",
  "enabled": true,
  "feeds": ["*", "hacker-news", "tech"],   // scope: feed ids and/or folder ids; "*" or omitted = everything
  "include": { "title": ["rust"] },        // optional whitelist: article must match ≥1 entry per given field
  "exclude": { "title": ["crypto", "/\\bbtc\\b/i"], "links": ["coindesk.com"] },
  "actions": {
    "hide": true,        // remove from lists (default true)
    "markRead": false,   // auto-mark matching articles as read (ingest-style)
    "keepUnread": false, // never auto-mark-read, even "open = read"
    "highlight": false   // tint matching rows
  }
}
```

- Plain strings are **case-insensitive substrings**; `/pattern/flags` strings are **regexes**
- Fields: `title`, `content` (body + summary text), `authors`, `links`
- Within a field entries are OR'ed, across fields AND'ed
- No `include`/`exclude` at all → the filter matches **everything in scope** (e.g. `keepUnread` for a newsletter feed)
- Filters are read by the UI on every load — edits apply immediately, no refetch needed

## Features

- Folders + feeds with live unread counts (folder & global totals) — **click a counter to mark that section read** (with Undo)
- **Unread is sacred**: nothing marks an article read except you (open, the tick button, bulk, or a `markRead` filter); `keepUnread` filters beat all of it
- **Single read-state indicator**: the tick button on each row (✓ = read, ○ = unread); the reader title links to the original article
- **No vanishing rows**: an article you just read stays in the Unread view (ticked) until you open another article or change the view
- All/Unread/Read chips, date filters (today / 3 days / week / month), All·Unread·Today·Recently read views, newest/oldest sort
- **All five Inoreader layouts**: List (Comfort/Compact/Ultra density), Expanded, Column, Cards, Magazine — light/dark/auto theme
- Inline reading pane with prev/next, original site link, mark read/unread, "keep unread", attachments list
- **Text view**: feeds with `fullText` get readability-extracted clean article text (vs. truncated feed content)
- **Embeds**: YouTube/Vimeo click-to-play (privacy `youtube-nocookie`), SoundCloud, inline audio/video players
- Search with operators: `feed:bbc title:ai before:2026-01-01 after:2025-12-01 unread:true is:read is:unread`, plus `OR` groups
- Full-text search across titles, authors, summaries and article bodies
- Multiple select (bulk mark read/unread with undo), badge-click mark-read with undo, mark-all with confirm
- **Every preference lives in config.json** (see the settings block above) — re-read on every load; your own UI toggles (layout, status, date, sort, show-filtered, multi-select) persist in localStorage

## Local development

```bash
npm ci          # fetch-script deps only (UI has zero deps)
npm run fetch   # fetch feeds into ./data (also what CI runs)
npm run serve   # http://localhost:8080
npm run test:ui # jsdom smoke test of the UI against local data
```

`data/` and `node_modules/` are git-ignored; CI assembles `index.html + assets/ + config.json + data/` into the `gh-pages` branch. See `AGENTS.md` for architecture details.
