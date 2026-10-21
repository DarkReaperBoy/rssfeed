# ghrss — Inoreader on GitHub Actions + Pages

A self-hosted RSS reader with **no server and no database**:

- **GitHub Actions** fetches every feed **hourly** (RSS + Atom), extracts clean full text, and publishes the site to the **`gh-pages` branch**
- **GitHub Pages** serves the Inoreader-style UI
- **`config.json`** is the entire configuration: settings, folders, feeds and content filters
- **Read/unread state** lives in your browser (`localStorage`) — unread articles are never auto-pruned; they stay unread until you read or mark them

## Setup (3 minutes)

1. **Push this repo to GitHub** (default branch, e.g. `main`):
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. **Enable Pages**: repo → *Settings → Pages* → Source: **Deploy from a branch** → Branch: **`gh-pages`** / `/ (root)` → Save. (The branch appears after the first workflow run.)
3. **Run the workflow once**: *Actions → "Fetch feeds & publish" → Run workflow*. After it finishes, the site is live at `https://<you>.github.io/<repo>/`.
4. **Edit `config.json`** on GitHub (web editor is fine) to add your feeds/folders/filters, then run the workflow again (or wait for the hourly cron).

That's it. Every hour the Action re-fetches feeds and force-updates `gh-pages` (which Pages auto-deploys).

## config.json

```jsonc
{
  "settings": {
    "siteName": "My Inoreader",
    "theme": "auto",              // auto | light | dark
    "view": "list",               // list | compact | cards
    "articlesPerFeed": 200,       // newest N kept per feed
    "retentionDays": 90,          // everything older than this is pruned at fetch (0 = keep all)
    "markReadOnOpen": true,       // opening an article marks it read
    "markReadAfterSeconds": 0,    // …after a delay instead
    "refreshMinutes": 60,         // UI polls data/index.json for refreshes
    "fullTextDefault": false      // extract full article text for every feed
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
- Fields: `title`, `content`, `content`/`summary` text, `authors`, `links`
- Within a field entries are OR'ed, across fields AND'ed
- No `include`/`exclude` at all → the filter matches **everything in scope** (e.g. `keepUnread` for a newsletter feed)
- Filters are read by the UI on every load — edits apply immediately, no refetch needed

## Features

- Folders + feeds with live unread counts (folder & global totals)
- **Unread is sacred**: nothing marks an article read except you (open, mark buttons, or a `markRead` filter). Unread articles are never removed by retention within the kept window
- All/Unread/Read chips, date filters (today / 3 days / week / month), All·Unread·Today·Recently read views
- List / Compact / Cards layouts, light/dark/auto theme
- Inline reading pane with prev/next, original site link, mark read/unread, "keep unread"
- **Text view**: feeds with `fullText` get readability-extracted clean article text (vs. truncated feed content)
- **Embeds**: YouTube/Vimeo click-to-play (privacy `youtube-nocookie`), SoundCloud, inline audio/video players
- Search with operators: `feed:bbc title:ai before:2026-01-01 after:2025-12-01 unread:true is:read`, plus `OR` groups
- Full-text search across titles, authors, summaries and article bodies
- Subscription stats + retention info in the settings panel

## Local development

```bash
npm ci          # fetch-script deps only (UI has zero deps)
npm run fetch   # fetch feeds into ./data (also what CI runs)
npm run serve   # http://localhost:8080
npm run test:ui # jsdom smoke test of the UI against local data
```

`data/` and `node_modules/` are git-ignored; CI assembles `index.html + assets/ + config.json + data/` into the `gh-pages` branch. See `AGENTS.md` for architecture details.
