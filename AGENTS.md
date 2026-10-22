# AGENTS.md — GitHub-Actions RSS Reader ("Inoreader on Pages")

A self-hosted, serverless RSS reader modeled on Inoreader.

> **Maintenance rule for agents:** this file must stay truthful. Whenever you
> change behavior, schemas, file layout or scope, update the relevant section
> here in the same commit — and when you find stale/outdated text (old schemas,
> removed features, superseded conventions), **clean it up rather than
> appending contradictions**. Prefer rewriting a section over adding caveats.
> The "Generated" section at the bottom records the last meaningful refresh.

## Architecture

- **Fetching backend**: GitHub Actions (`.github/workflows/fetch.yml`) runs **hourly** (`cron: '0 * * * *'` + `workflow_dispatch`). It runs `scripts/fetch.mjs`, which downloads every feed in `config.json`, extracts optional full-text, applies retention, and writes static JSON into `data/`.
- **Publishing**: the same workflow assembles the site (`index.html`, `assets/`, `config.json`, `data/`) into `_site/` and **force-pushes it to the `gh-pages` branch**. GitHub Pages serves from `gh-pages` branch root. The default branch stays clean: source only, no data commits, no node artifacts.
- **UI**: pure static site served by **GitHub Pages** (`index.html`, `assets/styles.css`, `assets/app.js`). No build step, no framework, no npm deps on the client.
- **Never commit**: `node_modules/`, `_site/` (both in .gitignore). `package.json`/`package-lock.json` ARE committed (CI needs `npm ci`).
- **Config**: a single `config.json` at repo root is the *entire* configuration: UI settings, folders, feeds, and **content filters** (inclusion + exclusion). Users edit it via the GitHub web editor.
- **Read/unread state**: `localStorage` only (per browser/device). Articles are **never auto-pruned while unread** — an article stays unread until the user reads or marks it. Read articles are eventually pruned by `settings.retentionDays` at fetch time.

There is deliberately **no server, no database, no auth, no token**. Anything that cannot work as static files + GitHub Actions is out of scope.

## Directory layout

```
config.json            # THE config: settings + folders + feeds + filters (user-edited)
data/index.json        # generated locally/CI: per-feed metadata/counts, generatedAt timestamp
data/feeds/<feedId>.json  # generated: { articles: [...] } newest-first
assets/app.js          # entire UI logic (single file, plain ES2020, no modules)
assets/styles.css      # Inoreader-like styling, light+dark themes
index.html             # UI shell
scripts/fetch.mjs      # fetcher/extracter run by Actions (Node >= 20, ESM)
scripts/smoke.mjs      # jsdom smoke test of the UI against local data (npm run test:ui)
.github/workflows/fetch.yml  # hourly fetch + publish to gh-pages
package.json           # fetch-script deps only (rss-parser, jsdom, @mozilla/readability, sanitize-html)
```

## config.json schema

