# rssfeed — your own RSS reader on GitHub Actions + Pages

A self-hosted RSS reader with **no server and no database**:

- **GitHub Actions** refreshes the data **at least hourly, self-healing** (RSS + Atom + YouTube channels + 4chan boards + Hacker News): GitHub's scheduler skips cron slots at random (multi-hour streaks observed), so the workflow is scheduled every 15 minutes (deliberately off the congested `:00` minute) and skips early when the published data is <45 min old — the real cadence stays ~hourly, but whichever slot lands first after the data goes stale does the fetch. It extracts clean full text and publishes the site to the **`gh-pages` branch**
- **GitHub Pages** serves the Inoreader-style reader UI
- **`config.json`** is the entire configuration: settings, folders, feeds, per-feed word filters and content filters — plus an optional **`feeds.opml`** export (e.g. Inoreader's) that can provide the feed list, imported server-side by the fetcher
- **YouTube Shorts are banned by default** (`settings.dropShorts`) — shorts slop never enters your unread list, and previously stored Shorts are purged from the retained data on every run (turning the filter on later cleans old articles too)
- **4chan boards are first-class feeds** (`"type": "4chan"`, any board) with reply-count windows and word filtering — `/g/` threads with 300+ replies land in your folders like any other article
- **Hacker News is a first-class feed** (`"type": "hackernews"`) with optional point + comment caps — e.g. only stories with **100+ points and 100+ comments**
- **Read/unread state** lives in your browser (`localStorage`) — nothing is ever auto-marked read; articles stay unread until you read or mark them. Note: articles older than `settings.retentionDays` are dropped from the data files for everyone — the fetcher can't see read state, so retention applies regardless of unread (4chan feeds are exempt: they're live boards, threads leave when they 404).
- **Deep links**: the open article lives in the URL (`#article/<id>`) — refresh and you're still on it, and the browser Back/Forward buttons walk through the articles you opened (misclicked? Back). Opening uses an explicit `history.pushState` and both `popstate` + `hashchange` are wired to the same idempotent sync, so it works even in in-app browsers that mishandle hash-only navigations. Article ids are stable random-looking hashes, so links survive the hourly refetches. Reset your feed state any time via **⋯ → Reset read state**.

## Setup (3 minutes)

1. **Push this repo to GitHub** (default branch, e.g. `main`):
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. **Enable Pages**: repo → *Settings → Pages* → Source: **Deploy from a branch** → Branch: **`gh-pages`** / `/ (root)` → Save. (The branch appears after the first workflow run.)
3. **Run the workflow once**: *Actions → "Fetch feeds & publish" → Run workflow*. After it finishes, the site is live at `https://<you>.github.io/<repo>/`.
4. **Edit `config.json`** on GitHub (web editor is fine) to add your feeds/folders/filters, or drop an Inoreader OPML export as `feeds.opml`, then run the workflow again (or wait for the next scheduled run).

That's it. The Action re-fetches feeds on a self-healing every-15-minutes schedule with a freshness gate (fresh data <45 min old → the run skips early in ~20 s) and force-updates `gh-pages` (which Pages auto-deploys).

## config.json

There is no settings modal and no database: **you configure everything by editing files and pushing**. Preferences without an in-UI toggle are re-read from `config.json` on **every** page load — edit, push, reload. Only your own UI toggles (layout, article-list status, date filter, sort direction, show-filtered, multi-select, folder collapse, sidebar width) are remembered per browser in `localStorage`.

```jsonc
{
  "settings": {
    "siteName": "My RSSFeed",     // tab title: "(N) siteName - open article title"
    "theme": "auto",               // auto | light | dark
    "view": "list",                // default layout for new visitors: list | expanded | column | cards | magazine
    "retentionDays": 30,           // fetcher prunes everything older (read and unread alike)
    "markReadOnOpen": true,        // opening an article marks it read
    "markReadAfterSeconds": 0,     // …after a delay instead (cancelled if you close it first)
    "refreshMinutes": 5,           // UI polls for new data on this wall-clock grid (min 5) — aligned to the CI refresh
    "fullTextDefault": false,      // extract full article text for every feed (unless feed.fullText overrides)
    "dropShorts": true,            // YouTube: drop Shorts (per-feed "dropShorts": false opts a channel back in)
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
    "countersClickable": true,     // sidebar badge click (incl. Newsfeed/Today ticks) marks that section read
    "titleCounter": true,          // "(N) unread" prefix in the tab title
    "showToday": false             // show the Today row in the sidebar
  },
  "folders": [
    { "id": "tech", "name": "Technology" },
    { "id": "quick", "name": "Quick news", "maxAgeDays": 2 }  // folder view only shows last N days
  ],
  "feeds": [
    { "id": "hacker-news", "title": "Hacker News", "url": "https://hnrss.org/frontpage",
      "site": "https://news.ycombinator.com", "folders": ["tech"], "fullText": false, "enabled": true },
    // "folder": "tech" also works for a single folder; "folders" lets a feed sit in several
    // per-feed ingest filter (works for any feed — dropped server-side, never enters the data):
    { "id": "some-blog", "title": "Some Blog", "url": "https://blog.example/rss",
      "filter": { "exclude": { "title": ["sponsored"] }, "include": { "title": ["release"] } } }
    // 4chan board — see the next section
  ],
  "filters": [ /* see below */ ]
}
```

