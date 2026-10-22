# AGENTS.md — GitHub-Actions RSS Reader ("rssfeed on Pages")

A self-hosted, serverless RSS reader that is a **1:1 UI clone of Inoreader**, fed by the user's real subscriptions (RSS/Atom + YouTube channels + 4chan boards).

> **Maintenance rule for agents:** this file must stay truthful. Whenever you
> change behavior, schemas, file layout or scope, update the relevant section
> here in the same commit — and when you find stale/outdated text (old schemas,
> removed features, superseded conventions), **clean it up rather than
> appending contradictions**. Prefer rewriting a section over adding caveats.
> The "Generated" section at the bottom records the last meaningful refresh.

## Architecture

- **Fetching backend**: GitHub Actions (`.github/workflows/fetch.yml`) runs **hourly** (`cron: '0 * * * *'`), on `workflow_dispatch`, and **on every push to `main`** (`push: branches: [main]`). It runs `scripts/fetch.mjs`, which downloads every feed (from `feeds.opml` when present, else `config.json` — see below), drops **YouTube Shorts** (`settings.dropShorts`, default on: `/shorts/` links + `#short(s)` tags), ingests **4chan boards** (`"type": "4chan"`, any board, via `a.4cdn.org` — ≤1 req/s, `If-Modified-Since`, live-replace semantics, see Conventions), applies optional **per-feed word filters** at ingest, extracts optional full-text, keeps **only the last `settings.retentionDays` days with no per-feed article cap** (4chan feeds exempt — they replace wholesale), tracks per-feed fetch status (warning icon on failure), purges feeds removed from the source, and writes static JSON into `data/`.
- **Publishing**: the same workflow assembles the site (`index.html`, `assets/`, `config.json`, `data/`) into `_site/` and **force-pushes it to the `gh-pages` branch**. GitHub Pages serves from `gh-pages` branch root. The default branch stays clean: source only, no data commits, no node artifacts.
- **UI**: pure static site served by **GitHub Pages** (`index.html`, `assets/styles.css`, `assets/app.js`). No build step, no framework, no npm deps on the client.
- **Never commit**: `node_modules/`, `_site/` (both in .gitignore). `package.json`/`package-lock.json` ARE committed (CI needs `npm ci`).
- **Config**: files in the repo are the *entire* configuration — there is no settings UI. `config.json` holds settings, folders, feed entries (incl. 4chan boards and per-feed `filter` blocks) and **content filters** (inclusion + exclusion). Optionally, **`feeds.opml`** at repo root (e.g. an Inoreader export) provides the feed list server-side: the fetcher imports it (feed id = diacritic-stripped title slug, folder = enclosing outline title); `config.feeds` entries with the same id/url override the imported fields, config-only feeds are appended, and `config.folders` overrides folder names/`maxAgeDays` by id. Current live set: **6 folders, 60 feeds** in `config.json` (59 YouTube channel Atom feeds + one 4chan board, `/g/` with `minReplies: 300` in the *AI News* folder); no `feeds.opml` committed yet.
- **Read/unread state**: `localStorage` only (per browser/device). Nothing auto-marks articles read — an article stays unread until the user reads or marks it. **Retention is date-based for everyone**: at fetch time everything older than `settings.retentionDays` is dropped (the fetcher cannot see read state), so unread articles older than the window disappear too. The stored feed state is **versioned** (`ghrss:ver` ← `STORAGE_VERSION` in app.js): a browser arriving on a different version gets its read/keep-unread state wiped once (a deployable reset), and the ⋯ menu's **Reset read state** offers the same wipe on demand.

There is deliberately **no server, no database, no auth, no token**. Anything that cannot work as static files + GitHub Actions is out of scope.

## Directory layout

```
config.json            # THE config: settings + folders + feed entries/overrides + filters (user-edited)
feeds.opml             # OPTIONAL feed source (e.g. Inoreader export) — imported by the fetcher
index.html             # UI shell — mirrors real Inoreader DOM ids (#wraper/#side-nav/#tree_pane/#header_pane/#reader_pane)
assets/app.js          # entire UI logic (single file, plain ES2020, no modules)
assets/styles.css      # Inoreader replica styling, light+dark themes
data/index.json        # generated locally/CI: folder registry + per-feed metadata/counts + generatedAt
data/feeds/<feedId>.json  # generated: { articles: [...] } newest-first
scripts/fetch.mjs      # fetcher/extracter run by Actions (Node >= 20, ESM; importable for tests — main() only runs as CLI)
scripts/4chan.mjs      # 4chan catalog→article helpers (pure functions; fetcher owns I/O + sanitization)
scripts/smoke.mjs      # jsdom smoke test of the UI against deterministic fixtures (npm run test:ui)
.github/workflows/fetch.yml  # hourly + push-triggered fetch + publish to gh-pages
package.json           # fetch-script deps only (rss-parser, jsdom, @mozilla/readability, sanitize-html)
```

