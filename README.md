# rssfeed

A serverless RSS reader that lives entirely on GitHub Pages. A GitHub Actions workflow fetches your feeds on a schedule, applies your filters server-side, and publishes the results as plain JSON; the static web app reads that JSON and does everything else — folders, unread tracking, reading — in your browser. No server, no database, no cost.

## How it works

```
config.json ──► GitHub Action (every 15 min) ──► data/*.json on the gh-pages branch
                                                        │
                                             GitHub Pages serves it all
                                                        │
                                        your browser (read state in localStorage)
```

- `scripts/fetch.mjs` runs in CI, downloads every feed, extracts and sanitizes articles, and commits the results to `gh-pages`.
- `index.html` + `assets/` is the reader. It polls for fresh data on its own schedule.
- Your read/unread state, kept articles, and UI preferences live in your browser's `localStorage` — clearing site data resets your reading progress, nothing else.

## Features

- **Folders and feeds** — organize sources into folders; unread badges per feed, folder, and everywhere. Click the ⓘ beside a feed's title for its card: website, raw feed URL, folder, last post, last crawl, and counts.
- **Zero-maintenance feed entries** — most feeds only need their URL and a folder; the fetcher derives the id and pulls the title, site link, and image from the feed itself. Everything is still overridable in `config.json`.
- **Solid read/unread** — opening an article marks it read; the row tick and keyboard shortcuts flip it back. "Mark as read" / "Mark as unread" work per folder, per feed, or globally — everything, or articles from the last 1–30 days — with Undo.
- **Filters, server-side** — rules that hide, highlight, auto-mark-read, or keep-unread matching articles at fetch time, scoped to specific feeds or folders, matching on title, content, subject, capcode, author, or link with plain words or regex. Hidden articles never reach the browser; the other actions ship as per-article flags.
- **Full text extraction** — optionally fetch and store the article's own text instead of the feed's teaser.
- **Beyond RSS** — YouTube channel feeds (Shorts dropped by default), Hacker News by points/comments, and 4chan boards by reply count.
- **Resizable reading layout** — drag the divider between the list and the article to suit your screen (double-click resets it); the sidebar resizes too.
- **Shareable links** — every view has a URL (see below).
- **Keyboard shortcuts** — `j`/`k` to move through articles, `m` to toggle read, `o`/`v` to open the original, `s` to keep unread, `/` to search, `Esc` to dismiss.
- **Dark mode** — auto, light, or dark; respects the system preference by default.
- **Fast at scale** — progressive list rendering, consolidated data loading, conditional HTTP in CI so unchanged feeds cost nothing.

## Shareable links

The URL hash is a real link you can send to anyone (or bookmark):

| Link | Opens |
|---|---|
| `/#folder/Japslop` | A folder |
| `/#feed/Abroad%20in%20Japan` | A single feed |
| `/#article/fd9b015ffd545e20` | One article, reader open |

Name matching is forgiving: `#folder/japslop`, `#folder/Japslop`, and `#folder/japslop` (with spaces, slugs, or neither) all resolve. Clicking around updates the URL; the browser's back/forward buttons move through your reading history.

## Quick start

1. **Fork or clone this repo.**
2. **Edit `config.json`** — set a site name, add folders, and paste in the feeds you follow. See [CONFIGURATION.md](CONFIGURATION.md) for every option.
3. **Enable GitHub Pages** — Settings → Pages → Source: `gh-pages` branch. (The workflow creates and maintains this branch for you.)
4. **Run the workflow** — Actions → "Fetch feeds & publish" → Run workflow. The first run publishes the site; from then on the workflow checks in every 15 minutes and fetches whenever the published data is more than 40 minutes old (and on every push to `main`).

That's it — your reader is live at `https://<you>.github.io/rssfeed/`.

## Local development

```sh
npm install
npm run fetch      # fetch all feeds into data/ (needs Node 22.22+ or 24+)
npm run serve      # serve the site at http://localhost:8080
npm run test:ui    # 470+ browser-environment assertions (jsdom)
npm run test:char  # characterization pins for known behavior
npm run test:sec   # client-boundary security assertions
npm run test:e2e   # fetcher end-to-end: id stability, conditional GET, backend filters, purge
npm test           # all of the above
```

CI keeps the scheduled fetch workflow lean (no test steps — it only fetches and publishes). The full suite runs in the separate **"Tests (manual)"** workflow, triggered by hand from the Actions tab whenever you want it.

`data/` is generated output — it is committed by CI, not by you.

## Configuration

Everything lives in `config.json` (plus an optional `feeds.opml` import). The full reference — every setting, feed type, and filter option — is in [CONFIGURATION.md](CONFIGURATION.md).