### 4chan boards as feeds

Add any board via 4chan's read-only JSON API (`a.4cdn.org` — the fetcher respects the 1-request/second rule and sends `If-Modified-Since`; attribution: [4chan API](https://github.com/4chan/4chan-API)):

```jsonc
{
  "id": "4chan-g",
  "type": "4chan",
  "board": "g",                // any board — /g/, /t/, /v/… (no slashes needed)
  "title": "/g/ - Technology", // optional — defaults to the board's real title from the API
  "site": "https://boards.4channel.org/g/",  // optional — favicon + attribution
  "folder": "ai-news",
  "minReplies": 300,           // only threads with >= N replies (the "quality" dial)
  "maxReplies": 600,           // optional upper bound (skip bump-locked monsters)
  "minImages": 0, "maxImages": 0,  // optional image-count window
  "includeSticky": false,      // stickies are skipped by default (they're board rules)
  "includeClosed": false,      // closed threads skipped by default
  "maxThreads": 30,            // optional cap on threads kept per fetch (no default — omit for every matching thread)
  "filter": {                  // word filtering, same as any feed (server-side)
    "exclude": { "title": ["general", "/\\bptg\\b/"] },
    "include": { "title": ["linux"] }
  }
}
```

How it behaves:

- **Thread → article**: subject (or first line of the OP) is the title, the OP comment + thumbnail become the body, `N replies · M images · Open the thread` line links the board; row thumbnails come from the OP image
- **Live board**: every run replaces the thread list — a thread that 404'd leaves your reader instead of lingering. Thread numbers never change, so ids (and read state) are stable for surviving threads. `retentionDays` does not apply to 4chan feeds
- **Stable deep links**: same `sha1` 16-hex id scheme as RSS articles — `#article/<id>` survives refetches
- **Boards.json is checked once** for work-safe flags (links to `boards.4channel.org` vs `boards.4chan.org`) and board titles; unknown boards fail the feed with a sidebar warning

### Hacker News as a feed