## config.json schema

```jsonc
{
  "settings": {
    "siteName": "My RSSFeed",
    "theme": "auto",              // auto | light | dark — config-owned (no UI toggle), re-applied every load
    "view": "list",               // default layout for NEW visitors: list | expanded | column | cards | magazine
    "retentionDays": 30,          // fetcher: keep only this window — read and unread alike (fetcher has no read state); 4chan feeds exempt
    "markReadOnOpen": true,       // client: mark read when article is expanded
    "markReadAfterSeconds": 0,    // client: delay before marking read (0 = immediate; cancelled if the article is closed first)
    "refreshMinutes": 60,         // client UI poll interval for data/index.json
    "fullTextDefault": false,     // fetcher: extract full text for every feed unless feed.fullText overrides
    "dropShorts": true,            // fetcher: drop YouTube Shorts (/shorts/ links + #short(s) tags); per-feed "dropShorts": false opts a channel back in
    "density": "comfort",          // list density: comfort | compact | ultra
    "titlesOnly": false,           // hide row excerpts
    "openOriginal": false,         // row click opens the original site instead of the reader
    "showFavicons": true,          // favicons on rows
    "sideFavicons": true,          // favicons in the sidebar
    "compactSidebar": false,       // icons-only 72px sidebar
    "absoluteDates": false,        // full timestamps instead of relative
    "fontSize": "14.5px",          // article title font size
    "columnThumbs": true,          // thumbnails in column view
    "scrollTracking": false,       // mark items read when scrolled past
    "autoScroll": true,            // reader starts at top on open
    "updatedOnly": false,          // sidebar: only feeds with unread items
    "dimRead": false,              // sidebar: dim rows with nothing unread
    "sortAZ": false,               // sidebar sorted A–Z
    "countersClickable": true,     // badge click (incl. Newsfeed/Today ticks) marks that section read
    "titleCounter": true,          // "(N)" unread prefix in the tab title
    "showToday": false             // show the Today row in the sidebar
  },
  "folders": [
    { "id": "tech", "name": "Technology" },
    { "id": "news", "name": "News", "maxAgeDays": 7 }  // maxAgeDays optional: folder view shows only last N days (Inoreader "unread duration")
  ],
  "feeds": [
    {
      "id": "hacker-news",        // unique, kebab-case, = data/feeds/<id>.json filename
      "title": "Hacker News",
      "url": "https://...",       // RSS or Atom (omit for type: "4chan")
      "site": "https://...",      // site root (favicons, attribution)
      "folder": "tech",           // optional; use folder (string) OR folders (array) — a feed may sit in several folders
      "folders": ["tech", "news"],
      "fullText": true,           // optional; overrides settings.fullTextDefault
      "dropShorts": false,         // optional; overrides settings.dropShorts (YouTube feeds only)
      "enabled": true,             // optional; false => fetcher skips it
      "filter": {                  // optional; server-side ingest filter — same matcher semantics as config.filters, applied by the fetcher (dropped items never enter the data)
        "include": { "title": ["release"] },
        "exclude": { "title": ["sponsored"] }
      }
    },
    {
      "id": "4chan-g",            // 4chan boards are feeds: any board, reply window, word filters (see Conventions)
      "type": "4chan",
      "board": "g",
      "title": "/g/ - Technology",
      "site": "https://boards.4channel.org/g/",
      "folder": "ai-news",
      "minReplies": 300,           // only threads with >= N replies; maxReplies/minImages/maxImages optional windows
      "includeSticky": false,      // stickies (board rules) skipped by default; includeClosed likewise
      "maxThreads": 30,            // optional cap per fetch
      "filter": { "exclude": { "title": ["/\\bptg\\b/"] } }
    }
  ],
  "filters": [ /* see below */ ]
}
```

**Settings ownership**: every settings key without an in-UI toggle (`CONFIG_KEYS` in app.js — theme, density, markReadOnOpen, markReadAfterSeconds, titlesOnly, openOriginal, showFavicons, sideFavicons, compactSidebar, absoluteDates, fontSize, columnThumbs, scrollTracking, autoScroll, updatedOnly, dimRead, sortAZ, countersClickable, titleCounter, showToday) is **re-applied from config.json on every page load** — config.json IS the settings UI. Keys with in-UI toggles (`view`→layout for new visitors, status, dateRange, sortDir, showFiltered, bulkSelect, openFolders, sidebarW) are the user's own, persist in `localStorage` (`ghrss:ui`), and are only seeded for brand-new visitors.

