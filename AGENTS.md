# AGENTS.md — GitHub-Actions RSS Reader ("Inoreader on Pages")

A self-hosted, serverless RSS reader that is a **1:1 UI clone of Inoreader**, fed by the user's real subscriptions.

> **Maintenance rule for agents:** this file must stay truthful. Whenever you
> change behavior, schemas, file layout or scope, update the relevant section
> here in the same commit — and when you find stale/outdated text (old schemas,
> removed features, superseded conventions), **clean it up rather than
> appending contradictions**. Prefer rewriting a section over adding caveats.
> The "Generated" section at the bottom records the last meaningful refresh.

## Architecture

- **Fetching backend**: GitHub Actions (`.github/workflows/fetch.yml`) runs **hourly** (`cron: '0 * * * *'`), on `workflow_dispatch`, and **on every push to `main`** (`push: branches: [main]`). It runs `scripts/fetch.mjs`, which downloads every feed in `config.json`, extracts optional full-text, keeps **only the last 30 days with no per-feed article cap**, tracks per-feed fetch status (warning icon on failure), purges feeds removed from `config.json`, and writes static JSON into `data/`.
- **Publishing**: the same workflow assembles the site (`index.html`, `assets/`, `config.json`, `data/`) into `_site/` and **force-pushes it to the `gh-pages` branch**. GitHub Pages serves from `gh-pages` branch root. The default branch stays clean: source only, no data commits, no node artifacts.
- **UI**: pure static site served by **GitHub Pages** (`index.html`, `assets/styles.css`, `assets/app.js`). No build step, no framework, no npm deps on the client.
- **Never commit**: `node_modules/`, `_site/` (both in .gitignore). `package.json`/`package-lock.json` ARE committed (CI needs `npm ci`).
- **Config**: a single `config.json` at repo root is the *entire* configuration: UI settings, folders, feeds, and **content filters** (inclusion + exclusion). Current folders/feeds were imported from the user's Inoreader OPML export (`~/Downloads/Inoreader Feeds 20261022.xml`): **6 folders, 59 feeds** (mostly YouTube channel Atom feeds + one rsshub proxy).
- **Read/unread state**: `localStorage` only (per browser/device). Articles are **never auto-pruned while unread** — an article stays unread until the user reads or marks it. Read articles are eventually pruned by `settings.retentionDays` at fetch time. Stars (read-later) also live in localStorage (`ghrss:starred`).

There is deliberately **no server, no database, no auth, no token**. Anything that cannot work as static files + GitHub Actions is out of scope.

## Directory layout

```
config.json            # THE config: settings + folders + feeds + filters (user-edited; feeds = OPML import)
data/index.json        # generated locally/CI: per-feed metadata/counts, generatedAt timestamp
data/feeds/<feedId>.json  # generated: { articles: [...] } newest-first
assets/app.js          # entire UI logic (single file, plain ES2020, no modules)
assets/styles.css      # Inoreader replica styling, light+dark themes
index.html             # UI shell — mirrors real Inoreader DOM ids (#wraper/#side-nav/#tabs_pane/#tree_pane/#header_pane/#reader_pane)
scripts/fetch.mjs      # fetcher/extracter run by Actions (Node >= 20, ESM)
scripts/smoke.mjs      # jsdom smoke test of the UI against deterministic fixtures (npm run test:ui)
.github/workflows/fetch.yml  # hourly + push-triggered fetch + publish to gh-pages
package.json           # fetch-script deps only (rss-parser, jsdom, @mozilla/readability, sanitize-html)
```

## config.json schema

```jsonc
{
  "settings": {
    "siteName": "My Inoreader",
    "theme": "auto",              // auto | light | dark (client default; user toggle overrides in localStorage)
    "view": "list",               // list | expanded | column | cards | magazine
    "articlesPerFeed": 200,       // ignored in favor of time-based rolling window (no per-feed cap)
    "retentionDays": 30,          // keep only articles from last 30 days; no article count limit
    "keepUnreadForever": true,    // unread articles survive retention window
    "markReadOnOpen": true,       // client: mark read when article is expanded
    "markReadAfterSeconds": 0,    // client: delay before marking read (0 = immediate)
    "refreshMinutes": 60,         // client UI poll interval for data/index.json
    "fullTextDefault": false      // extract full text for every feed unless feed.fullText overrides
  },
  "folders": [
    { "id": "tech", "name": "Technology" },
    { "id": "news", "name": "News", "maxAgeDays": 7 }  // maxAgeDays optional: folder view shows only last N days (Inoreader "unread duration")
  ],
  "feeds": [
    {
      "id": "hacker-news",        // unique, kebab-case, = data/feeds/<id>.json filename
      "title": "Hacker News",
      "url": "https://...",       // RSS or Atom
      "site": "https://...",      // site root (favicons, attribution)
      "folder": "tech",           // optional; use folder (string) OR folders (array) — a feed may sit in several folders
      "folders": ["tech", "news"],
      "fullText": true,           // optional; overrides settings.fullTextDefault
      "enabled": true             // optional; false => fetcher skips it
    }
  ],
  "filters": [ /* see below */ ]
}
```

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