Add HN via the official search API the site itself uses ([hn.algolia.com/api](https://hn.algolia.com/api) — no key, one request per fetch):

```jsonc
{
  "id": "hackernews",
  "type": "hackernews",
  "title": "Hacker News",           // optional
  "site": "https://news.ycombinator.com/",
  "folder": "tech-news",
  "minPoints": 100,                  // optional: stories need >= N points
  "minComments": 100,                // optional: stories need >= N comments
  "filter": {                        // word filtering, same as any feed (server-side)
    "exclude": { "title": ["youtube"] }
  }
}
```

How the caps work:

- **both set** → a story must meet **both** (the default config ships `100` + `100`)
- **only one set** → the unset cap is ignored, only the set one applies
- **neither set** → no filter: the live HN front page (~30 stories), like visiting the site
- stories within the last `retentionDays` are queried newest-first; a story that later falls off the front page (or below the caps) lingers for `retentionDays` from its publish date — and its points/comments line stays current because fresh hits replace stored ones by id
- ids are `sha1("hn|<objectID>")` — HN item numbers never change, so deep links and read state survive everything, even title edits
- Ask HN / text posts have no external URL — those articles link to the HN discussion page itself

### Feeds from OPML (optional)

Don't want to hand-write feeds? Export OPML from Inoreader (or any reader), save it as **`feeds.opml`** at the repo root, push. The scheduled fetcher imports it server-side — there is no frontend import UI because the frontend never decides what to fetch. Rules:

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
  "feeds": ["*", "hacker-news", "tech", "4chan-g"],  // scope: feed ids and/or folder ids; "*" or omitted = everything
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
- Need something dropped **server-side** (never in the data files at all)? Use the per-feed `filter` above — same matcher semantics, applied by the fetcher. It works for 4chan boards and regular feeds alike.

## Features

- Folders + feeds with live unread counts (folder & global totals) — **click any counter to mark that section read** (with Undo). The **Newsfeed and Today ticks work too** — hover the count, click the ✓
- **Mark by age or exact date**: the ✓ ▾ menu offers **exactly one group** — *Mark as read* while unread articles exist, *Mark as unread* once everything here is read (the same rule as the ✓ button flip). The offered group carries *Older than a day / two days / a week / a month* presets and a **“Before… <date>”** picker. Clicks always respond: they wait for feeds that are still loading (capped, with a visible "still loading" notice) — never silently dead-end
- **Caught-up flip**: when a feed/folder/newsfeed is fully read ("All caught up 🎉"), the SAME top ✓ button becomes *Mark all as unread* — one confirmed click un-marks everything. Marked a whole folder read by accident? It's recoverable
- **Auto-sync aligned with CI**: the Action refreshes on a self-healing quarter-hourly schedule (gate-capped at ~hourly) and publishes ~1–3 min after it starts; open tabs poll on a 5-minute wall-clock grid (`refreshMinutes`), so new articles land within ~5 minutes — announced with a toast, your open article and reading position untouched. A backgrounded tab catches up the moment you focus it
- **Unread is sacred**: nothing marks an article read except you (open, the tick button, bulk, or a `markRead` filter); `keepUnread` filters — and your explicit "keep unread" flags — beat all of it
- **Single read-state indicator**: the tick button on each row (✓ = read, ○ = unread); the reader title links to the original article
- **No vanishing rows**: an article you just read stays in the Unread view (ticked) until you open another article or change the view
- **Deep links + Back/Forward**: opening an article sets `#article/<id>` in the URL as a history entry — Back returns you to the previous article (also works for the reader's prev/next buttons); a refresh reopens the article straight from the URL; closing the reader (Escape/collapse/re-click) replaces the hash instead of stacking history
- **Folders select, chevrons expand**: clicking a folder row shows its articles (selecting ≠ expanding) — the ▸ chevron is the one true expand/collapse control
- **Tab title**: `(N) My RSSFeed - <open article title>` while reading; `(N) My RSSFeed` otherwise
- **YouTube Shorts filter** (`dropShorts`, default on): Shorts arrive in channel feeds with `/shorts/` links — the fetcher drops them (plus `#shorts`-tagged titles); opt a channel back in with `"dropShorts": false`
- **Reset read state** (⋯ menu): forgets all read + keep-unread state in one confirmed click — everything goes back to unread
- All/Unread/Read chips, date filters (today / 3 days / week / month), All·Unread·Today·Recently read views, newest/oldest sort
- **All five layouts**: List (Comfort/Compact/Ultra density), Expanded, Column, Cards, Magazine — light/dark/auto theme
- Inline reading pane with prev/next, original site link, mark read/unread, "keep unread", attachments list
- **Text view**: feeds with `fullText` get readability-extracted clean article text (vs. truncated feed content)
- **Embeds**: YouTube/Vimeo click-to-play (privacy `youtube-nocookie`), SoundCloud, inline audio/video players
- Search with operators: `feed:bbc title:ai before:2026-01-01 after:2025-12-01 unread:true is:read is:unread`, plus `OR` groups
- Full-text search across titles, authors, summaries and article bodies
- Multiple select (bulk mark read/unread with undo), badge-click mark-read with undo, mark-all with confirm
- **Keyboard**: `j`/`k` = next/previous article, `Escape` closes the reader/menus — typing in an input never triggers them
- **Every preference lives in config.json** (see the settings block above) — re-read on every load; your own UI toggles (layout, status, date, sort, show-filtered, multi-select) persist in localStorage
- **4chan boards**: any board as a feed, reply-count windows, sticky/closed skipping, per-board word filters, live thread lists, thumbnails — no API key, just `type: "4chan"`
- **Hacker News**: point + comment caps (AND when both set, either one alone, live front page when neither), word filters, retention-merged stories with current points/comments — `type: "hackernews"`
- Assets are served with a **`?v=` cache-buster** that changes whenever `index.html`/`assets/` change — a normal reload always picks up fresh code, no hard refresh needed after deploys
- Powered by [rssfeed](https://github.com/DarkReaperBoy/rssfeed) — credit lives in the sidebar footer next to the "Updated X ago" line

## Local development

```bash
npm ci          # fetch-script deps only (UI has zero deps)
npm run fetch   # fetch feeds into ./data (also what CI runs)
npm run serve   # http://localhost:8080
npm run test:ui # jsdom smoke test of the UI against local data
```

`data/` and `node_modules/` are git-ignored; CI assembles `index.html + assets/ + config.json + data/` into the `gh-pages` branch. See `AGENTS.md` for architecture details.