### Filters (Inoreader "rules"-like, but pure include/exclude, applied client-side)

```jsonc
{
  "id": "hide-crypto",
  "name": "Hide crypto spam",
  "enabled": true,
  "feeds": ["*", "hacker-news", "tech"],   // scope: feed ids and/or folder ids; "*" (or omitted) = all feeds
  "include": { "title": ["rust"], "content": [], "authors": [], "links": [] }, // if present: article must match >=1 entry in >=1 specified field
  "exclude": { "title": ["crypto", "/\\bbtc\\b/i"], "links": ["youtube.com"] },
  "actions": {
    "hide": true,        // remove from lists entirely (default true for exclusion-only filters)
    "markRead": false,   // treat as read (still shows under "Read")
    "keepUnread": false, // NEVER auto-mark-read this article even with markReadOnOpen
    "highlight": false   // tint the row (user attention)
  }
}
```

Matcher semantics:
- A matcher string is a **case-insensitive substring** unless it looks like `/pattern/flags`, which is treated as a regex.
- Within one field, entries are OR'ed. Across non-empty fields, conditions are AND'ed (an article must satisfy every provided field of the block).
- An exclusion block matches → the `actions` apply. If `include` is present, articles **not** matching it are also excluded (whitelist behavior) and `actions` apply to them too.
- The UI always reads filters from `config.json` (never baked into data/), so filter edits take effect without waiting for a refetch. Counts are computed client-side from local read state.
- **Per-feed `filter`** (in the feed entry) is the fetcher-side equivalent with the same matcher semantics (fields: `title`, `content`, `author`, `link` — OR within a field, AND across fields, `/regex/flags` supported): it runs at ingest time and dropped items never enter the data files. Global `config.filters` scope by feed id, so 4chan feeds (e.g. `"feeds": ["4chan-g"]`) are filterable client-side too.
- **`settings.dropShorts`** (default `true`) drops YouTube Shorts at fetch time for YouTube feeds only (detected via `/shorts/` item links — confirmed against live feeds — plus `#short`/`#shorts` tags in title/description). Per-feed `"dropShorts": false` restores a channel. This is a fetch-time drop (not a client filter) because Shorts slop shouldn't even reach the data files.

## data/ schemas (generated — never hand-edit)

`data/index.json`:
```json
{ "generatedAt": 1730000000000,
  "folders": [{ "id": "tech", "name": "Technology" }],
  "feeds": {
  "hacker-news": { "title": "Hacker News", "site": "...", "folder": "tech", "folders": ["tech"], "count": 200, "newest": 1730000000000, "status": { "ok": true, "lastAttempt": 1730000000000, "lastSuccess": 1730000000000, "consecutiveFailures": 0, "error": null } }
}}
```
`folders` is the merged folder registry (feeds.opml folders + config.folders overrides by id) that the sidebar renders; the UI falls back to `config.folders` for data files generated before this field existed.