## data/ schemas (generated — never hand-edit)

`data/index.json`:
```json
{ "generatedAt": 1730000000000, "feeds": {
  "hacker-news": { "title": "Hacker News", "site": "...", "folder": "tech", "count": 200, "newest": 1730000000000, "status": { "ok": true, "lastAttempt": 1730000000000, "lastSuccess": 1730000000000, "consecutiveFailures": 0, "error": null } }
}}
```

`data/feeds/<feedId>.json`:
```json
{ "articles": [ {
  "id": "stable-id",       // guid or sha1(link+title) — STABLE across refetches (read state keys on it)
  "title": "...",
  "link": "https://...",
  "author": "...",
  "date": 1730000000000,   // ms epoch; fallback = fetch time
  "summary": "plain text snippet for lists",
  "content": "<p>feed-provided HTML (sanitized)</p>",
  "text": "<p>readability-extracted full text (sanitized), optional</p>",
  "enclosures": [{ "url": "https://...mp3", "type": "audio/mpeg" }],
  "fetchedAt": 1730000000000
} ] }
```

## Conventions & constraints

- **Client is one plain script** (`assets/app.js`), no ES modules (must work from file:// for local testing and keeps jsdom smoke tests trivial), no dependencies, no build step.
- All HTML from feeds is **sanitized at fetch time** with `sanitize-html` (allowlist; iframes only for youtube-nocookie/vimeo). The client additionally sandboxes the rendering container.
- **Embeds**: the client upgrades bare media links in article bodies to players — YouTube (watch/youtu.be → `youtube-nocookie.com/embed/<id>` iframe), Vimeo, SoundCloud (lazy iframe on click), direct audio/video → HTML5 player. Never fetch remote JS.
- Favicons: `https://www.google.com/s2/favicons?domain=<host>&sz=64` (external, degrade to letter-tile on error).
- **Unread is sacred**: nothing may mark an article read except (a) the user opening it (per settings), (b) user's explicit "mark all as read"/"mark read", or (c) a filter with `markRead: true`. `keepUnread` filters beat (a).
- Read state lives in localStorage under namespace `ghrss:` (`ghrss:read` = {id: timestamp}, `ghrss:ui` = UI prefs, `ghrss:kept` = {id: true}, `ghrss:starred` = {id: feedId}). Article ids must be stable or read state is lost.
- The publish commit on `gh-pages` uses `[skip ci]` and `github-actions[bot]` identity. Fetch failures for one feed must not fail the run (log + continue). The default branch gets **no** CI commits.
- Node >= 20 (global fetch). Fetcher must be idempotent and CI-friendly: no interactivity, exit 0 on partial failure, cap text-extraction fetches (~20 newest unextracted per feed per run).
- **No duplicated navigation** (user requirement): the left rail (`#tabs_pane`) is a *module switcher* only (Newsfeed/Dashboards/Feeds/Saved/Automate/Search/Add feed + Audio player/Notifications/Support/Settings/profile/dock). Status views (All/Unread/Today/Recently read) live **only** in the header ⋯ menu; the sidebar tree holds **only** the opt-in Today row + Newsfeed + folders/feeds — exactly the real app's DOM.

## UI parity state (verified against the user's saved real-reader capture, 2026-10-22)

Source material on the user's Desktop (OUTSIDE the project — do not delete): `(81) Inoreader - The FBI just arrested...html` + `..._files/` (their production `main_6VYi.css`, `article_skeleton_6VYi.js`, full DOM, preferences JSON).

Replicated 1:1 (structural, from their DOM/CSS):
- `#wraper > #side-nav(#tabs_pane 72px rail: .tab-item icon tiles, active tile `#597fb8`, `.tabs-counter` badge `#597fb8` + `#134b91` outline; #tree_pane 310px with `#feeds_nav/#saved_nav/#automation_nav/#profile_nav/#placeholder_nav` panels, `#subscriptions_fieldset` = Today (`hidden` by default, settings toggle) + Newsfeed + `#tree`, drag `#sidebar_resizer`, foot `#last-updated`) > `#content-wrapper(#header_pane` sticky 50px: title + "N unread" + title dropdown (Feed properties / Set as start page / PRO-shielded items), split `✓|▾` mark-all `.btn-heading` group, expanding search, ⋯ menu with article-list status / multiple select / show filtered / refresh / 5 layouts / date / sort; `#reader_pane`)`.
- Split list+reader: `#list-pane` + `#reader-slot` with "Select an article from the list" placeholder, reader toolbar with title/source/date/open-original and DESCRIPTION/TRANSCRIPT/TOPICS/ARTICLE tabs + mentions row, scroll up/down buttons.
- List rows: `[dot][favicon+feed 130px][row-main(title + inline excerpt)][date right]` + hover control strip (star, open-in-new-tab, keep-unread, read toggle, ⋯). Per-row ⋯ menu and attachments.
- Mark-all split button `✓|▾` with dropdown: "Mark all as read" / "Older than a day…" / "Older than two days…" / "Older than three days…" / "Older than a week…" (marks matching older items read).
- Design tokens: primary `#1875F3`, Roboto, headings `#081425/#1a2433`, gray `#71747a`, borders `#e9eaf0`, `.btn-heading` `#edeff2/#dee2e7/#cfd5dd`, reader column 870px.
- Features: all 5 layouts + comfort/compact/ultra density + newest/oldest sort, search operators + OR, date filters, config include/exclude filters, badge-click mark-read + Undo toast, sidebar options menu (updated-only/dim-read/sort A–Z), X hide button, scroll tracking, titles-only, open-original, bulk multi-select + bulk bar, absolute dates, title font size, compact sidebar, tab-title unread counter, attachments list, mark-all confirm, **star/read-later per row + reader → Saved tab (Starred panel, functional)**, **Copy link in row/reader menus**, **Export/import read/starred/kept state (JSON)**, **Estimated reading time in reader**, rail module panels (Automate/Profile real labels from capture; Dashboards/Audio/Notifications/Support/Add feed = honest placeholder panels), dock toggle, "Feed properties" opens settings.
- Server-side-only items (Archive/Annotated/Web pages/Uploads, Rules/Filters/Spotlights/Email digests, Plans/Invite friends) render **inert** with tooltips — visible for 1:1 chrome, honest about being unavailable offline.

**Out of scope** (cannot exist as static files, or explicitly unwanted): accounts/auth, real notification/rule/dashboard backends, tags, notes, keyboard shortcuts, AI summaries, translations, OPML import/export UI (the one-time import was done by the agent from the user's export), timezone pickers, popularity scores, custom CSS.

Smoke test: `node scripts/smoke.mjs` boots the real `index.html` + `app.js` in jsdom against **deterministic in-memory fixtures** (the real feed list is 59 YouTube feeds — disk data would make tests slow/network-dependent) and asserts chrome, filters, scopes, layouts, star/Saved flow, panels, menus, and interactions (**29+ assertions**, all passing).

## Generated

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
- 2026-10-22 (20): Fetcher now writes consolidated data/all-feeds.json so the frontend loads one file. Smoke 20/20 passing. Smoke still 29/29 passing.
- 2026-10-22 (3): 1:1 chrome rebuild from the capture's real DOM: rail became a module switcher (removing the duplicated Today/Newsfeed/Unread/Read second nav — user complaint), sidebar panels (Feeds/Saved/Automate/Profile/placeholders), header title dropdown + ⋯ menu now owns the article-list status (All/Unread/Today/Recently read), star/read-later + Saved tab added, config.json rebuilt from the user's OPML export (6 folders/59 feeds), workflow gained a `push` trigger so their CI/CD deploys on push, smoke rewritten to deterministic fixtures (75 assertions, all passing).
- 2026-10-22 (2): Inoreader-parity pass from the real reader capture + help center: 5 layouts, density, sort toggle, badge-click mark-read, undo toast, sidebar options menu, scroll tracking, X hide-button (34→45 assertions as chrome evolved).
- 2026-10-22: initial build. Fetcher: rss-parser + jsdom/readability + sanitize-html. UI: single `assets/app.js`, vanilla ES2020. Data: `data/index.json` + `data/feeds/<id>.json`. Publishing: workflow force-pushes assembled `_site/` to `gh-pages`; default branch has no CI commits and ignores `data/`, `node_modules/`, `_site/`.
