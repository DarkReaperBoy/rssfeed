# Configuration reference

Everything is configured in **`config.json`** at the repo root. Optionally, a **`feeds.opml`** file (standard OPML export from any other reader) sits next to it and is merged in at fetch time. All of it is static — no server, no admin panel.

```json
{
  "settings": { "siteName": "My RSSFeed" },
  "folders": [{ "id": "tech-news", "name": "Tech News" }],
  "feeds": [ /* one object per source, see below */ ],
  "filters": [ /* global rules, see below */ ]
}
```

Changes take effect on the next workflow run (push to `main` or the scheduled run) or the next local `npm run fetch`.

---

## `settings`

| Option | Default | What it does |
|---|---|---|
| `siteName` | `"My RSSFeed"` | The site header and browser-tab title. |
| `theme` | `"auto"` | `"auto"` follows the system preference; `"light"` and `"dark"` force one. Each visitor can still switch it in the UI. |
| `retentionDays` | `60` | How many days of articles to keep. Older articles are dropped from the data files on every fetch. |
| `refreshMinutes` | `5` | How often the browser app polls for new data while you're reading. The CI fetch itself runs on its own schedule. |
| `fullTextDefault` | `false` | When `true`, the fetcher visits each article's page and extracts the full text instead of keeping the feed's teaser. Per-feed override: `fullText` on the feed. |
| `dropShorts` | `true` | When `true`, YouTube Shorts are dropped from YouTube feeds. Per-feed override: `dropShorts` on the feed. |

Two things are intentionally **not** configurable anymore:

- **Marking articles read when you open them** — always on; it's the app's core behavior.
- **The list layout** — there is exactly one view (list).

---

## `folders`

```json
{ "id": "tech-news", "name": "Tech News" }
```

- `id` — slug, used by feeds and filters to reference the folder. Never change it casually: filters and shared `#folder/` links key off the name, the id is the fallback.
- `name` — shown in the sidebar and used in shareable links (`/#folder/Tech News`).

Feeds that reference a folder that doesn't exist still render — they appear as loose feeds below the folders.

---

## `feeds`

Every feed is an object in the `feeds` array. Four kinds are supported.

### RSS / Atom / YouTube

```json
{
  "id": "the-verge",
  "title": "The Verge",
  "url": "https://www.theverge.com/rss/index.xml",
  "site": "https://www.theverge.com",
  "folder": "tech-news",
  "enabled": true
}
```