`data/feeds/<feedId>.json`:
```jsonc
{ "articles": [ {
  "id": "stable-id",       // sha1(link|title) for RSS; sha1(link) for 4chan (thread numbers never change) — first 16 hex, stable across refetches; read state keys on it and the URL hash deep-links it (#article/<id>)
  "title": "...",
  "link": "https://...",
  "author": "...",           // 4chan: null for Anonymous posts
  "date": 1730000000000,   // ms epoch; fallback = fetch time; 4chan = OP post time
  "summary": "plain text snippet for lists",
  "content": "<p>feed-provided HTML (sanitized)</p>",  // 4chan: OP image (thumb→full link) + OP comment + "N replies · M images · Open the thread"
  "text": "<p>readability-extracted full text (sanitized), optional</p>",
  "enclosures": [{ "url": "https://...mp3", "type": "audio/mpeg" }],  // 4chan: [{ url: "https://i.4cdn.org/<board>/<tim>s.jpg", type: "image/thumbnail" }]
  "fetchedAt": 1730000000000
} ] }
```
Feed status in `data/index.json` carries `lastModified` for 4chan feeds (the catalog's `Last-Modified`, replayed as `If-Modified-Since`; a 304 keeps the previous file).

## Conventions & constraints

- **Client is one plain script** (`assets/app.js`), no ES modules (must work from file:// for local testing and keeps jsdom smoke tests trivial), no dependencies, no build step.
- All HTML from feeds is **sanitized at fetch time** with `sanitize-html` (allowlist; no `<button>`/`<center>`; no `data:` hrefs — data: images only; iframes only for youtube-nocookie/vimeo). The client additionally strips `script/style/class/style-attr` and dangerous `href` schemes from rendered bodies, forces `target=_blank rel=noopener` on body links, and only rebuilds the reader pane when the open article actually changes (playing embeds survive re-renders).
- **Enclosures**: YouTube/flash player-embed URLs and `image/thumbnail` enclosures are not listed as attachments (the thumbnail already renders as the row thumb); everything else non-image becomes an attachment link, standalone images render below the article.
- localStorage maps are kept on **null-prototype objects** so feed GUIDs like `constructor` or `__proto__` can't fake lookups or pollute prototypes.
- **Embeds**: the client upgrades bare media links in article bodies to players — YouTube (watch/youtu.be → `youtube-nocookie.com/embed/<id>` iframe), Vimeo, SoundCloud (lazy iframe on click), direct audio/video → HTML5 player. Never fetch remote JS.
- Favicons: `https://www.google.com/s2/favicons?domain=<host>&sz=64` (external, degrade to letter-tile on error).
- **Unread is sacred**: nothing may mark an article read except (a) the user opening it (per settings), (b) the user's explicit "mark all as read"/"mark read", or (c) a filter with `markRead: true`. `keepUnread` filters — and the user's explicit keep-unread flags (`ghrss:kept`) — beat (a) AND (c): the client skips re-ingest for kept articles, so an automation never eats an article the user pinned.
- **No vanishing rows** (user requirement): a row the user just read lingers in the Unread view (tick flips to ✓) until they move on — opening another article, prev/next, a status/date-filter change, bulk mark or mark-all clears the linger set (`state.keepVisible`). Scroll tracking is exempt (those rows are already off-screen).
- **Mark-all ⇄ mark-as-unread** (user requirement): the top ✓ button is the SAME button in two modes. When the current scope is fully caught up (no unread, not filter-hidden, all scope feeds settled — `allReadInScope`), it flips: title → "Mark all as unread", icon → unread circle, the ▾ dropdown label → "Mark as unread articles" and its Older-than items restore by age (`markScopeUnread`, with Undo). It only happens when *everything* is read — any unread article keeps the mark-as-read mode. `state.settled` tracks feeds that finished loading (or 404'd) so the mode never flips prematurely on lazy-loaded scopes. The "All caught up 🎉" empty state advertises the flipped button.
- **Folders select, chevrons expand** (user requirement): clicking a folder row selects the folder (shows its articles) and does NOT expand it — the `svg.chev` inside the row is the one true expand/collapse control (own delegated click branch, `renderTree`-only re-render, selection untouched).
- **Sidebar ticks**: every unread badge is a mark-read tick — folder rows, feed rows, and the Newsfeed (`data-markread="all"`) + Today (`data-markread="today"`) rows; the CSS ✓-hover hint and `countersClickable` gating apply to all of them. The sidebar footer (`#last-updated`) shows "Updated X ago" (`#last-updated-text`) plus a "Powered by rssfeed" credit link to the project.
- Read state lives in localStorage under namespace `ghrss:` (`ghrss:read` = {id: timestamp}, `ghrss:kept` = {id: true}, `ghrss:ui` = the user's OWN UI toggles only — config-owned prefs are never persisted there, `ghrss:ver` = storage layout version). Article ids must be stable or read state is lost.
- **Deep links** (user requirement): the open article lives in the URL hash (`#article/<id>`; the id is the stable sha1 article hash — random-looking but deterministic, so links survive hourly refetches; truly random ids would break every Action run). One URL-driven open/close path (`openArticle`/`closeArticle` + `openViaHash`/`closeViaHash` + a `hashchange` sync): opening (row click, prev/next) **pushes** a history entry — Back/Forward walk the opened articles; closing (collapse button, Escape, re-click, scope/view change, mark-all) uses `history.replaceState` so it never stacks "closed" entries. Boot restores `#article/<id>` after a refresh with click-identical semantics (mark-read rules included); a hash whose article left the retention window or is filter-hidden self-heals (cleared + toast).
- **Feed-storage versioning** (user requirement): `STORAGE_VERSION` in app.js (currently 2) is stored per browser in `ghrss:ver`. Arriving with a different version wipes `ghrss:read`/`ghrss:kept` once (UI prefs survive). This is the mechanism behind the requested "reset the current feed storage"; bump it to reset everyone again. The ⋯-menu "Reset read state" does the same wipe on demand.
- The publish commit on `gh-pages` uses `[skip ci]` and `github-actions[bot]` identity. Fetch failures for one feed must not fail the run (log + continue). The default branch gets **no** CI commits.
- Node >= 20 (global fetch). Fetcher must be idempotent and CI-friendly: no interactivity, exit 0 on partial failure, cap text-extraction fetches (~20 newest unextracted per feed per run). `scripts/fetch.mjs` only runs `main()` when invoked as a CLI (`import.meta.url === pathToFileURL(argv[1])`), so tests import its pure exports (`isShortItem`, `compileMatcherSrv`, `compileBlockSrv`, `feedFilterDrop`) — 4chan helpers live in `scripts/4chan.mjs` (pure; the fetcher owns network I/O).
- **4chan ingestion** (per the [4chan API](https://github.com/4chan/4chan-API) global rules): ≤1 request/second across all 4chan endpoints (`chanThrottle` — 1.1s spacing incl. boards.json), `If-Modified-Since` on catalog requests (304 → keep previous file), proper User-Agent. `boards.json` (cached per run) resolves the work-safe domain (boards.4channel.org vs boards.4chan.org) + real board titles; an unknown board fails that feed with a clear error. **Live-replace semantics**: each run replaces the board's article set — 404'd threads leave instead of lingering for retentionDays (ids stay stable for survivors via sha1(thread link)); sticky/closed threads are skipped unless opted in. `retentionDays` does not apply to 4chan feeds. Threads → articles: subject (or first OP comment line) is the title, OP comment + thumbnail = body, `N replies · M images · Open the thread` footer, enclosure = small square thumb.
- **No duplicated navigation** (user requirement): the left rail (`#tabs_pane`) is a *module switcher* only (Newsfeed/Dashboards/Feeds/Saved/Automate/Search/Add feed + Audio player/Notifications/Support/Settings/profile/dock). Status views (All/Unread/Today/Recently read) live **only** in the header ⋯ menu; the sidebar tree holds **only** the opt-in Today row + Newsfeed + folders/feeds — exactly the real app's DOM.

## UI parity state (verified against the user's saved real-reader capture, 2026-10-22)

Source material on the user's Desktop (OUTSIDE the project — do not delete): `(81) Inoreader - The FBI just arrested...html` + `..._files/` (their production `main_6VYi.css`, `article_skeleton_6VYi.js`, full DOM, preferences JSON).

Replicated 1:1 (structural, from their DOM/CSS):
- `#wraper > #side-nav(#tabs_pane 72px rail: .tab-item icon tiles, active tile `#597fb8`, `.tabs-counter` badge `#597fb8` + `#134b91` outline; #tree_pane 310px with `#feeds_nav/#saved_nav/#automation_nav/#profile_nav/#placeholder_nav` panels, `#subscriptions_fieldset` = Today (`hidden` by default, settings toggle) + Newsfeed + `#tree`, drag `#sidebar_resizer`, foot `#last-updated`) > `#content-wrapper(#header_pane` sticky 50px: title + "N unread" + title dropdown (Feed properties / Set as start page / PRO-shielded items), split `✓|▾` mark-all `.btn-heading` group, expanding search, ⋯ menu with article-list status / multiple select / show filtered / refresh / **reset read state** / 5 layouts / date / sort; `#reader_pane`)`.
- Split list+reader: `#list-pane` + `#reader-slot` (the reader pane is simply empty until an article is opened — the "Select an article" placeholder text was removed at the user's request), reader toolbar (prev/next, open-original, close) + linked title + source/date/reading-time sub-row, scroll up/down buttons.
- List rows: `[favicon+feed][row-main(title + inline excerpt)][date right]` + control strip (open-in-new-tab, keep-unread, read tick). Attachments list in the reader.
- Mark-all split button `✓|▾` with dropdown: "Mark all as read" / "Older than a day…" / "Older than two days…" / "Older than three days…" / "Older than a week…" (marks matching older items read) — and the same group flips to "Mark as unread articles" when the scope is fully caught up.
- Design tokens: primary `#1875F3`, Roboto, headings `#081425/#1a2433`, gray `#71747a`, borders `#e9eaf0`, `.btn-heading` `#edeff2/#dee2e7/#cfd5dd`, reader column 870px.
- Features: all 5 layouts + comfort/compact/ultra density + newest/oldest sort, search operators + OR, date filters, config include/exclude filters, badge-click mark-read + Undo toast, scroll tracking, titles-only, open-original, bulk multi-select + bulk bar (row click selects in bulk mode), absolute dates, title font size, compact sidebar, tab-title unread counter + open-article title (`(N) My RSSFeed - <title>`), attachments list, mark-all confirm, mark-as-unread restore when caught up, **Estimated reading time in reader**. The row's single read-state indicator is the tick button (✓/○) — the blue unread dot was removed at the user's request; the reader title links to the original article. (Row ⋯ context menu, Copy link, stars/read-later, and state export/import were removed — see Generated 2026-10-23 (2).)
- Server-side-only items (Archive/Annotated/Web pages/Uploads, Rules/Filters/Spotlights/Email digests, Plans/Invite friends) render **inert** with tooltips — visible for 1:1 chrome, honest about being unavailable offline.

**Out of scope** (cannot exist as static files, or explicitly unwanted): accounts/auth, real notification/rule/dashboard backends, tags, notes, keyboard shortcuts, AI summaries, translations, OPML import/export **UI** (file-based `feeds.opml` import IS supported — done by the fetcher, since the frontend never decides what to fetch), timezone pickers, popularity scores, custom CSS, stars/read-later (removed at the user's request — "useless").

Smoke test: `node scripts/smoke.mjs` boots the real `index.html` + `app.js` in jsdom against **deterministic in-memory fixtures** (the real feed list is 59 YouTube feeds + a 4chan board — disk data would make tests slow/network-dependent) and asserts chrome, filters, scopes, layouts, config-owns-settings (theme), double-click linger + move-on refilter, mark-all split with undo, search-clear-on-close, bulk select, **deep links** (hash in URL on open, cleared on collapse, Back/Forward reopen articles, boot-with-hash restores the article + storage-version reset semantics), reset-read menu, panels, menus, and interactions — plus the new behaviors (tab-title format, Newsfeed/Today badge ticks, mark-all⇄mark-unread toggle incl. older-than restores, folder-selects/chevron-expands, sidebar credit) and **unit tests** for fetch.mjs (Shorts detection, per-feed word filters) and 4chan.mjs (catalog flattening, reply/sticky/closed windows, thread→article shape, id stability, word filters) — **123 assertions**, all passing.

## Generated

- 2026-10-23 (4): **4chan boards + Shorts ban + mark-as-unread + QoL batch** (user request). **New sources**: (1) YouTube Shorts are dropped at fetch time (`settings.dropShorts`, default ON — confirmed live that channel feeds ship Shorts with `/shorts/` links; `#short(s)` tags also detected; per-feed `"dropShorts": false` opts back in) — the 59-feed run dropped 22 Shorts; (2) **4chan boards as feeds** (`"type": "4chan"`, any board) via the read-only a.4cdn.org JSON API: `scripts/4chan.mjs` (pure thread→article: subject/first-line title, OP comment body + thumbnail enclosure, `N replies · M images · Open the thread`, sha1(thread-link) stable ids), fetcher honors the API rules (≤1 req/s throttle incl. boards.json, If-Modified-Since + 304 path with `status.lastModified`, work-safe domain from boards.json, unknown-board error), config knobs: `minReplies/maxReplies/minImages/maxImages/includeSticky/includeClosed/maxThreads` + per-feed `filter` word blocks (same matcher semantics as global filters — AND across fields, OR within, /regex/flags) — `/g/` with `minReplies: 300` added to the AI News folder; live-replace semantics (404'd threads leave; no retention merge). **Fixed (user reports)**: the Newsfeed + Today sidebar ticks never worked (badges showed the CSS ✓ hint but had no `data-markread`) — both are real mark-read ticks now; clicking a folder both selected AND expanded it — selecting no longer expands, the `svg.chev` is the sole expand control. **New QoL (user requests)**: when a feed/folder/newsfeed is fully caught up, the SAME top ✓ button flips to "Mark all as unread" (icon + ▾ menu label flip; Older-than entries restore by age; confirm + Undo; only when everything is read — `state.settled` prevents premature flips on lazy-loaded scopes; caught-up empty state advertises it); tab title shows `(N) My RSSFeed - <open article title>`; rebrand "My Inoreader" → "My RSSFeed" everywhere (tab, config default, smoke fixtures); sidebar footer got a "Powered by rssfeed" credit link next to the Updated line. **Fixed (rescan)**: config `markRead` filters re-ate articles the user explicitly kept unread on every refresh (keep flags now beat filter ingest); duplicate media:thumbnail enclosures on YouTube feeds deduped; fetch.mjs made importable (CLI guard) so smoke unit-tests its pure exports. Verified live end-to-end: full fetch (60 feeds, 0 failures, /g/ = 6 threads ≥300 replies) + browser session (deep link on a /g/ thread, mark-all→mark-unread round-trip, zero console errors). Smoke 66 → **123 assertions** (57 new: UI behaviors + 4chan/Shorts/word-filter unit tests). Docs updated in the same commit per the maintenance rule.

- 2026-10-23 (3): **Deep links + feed-storage reset** (user request: "reset the current feed storage" + "article id in the URL so refresh keeps me on the same article and Back undoes a misclick"). The open article now lives in the URL as `#article/<id>`; the id is the existing `sha1(link|title).slice(0,16)` — random-looking AND deterministic, which is exactly what makes refresh-restore survive hourly refetches (truly random ids would churn on every Action run). Single URL-driven open/close path in app.js: opens (row click, prev/next) push a history entry → Back/Forward walk opened articles; closes (collapse, Escape, re-click, scope/view change, mark-all) replaceState the hash away (no history spam); boot restores the hashed article with click-identical mark-read semantics; stale hashes (aged-out/filter-hidden) self-heal with a toast. Storage reset: `STORAGE_VERSION` (localStorage `ghrss:ver`, currently 2) — arriving browsers get read/keep state wiped once (UI prefs kept); deployed as the requested one-time reset. New **Reset read state** ⋯-menu item (confirm dialog + toast) for on-demand wipes. Docs updated in the same commit per the maintenance rule. Smoke 48 → **66 assertions** (hash lands in URL, collapse clears it, Back/Forward reopen, boot-with-hash restores + marks read, version-wipe + same-version survival, menu reset empties storage).

- 2026-10-23 (2): User-feedback pass. **Removed**: star feature entirely (rows, reader, sidebar row, icon, CSS, docs — "useless"), blue unread dot (the tick button is the single read-state indicator), reader placeholder text, the 3 disabled example filters in config.json (`filters: []`). **Fixed (user reports)**: reader title now links to the original article; double-clicking an article no longer makes it disappear — a read row lingers in the Unread view until the user opens another article or changes the view (previously collapsing deleted the row, AND moving a→b wrongly kept the old row). **Fixed (rescan)**: config.json settings only applied on first visit (localStorage froze them forever) — config-owned prefs are now re-applied on every load and `ghrss:ui` stores only the user's own toggles; list scroll jumped to the top on every re-render (now preserved); Escape in the search box also closed the open article; dead `#sidebar-menu`/`#btn-sidebar-menu` handler + `ui.sidebarOpen` removed; fetcher logs hardcoded "30 days" while retentionDays is configurable; badge ✓-hover no longer advertises click-to-mark when `countersClickable: false`. **Added**: optional **`feeds.opml`** at repo root — fetcher-side OPML import (jsdom XML mode; id = diacritic-stripped title slug; config.feeds overrides by id/url; config.folders overrides by id; merged folder registry now written to `data/index.json.folders`, UI reads it with config fallback); verified by 18 standalone parser/merge tests. Smoke rewritten for the new behaviors: **48/48 passing**.

- 2026-10-23: Senior-dev audit pass. **Fixed**: mobile scrim covered the sidebar (z-index) and stayed stuck after picking a feed; `decodeURIComponent` crash on malformed attachment names; attachments double-listing thumbnails + junk YouTube player-embed links; `markReadAfterSeconds` timer firing after the article was closed; stale `keepVisible` rows sticking in the unread view; closing search left the filter invisibly active; starred scope unreachable + ignored date/search filters; unknown `key:value` search tokens mangled (URLs); regex `g`-flag statefulness in config filters. **Hardened**: reader DOM sanitize strips feed `class`/`style`/`data:` hrefs, fetcher drops `<button>`/`<center>`/data-hrefs; localStorage maps are null-prototype (GUID `__proto__`/`constructor` safe). **Revived**: minimal Starred feature (★ on rows + reader, Starred sidebar row with count, empty state, reading time in reader). **Perf**: reader pane only rebuilds when the open article changes (embeds keep playing across re-renders); hourly poll re-downloads payloads only when `generatedAt` changes; search compiled once per render. **Removed dead**: shortHost, feedErrors, state.tab/railTab/menuId/readerTab, hide-read/copy-link dispatch branches, #row-menu, #set-* sync lines, export/import handlers, ~23 unused SVG symbols, ~140 lines dead CSS (rail/chips/reader-tabs/profile/stats/settings-modal leftovers), TEXT_EXTRACT_AGE_DAYS. **Docs**: removed lying `keepUnreadForever`/`articlesPerFeed` settings (fetcher can't see read state — retention is date-based for everyone), README/AGENTS updated accordingly. Smoke extended to 29 assertions (star flow, search clear) — 29/29 passing.

- 2026-10-22 (4): Polish pass — added "Copy link" to row/reader context menus with clipboard fallback, added JSON export/import for read/starred/kept/UI state in Settings, added estimated reading time in the reader, enhanced smoke test coverage (layouts, settings close, header menu) to 29 passing assertions, refreshed AGENTS.md to match current behavior.
- 2026-10-22 (5): Expanded rail to full module switcher (Dashboards, Automate, Add feed, Audio player, Notifications, Support, Profile) with honest placeholder panels; added keep-unread and mark-read toggles to row hover actions for closer 1:1 parity with the captured reader. Smoke still 29/29 passing.
- 2026-10-22 (6): CSS parity pass — aligned tabs-counter, dropdown padding/item padding, btn-heading border, heading-wrapper padding to the captured Inoreader stylesheet. Smoke still 29/29 passing.
- 2026-10-22 (7): Fixed header control order (mark-all before search) and spacing (more menu pushed right with auto margin) per captured Inoreader layout. Smoke still 29/29 passing.
- 2026-10-22 (8): Dark theme switched to AMOLED (pure black backgrounds). Added missing icons to header menu items (multiple select, show filtered). Smoke still 29/29 passing.
- 2026-10-22 (9): Added icons to status/sort menu items; tightened icon/text spacing in dropdowns. Smoke still 29/29 passing.
- 2026-10-22 (10): Aligned refresh menu item spacing with other items. Smoke still 29/29 passing.
- 2026-10-22 (11): Removed Inoreader-only modules (premium rules/filters, support, audio player, notifications, automation, dashboard, add-feed, profile) and the settings modal; settings now live in config.json. Smoke 27/27 passing.
- 2026-10-22 (12): Removed settings/add-folder sidebar icons; all settings live in config.json. Smoke 27/27 passing.
- 2026-10-22 (13): Removed entire left rail, Saved/Starred section, search tab, dock toggle, and premium (PRO) buttons; reader now focuses on feed reading + read tracking. Smoke 20/20 passing.
- 2026-10-22 (14): Cleaned up title-menu and sidebar markup after removals. Smoke 20/20 passing.
- 2026-10-22 (15): Re-reviewed captured Inoreader HTML; remaining frame mirrors it (reader-only). Smoke 20/20 passing.
- 2026-10-22 (16): Final review of full captured HTML; no further structural changes. Smoke 20/20 passing.
- 2026-10-22 (17): Fixed #content-wrapper grid-column (3→2) after rail removal; layout no longer broken. Smoke 20/20 passing.
- 2026-10-22 (18): Added border-right to #side-nav for the missing sidebar divider. Smoke 20/20 passing.
- 2026-10-22 (19): Added .nojekyll to publish step to disable Jekyll on GitHub Pages. Smoke 20/20 passing.
- 2026-10-22 (20): Fetcher now writes consolidated data/all-feeds.json so the frontend loads one file. Smoke 20/20 passing.
- 2026-10-22 (21): Tagged consolidated articles with _feed so frontend groups them correctly. Smoke 20/20 passing. Smoke still 29/29 passing.
- 2026-10-22 (22): Fixed YouTube feed parsing (media:description + thumbnails), linkified bare URLs for embeds, respected markReadOnOpen/keepUnread in bulk+schedule, used retentionDays from config, hourly cron, removed dead UI (settings modal, rail modules, row-menu ellipsis, pro placeholders), smoke closes jsdom.
- 2026-10-22 (3): 1:1 chrome rebuild from the capture's real DOM: rail became a module switcher (removing the duplicated Today/Newsfeed/Unread/Read second nav — user complaint), sidebar panels (Feeds/Saved/Automate/Profile/placeholders), header title dropdown + ⋯ menu now owns the article-list status (All/Unread/Today/Recently read), star/read-later + Saved tab added, config.json rebuilt from the user's OPML export (6 folders/59 feeds), workflow gained a `push` trigger so their CI/CD deploys on push, smoke rewritten to deterministic fixtures (75 assertions, all passing).
- 2026-10-22 (2): Inoreader-parity pass from the real reader capture + help center: 5 layouts, density, sort toggle, badge-click mark-read, undo toast, sidebar options menu, scroll tracking, X hide-button (34→45 assertions as chrome evolved).
- 2026-10-22: initial build. Fetcher: rss-parser + jsdom/readability + sanitize-html. UI: single `assets/app.js`, vanilla ES2020. Data: `data/index.json` + `data/feeds/<id>.json`. Publishing: workflow force-pushes assembled `_site/` to `gh-pages`; default branch has no CI commits and ignores `data/`, `node_modules/`, `_site/`.