```jsonc
{
  "settings": {
    "siteName": "My Inoreader",
    "theme": "auto",              // auto | light | dark (client default; user toggle overrides in localStorage)
    "view": "list",               // list | compact | cards
    "articlesPerFeed": 200,       // max articles kept per feed in data/
    "retentionDays": 90,          // read articles older than this are pruned at fetch; UNREAD is never pruned
    "keepUnreadForever": true,    // unread articles survive retention
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
- The UI always reads filters from `config.json` (never baked into data/), so filter edits take effect without waiting for a refetch. The fetcher only records `data/index.json` counts on *filtered-out* articles being kept (counts are computed client-side from local read state).

## data/ schemas (generated — never hand-edit)

`data/index.json`:
```json
{ "generatedAt": 1730000000000, "feeds": {
  "hacker-news": { "title": "Hacker News", "site": "...", "folder": "tech", "count": 200, "newest": 1730000000000 }
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
- Read state lives in localStorage under namespace `ghrss:` (`ghrss:read` = {id: timestamp}, `ghrss:ui` = UI prefs). Article ids must be stable or read state is lost.
- The publish commit on `gh-pages` uses `[skip ci]` and `github-actions[bot]` identity. Fetch failures for one feed must not fail the run (log + continue). The default branch gets **no** CI commits.
- Node >= 20 (global fetch). Fetcher must be idempotent and CI-friendly: no interactivity, exit 0 on partial failure, cap text-extraction fetches (~20 newest unextracted per feed per run).

## Feature scope (decided with the user — do NOT add without asking)

In scope: folders, unread counts, read/unread persistence (localStorage, unread kept forever), **all five Inoreader layouts (list/expanded/column/card/magazine)** + list density (comfort/compact/ultra) + newest/oldest sort (help-proven parity: inoreader.com/help/basic/article-view), search with operators (`feed:`, `title:`, `before:`, `after:`, `unread:`, `is:read`) + OR groups, date filters, config-driven include/exclude filters, text-view extraction with embeds, dark/light/auto theme, mark-all-as-read / mark-unread / keep-unread, **mark-read with Undo toast**, **click a sidebar unread badge → mark that feed/folder read**, sidebar options (show updated only, dim read subscriptions, sort A–Z), row "mark as read and hide" (X) button, opt-in scroll-tracking mark-read, per-feed refresh, subscription stats, retention config, settings panel linking to config.json editor.

Note: parity items were verified against the user's saved real-reader page (Desktop HTML capture) and inoreader.com help/preferences payloads — keep AGENTS.md aligned with that reality.

**Out of scope (explicitly rejected)**: stars/favorites, read-later, OPML import/export (config JSON is the substitute), tags, automation rules beyond filters, keyboard shortcuts, article notes/highlights-by-selection, desktop notifications, accounts/auth/tokens, newsletter ingestion, AI summaries, keyword-monitoring feeds.

## IN PROGRESS (parity port from the user's saved real-reader capture — 2026-10-22, user napping, full port authorized)

Source material on the user's Desktop (OUTSIDE the project — do not delete):
- `(81) Inoreader - The FBI just arrested...html` — saved real Inoreader reader page, full DOM (sidebar `#tree`, `#reader_pane`, `#top_tabs`, toolbar) + embedded preferences JSON blob (starts ~byte 91679, key `article_listing` etc.)
- `..._files/` — their real assets: `main_6VYi.css` (1.6MB theme CSS), `base_6VYi.css` (206KB), `index_js_6VYi.js`, `article_skeleton_6VYi.js`, …
- `1790938239967.gif` — screen recording (cannot be viewed by agent)

### Confirmed design tokens (ported or to port)
- Primary blue **#1875F3** (`--primary-color`, `.text-primary`), darker #0952b5, lighter #61a0f7 — OUR `--accent` should become this (currently #4a90d9)
- Font **Roboto, sans-serif** (+ Public Sans somewhere); headings dark navy **#081425 / #1a2433 / #31415d**; secondary gray **#828d9d**; light bg **#f3f4f7 / #F1F5FA**; borders **#D9DDE6**
- Sidebar width **310px** (we use 264); reader content max ~870px (ours 860 ✓)
- `.tree_unread { font-weight:bold }` ✓ we have; `.article_title_link{font-weight:bold}` + underline on hover; article titles `-webkit-line-clamp: 2/3`; READ articles show header buttons/date at **opacity 0.6** (unread full)
- Reader typography: `.article-content h1 1.5rem`, `h2 1.3rem`
- Top tabs (left rail): Home, Dashboards, Feeds (badge), Saved, Automate, Search, Add content, Preferences, profile — ours covers reader subset by design (dashboards/saved/automate out of scope)

### PORTED — FULL PAGE STRUCTURE REBUILD (2026-10-22 late)
index.html + styles.css were rewritten to mirror their real DOM skeleton exactly:
`#wraper > #side-nav(#tabs_pane rail 72px with .tab-item icon tiles + active tile bg #597fb8, #tree_pane 310px: sidebar-head Feeds + #subscriptions_fieldset with STATIC system rows Today/Newsfeed/Unread/Read + #tree folders, #sidebar_resizer drag) > #content-wrapper(#header_pane sticky 50px: heading-title + .section_count_badge, expanding search icon→field, .btn-heading split mark-all ✓|▾, ⋯ #header-menu holding status/date/sort/view controls; #reader_pane).`
**List view rows are single-line per their view_style_0 anatomy**: `[dot][favicon+feed col (flex 2 5 130px)][bold title][muted inline excerpt][date right]` — this was the big look-mismatch before (we had 3-line stacked rows). Test selectors updated: system rows live outside `#tree` (badge assertions unscoped), +4 new assertions (45 total).

### PORTED — design tokens (styles.css tokens verified against their real CSS)
Primary **#1875F3** (+darker #0952b5/#lighter #61a0f7), Roboto via Google Fonts, sidebar **310px**, secondary **#828d9d**, bg-hover **#f3f4f7**, border **#d9dde6**, headings **#081425/#1a2433**, 2-line title clamp + underline-on-hover, read rows dim metadata to .65, reader h1 1.5rem/h2 1.3rem, --list-max 870px. `--sidebar-w`, `--title-size`, `--font` vars.

### PORTED — features (41 smoke assertions passing)
5 layouts + density + sort newest/oldest; badge-click mark-read + Undo toast; sidebar ⋯ menu (updated-only/dim-read/sort A–Z); X "mark as read and hide"; scroll tracking; titles-only; open-original mode; feed-icons toggle; column thumbnails toggle; **bulk multi-select + bulk bar (read/unread/undo)**; auto-scroll opened article; absolute dates; title font-size select; compact sidebar; sidebar favicons toggle; clickable-counters toggle; **tab title unread counter**; attachments/enclosures list in reader; mark-all confirm. Migration: old `layout:'compact'` → list+density-compact.

### Do NOT port (user rejected): stars/read-later/tags/notes/rules/shortcuts/notifications/OPML; out of scope: dashboards, teams, AI, translations, TTS, image proxy, popularity scores, monitoring feeds, newsletters, timezone/date-format pickers, magic sort, custom CSS.

Full prefs inventory saved at /tmp/inoreader_pref_pairs + /tmp/inoreader_prefs.json (ephemeral — re-extract from the Desktop capture if gone).

## Generated

- 2026-10-22 (2): Inoreader-parity pass driven by scraping the real reader (user's saved Desktop page + help center): 5 layouts, density, sort toggle, badge-click mark-read, undo toast, sidebar options menu, scroll tracking, X hide-button. Smoke test extended to 34 assertions, all passing.
- 2026-10-22: initial build. Fetcher: rss-parser + jsdom/readability + sanitize-html. UI: single `assets/app.js` (~700 lines), vanilla. Data: `data/index.json` + `data/feeds/<id>.json`. Publishing: workflow force-pushes assembled `_site/` to `gh-pages` (Pages source); default branch has no CI commits and ignores `data/`, `node_modules/`, `_site/`. Multi-folder feeds (`folders: []`) and per-folder `maxAgeDays` added after scraping inoreader.com for parity. Smoke test: `npm run test:ui` (21 assertions, all passing).