| Option | Required | What it does |
|---|---|---|
| `id` | ✔ | Stable slug. The feed's data file and article identity are derived from it — renaming it later resets read state for that feed's articles. |
| `url` | ✔ | The feed URL. For **YouTube channels**, use `https://www.youtube.com/feeds/videos.xml?channel_id=…` (the channel's RSS). |
| `title` | — | Display name. Falls back to the feed's own title. |
| `site` | — | The human site, used for the favicon and links. |
| `folder` | — | One folder id. For multiple folders, use `folders: ["a", "b"]` instead. |
| `enabled` | — | `false` pauses the feed: nothing is fetched, existing articles are kept until retention ages them out, and the sidebar shows it as disabled. |
| `fullText` | — | Per-feed override of `settings.fullTextDefault`. |
| `dropShorts` | — | Per-feed override of `settings.dropShorts` (YouTube only). |
| `filter` | — | Per-feed word filter, applied **at fetch time** so junk never reaches the data files. See [Filter syntax](#filter-syntax); only `include`/`exclude` apply (no actions). |

Removing a feed from the config deletes its data file on the next run.

### Hacker News

```json
{
  "id": "hacker-news",
  "type": "hackernews",
  "title": "Hacker News",
  "site": "https://news.ycombinator.com/",
  "folder": "tech-news",
  "minPoints": 150,
  "minComments": 100
}
```

| Option | What it does |
|---|---|
| `type` | `"hackernews"` or `"hn"`. |
| `minPoints` | Only stories with at least this many points. |
| `minComments` | Only stories with at least this many comments. |

With neither cap set, it follows the HN front page. With one or both set, it pulls everything within the retention window that clears the bar(s), paging past Algolia's response cap.

### 4chan boards

```json
{
  "id": "g",
  "type": "4chan",
  "title": "/g/ - Technology",
  "board": "g",
  "folder": "tech-news",
  "minReplies": 300
}
```

| Option | What it does |
|---|---|
| `type` | `"4chan"`. |
| `board` | Board name without slashes, e.g. `"g"`. Validated against 4chan's board list — a typo keeps the old threads and flags the feed in the sidebar. |
| `minReplies` / `maxReplies` | Keep threads with at least / at most this many replies. |
| `minImages` / `maxImages` | Same window on the thread's image count. |
| `maxThreads` | Cap the number of stored threads (newest first). Omit for no cap. |

Two rules are baked in and not configurable: **sticky threads are always skipped** (they're the pinned rules/announcement posts, not content) and **closed threads are always included** (an archived thread that made the cut is still worth reading — it's finished, not junk).

Threads are live: what's on the board is what you get, retention trims the rest.

---

## `filters` (global rules)

Applied **in the browser** at load time. They can hide articles, highlight them, auto-mark them read, or protect them from ever being auto-marked.

```json
{
  "id": "no-ai-hype",
  "name": "No AI hype",
  "feeds": ["tech-news"],
  "enabled": true,
  "exclude": { "title": ["AI", "/^(chat)?gpt/i"] },
  "actions": { "hide": true }
}
```

| Option | What it does |
|---|---|
| `id` | Stable identifier. |
| `name` | Shown in the UI's filtered-articles note. |
| `feeds` | Scope: a list of feed ids, folder ids, or `["*"]` for everything. Omit for all feeds. |
| `enabled` | `false` disables the rule without deleting it. |
| `include` | Keep/match only articles matching this block (see syntax below). Omit to match everything. |
| `exclude` | Drop (or exempt) articles matching this block. |
| `actions` | What happens on a match. **Omit it entirely and matching articles are hidden** (a bare filter is a hide rule). If you provide `actions` at all, unset actions default to `false`. |

`actions`:

| Action | Effect |
|---|---|
| `hide` | The article is filtered out of the list (visible only via "show filtered" in the menu). |
| `markRead` | The article is marked read automatically, the moment it loads. |
| `keepUnread` | The article can never be auto-marked — your manual read/unread is also protected from mass operations. |
| `highlight` | The row gets a tinted highlight. |

Matching logic: **within one field, any matcher hit counts (OR); across fields, every field must hit (AND)**. An article is a match when it passes `include` (or no include is set) and doesn't hit `exclude`.

### Filter syntax

```json
"exclude": {
  "title": [" sponsored", "/^AD:/i" ],
  "content": ["crypto airdrop"],
  "authors": ["Content Farm"],
  "links": ["track.example.com"]
}
```

- Each key takes an array of matchers, applied to that field (`content` also covers the summary and extracted text; `links` covers enclosure URLs).
- A matcher is either a **plain substring** (case-insensitive) or a **regex** written as a string starting and ending with `/` plus optional flags: `"/\\biphone\\s?1[0-9]\\b/i"`.
- `include` blocks accept the same shape; a field that lists matchers **requires** that field to match, so use only what you need.
- Global filters use `authors`/`links`; per-feed `filter` accepts `author`/`link` too.

### Per-feed `filter` vs global `filters`

Use the per-feed `filter` when the junk shouldn't even be stored (it never reaches the browser). Use global `filters` when the rule is about *presentation* — highlighting, auto-read, keep-unread — or when you want to toggle it without a CI run.

---

## `feeds.opml` (optional)

Drop a standard OPML export in the repo root and it's merged with `config.json` at fetch time: OPML feeds that share an id or URL with a configured feed inherit the config's settings (folders, filters); everything else is added as-is with OPML folder nesting preserved. Feeds that exist only in `config.json` are kept. Delete the file to stop importing.

---

## URL deep links

For sharing and bookmarking — matching is case-insensitive and ignores spacing/punctuation differences:

| URL | Resolves to |
|---|---|
| `/#folder/Japslop` | The folder — `#folder/japslop` and `#folder/japslop` (any spacing) work too. |
| `/#feed/Abroad in Japan` | The feed — `#feed/abroad-in-japan` and `#feed/abroadinjapan` both work. |
| `/#article/fd9b015ffd545e20` | One article with the reader open. |

An unrecognized `#folder/…` or `#feed/…` name clears itself and tells you it didn't match; the reader still opens normally.

---

## What's generated, what's yours

| Path | Role |
|---|---|
| `config.json`, `feeds.opml`, `README.md`, this file | Yours. Edit freely. |
| `index.html`, `assets/`, `scripts/` | The app. |
| `data/` | Generated by the fetcher — committed by CI, never edited by hand. |
| `gh-pages` branch | The published site — rebuilt by the workflow, never touched directly. |
