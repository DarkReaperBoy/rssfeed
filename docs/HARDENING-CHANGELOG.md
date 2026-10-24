# Production-hardening changelog

Baseline: `main @ d3682d6`. Every change below landed as one atomic commit with the full test suite green before and after. The suite grew from 414 assertions (401 UI + 13 e2e) to **460** across four suites: `test:ui` (behavior contract), `test:char` (known-behavior pins), `test:sec` (client boundary security), `test:e2e` (fetcher end-to-end).

Run everything with `npm test`.

---

## Phase 0 — Recon (read-only)

**Deliverable**: full map, journey list, and risk register (worklog). No code changes.
**Verify**: read `docs/GUI-CHECKLIST.md` (produced in Phase 1 from this map) — it enumerates every critical journey the later phases tested.

---

## Phase 1 — Safety net

| Commit | Change | Verify |
|---|---|---|
| `09a099c` | `scripts/characterization.mjs` — 27 pins for behavior the 401-assertion suite didn't cover: deep-links to already-read articles (sorted position both ends), unknown `#article` self-heal, keyboard `o`/`v`/`/`, `j`/`k` clamping, text-selection click guard, cross-tab storage sync (read-map replacement + filters not re-running), pre-2000/empty date-picker no-ops, triple-confirm lands once, folder-cutoff deep-link append corner. All quirky edges are marked `KNOWN:`. | `npm run test:char` → 27 passed |
| `09a099c` | `package.json` — `test:char` + aggregate `npm test`. | `npm test` runs all suites in order |
| `09a099c` | `.github/workflows/fetch.yml` — characterization step added to CI. | CI log shows the step before fetch |
| `09a099c` | `docs/GUI-CHECKLIST.md` — the browser checklist used for the final verification walk. | manual, per section |

---

## Phase 2 — Correctness (bugs only)

Sweeps run per lens: logic → races → async → unhandled rejections → error swallowing → edge cases → memory leaks. Findings above cosmetic severity: two. Both fixed failing-test-first. A chaos probe (rapid read/unread spam, j/k spam, menu toggles, scope/search churn, flaky refresh, hash churn) captured zero errors; an adversarial fetcher probe (malformed XML, NULs, control chars, 3000-char titles, duplicate guids, script/onerror/javascript: payloads) found the title issue and confirmed the sanitizer is airtight.

| Commit | Change | Verify |
|---|---|---|
| `aaf0ea8` | **Doc-vs-code contradiction**: `CONFIGURATION.md` claimed filter `actions` "all default to false" — code hides when `actions` is omitted entirely (verified with a jsdom probe). Doc corrected; code behavior kept (a bare filter is a hide rule). | Read the filter table; cross-check with a filter that has no `actions` key |
| `39b9d09` | **Unbounded RSS titles at ingest**: 4chan (140) and HN (200) titles were capped, RSS titles weren't — a 3000-char title stored verbatim. New exported `pickTitle()` caps at 300, used at ingest. | `npm run test:ui` → "RSS titles are capped at ingest" section (5 assertions); re-run the adversarial feed from the commit message if desired |

Reviewed and accepted-as-designed (each pinned or pathological, documented in the worklog): `keepVisible.clear()` on bulk ops; cross-tab storage sync replaces the read map wholesale; folder-cutoff deep-link append; indistinguishable-item id collision (id stability wins).

---

## Phase 3 — Prune & dependencies

| Commit | Change | Verify |
|---|---|---|
| `b3e92aa` | Dead code removed after whole-codebase usage analysis: the `.row-body-inline` guard in `onListClick` (that class is generated nowhere — rowHtml/index.html/styles.css checked) and a dead identity wrapper in the characterization suite. All 19 SVG symbols and all CSS density classes verified alive and left alone. | `rg row-body-body-inline` → only historical; suite green |
| `d731d66` | **Dependencies to latest** (rule 9): jsdom 24.1.3→**30.1.3**, sanitize-html 2.13.0→**2.18.1**, @mozilla/readability 0.5.0→**0.6.0**, rss-parser 3.13.0 (already latest). `npm outdated` now empty; 0 vulnerabilities. `engines` → `>=22.22.2` (jsdom 30 requirement), README node note synced. Full-text extraction (Readability+JSDOM path not covered by e2e) verified via a local HTTP sandbox before committing. | `npm outdated` → empty; `npm test`; `npm ls --depth=0` |

---

## Phase 4 — Performance (measured, not guessed)

Profiled at production scale in jsdom: 55 feeds / 4090 articles (mirrors the live dataset incl. the 1390-article HN feed).

| Metric (jsdom) | Before | After |
|---|---|---|
| Single row click → open + mark-read | 98.0 ms | **38.9 ms** |
| `j` keyboard navigation | 124.9 ms | **38.7 ms** |
| `renderList` cost inside the open path | 79.9 ms | **0 ms** |

| Commit | Change | Verify |
|---|---|---|
| `89d8636` | `openArticle` now patches in place (prev-row `.expanded` removal, keyed reader render, the existing `markRow`/`patchTreeCounts` patch path) instead of rebuilding the whole 150-row list. A full `renderList` remains as fallback when the row isn't in the DOM (read-article deep-link corner — first run was caught by exactly those characterization pins). Shared `rowEl(id)` helper extracted for `patchRow`/`listScrollTo`/`openArticle`. | `npm run test:char` (deep-link pins still green); the numbers above re-measured with any jsdom harness at scale |

Rejected after measurement (marginal or not hot): `closeArticle` full render (~67 ms, once per session exit), mark-all (~90 ms, bulk), unread-count caching (state duplication for milliseconds), boot (network-bound; progressive rendering already in place), backend (no N+1 — one fetch per feed, conditional GET, 5-way concurrency + 4chan chain).

---

## Phase 5 — UI/UX & polish

Real-Chromium walk via agent-browser against fixture data (screenshots in the working notes): boot, reading flow, `j`/`k`/Escape, back/forward, mark-all + confirm + Undo, search, system dark mode, mobile drawer + scrim, favicon fallback. Zero page errors and zero console messages throughout.

| Commit | Change | Verify |
|---|---|---|
| `ac1e9e0` | **Favicon tile rendered beside every favicon** — `.favicon-tile { display:inline-flex }` defeated the `hidden` attribute, so the blue letter tile showed *next to* the favicon image in the sidebar and every row (32px icon block instead of 16px). Fix: `.favicon-tile[hidden] { display: none; }`. | DevTools: `.favicon-wrap` bounding width is 16px; block the s2 favicons URL → tile appears as fallback |
| `ac1e9e0` | **Accessible-name pollution** — the tile's letter text leaked into every row's accessible name ("AAlpha Tech"). Letter moved to `content: attr(data-initial)` — no text node at all; favicon wrapper additionally `aria-hidden`. Fallback-on-image-error verified by aborting favicon requests. | Accessibility tree / screen reader: row names read "Alpha Tech …", not "AAlpha Tech…" |
| `ac1e9e0` | `CONFIGURATION.md` claimed a per-visitor theme switcher in the UI — it was removed with the old Settings modal. Corrected: theme comes from config / system preference. | Read the settings table |

---

## Phase 6 — Security

Threat model: public static site — no auth or protected endpoints (authorization N/A), no cookies or writes (CSRF N/A), no secrets in code (registry-pattern scan clean; `GITHUB_TOKEN` only enters via Actions secrets). All external links carry `rel="noopener noreferrer"` (grep-verified zero exceptions). Server-side layers re-verified: sanitize-html allowlist (adversarial payloads all stripped), JSDOM extraction with `runScripts: 'outside-only'`, https-only enclosure ingest, 5 MB / 25 s bounds.

| Commit | Change | Verify |
|---|---|---|
| `06acdd7` | **Client boundary hardening (tampered-data defense-in-depth)** — failing probe first: a `javascript:` enclosure href rendered clickable in the reader; a `data:` URL rendered as a row thumbnail. Fixed: attachment hrefs go through `safeHref` (degrades to `#`, the pinned contract for hostile links) and `thumbFor` validates the scheme (`stripCtrl` + https-only) before returning. | `npm run test:sec` → "client boundaries clean" |
| `06acdd7` | **Strict CSP** — `default-src 'none'`; scripts: `'self'` + the SHA-256 hash of the inline theme boot script; styles: `'self' 'unsafe-inline'` (style attributes only); images http/https/data; `connect-src 'self'`; media http/https; frames limited to the three embed hosts; `base-uri`/`form-action`/`object-src 'none'`. Verified live: zero console violations, hashed script executes, YouTube facade → iframe loads under `frame-src`. | Load the site with DevTools open — no CSP violations; click a YouTube facade — the embed loads |
| `0f40350` | Security suite wired permanently into `npm test` + CI. | CI runs four test steps before fetch |

---

## Phase 7 — Full verification

- `npm test`: **407 + 27 + sec + 13 — zero failures** (460 assertions).
- Real-browser walk per `docs/GUI-CHECKLIST.md`: boot (clean console), reading flow, rapid 4-click toggle (never wedges), back/forward spam (hash history exact), reload mid-flow, offline/degraded data (previous articles stay on screen, "offline — showing last data", recovery on retry), mark-all ⇄ mark-all-unread with confirm dialogs and Undo, badge tick, keyboard `j`, caught-up empty state, mobile 390×844 (drawer + scrim, article-pane takeover, Escape returns), favicon failure fallback, dark mode via system preference. **Zero page errors, zero console messages across the entire walk.**

---

## Post-hardening UI change — mark-menu redesign (single direction + age slider)

User-driven change after the eight-phase pass: the ▾ mark menu offered **both** directions at once (preset group + a "Mark as unread by time" expander), and day selection was a preset list plus "Before…/Since…" calendar pickers. Both replaced.

| Commit | Change | Verify |
|---|---|---|
| ``ec683d4`` | **One action at a time.** `#mark-alt-toggle`, `#mark-group-read`, `#mark-group-unread`, the four age presets per direction, and both date pickers are gone. The menu (and the header ✓-button) offer mark-as-read while unread articles exist, and mark-as-unread only when caught up. | `npm run test:ui` → "mark-all split: the age slider" section: `the inverse-direction expander is gone`, `the dual preset groups are gone`, direction flips pinned in both states |
| ``ec683d4`` | **1–30 day slider + Apply.** The ▾ menu now shows a sentence ("Articles older than N days" / "Read articles from the last N days"), a labeled range slider (`aria-valuetext` live), tick scale, an exact count preview ("Will mark N articles" / "Nothing to mark here"), and a direction-named Apply button. The last-used value persists (`ui.markAgeDays`, saved on drag release). In the Today scope the ▾ split button hides (age marking is structurally dead there — every article is from today). | `npm run test:ui` → slider/apply/undo/persistence/Today sections; `npm run test:char` → "the mark-age slider remembers the last dragged value" (incl. rapid 31-event drag spam) |
| ``ec683d4`` | **Count preview is a sorted-timestamps binary search.** Candidates are collected once per menu open via the existing collectors (`collectScopeIds`/`collectScopeReadIds`, cutoff 0 — single source of truth, no duplicated predicates), timestamps sorted, then each input event answers via O(log N) binary search. At production scale (55 feeds / 4090 articles): menu open 3.3 ms mean, input event 0.07 ms mean (200-event drag burst 7.3 ms total), preview count exactly matches brute-force at 1/3/7/14/30 days. A naive O(N) recount per drag event would cost ~1.5 ms × every tick (~45 ms per sweep) — 20× worse. | Bench harness mirrors Phase-4 scale; rerun with any jsdom harness at `data/` scale |
| ``ec683d4`` | **Dead plumbing pruned.** `beforeTs` parameter removed from `applyMark`/`markScopeRead`/`markScopeUnread`/`cutoffFrom`/`describeCutoff` (the calendar was its only caller); `OLDER_LABELS['31']` dropped (30 is the slider max); `.mark-alt-toggle`/`.mark-custom`/`.dropdown-mark .dropdown-item` CSS removed with the markup that used it. | `rg 'beforeTs\|mark-alt\|mark-custom\|data-older' assets/` → no hits; suite green |

**Behavior notes (intentional trade-offs of "one direction at a time"):**
- Running an *unread-direction* window while NOT caught up (previously reachable via the expander / hidden-group clicks) is no longer offered — the restore direction appears once the scope is caught up. All window semantics (publication clock, boundary hints, Undo, hidden-by-search companion) are unchanged and still pinned.
- The unread-side zero-result toast with a *boundary clause* is now only reachable in exotic races (it previously fired via hidden-group clicks in a zero-read state); the honest in-window variant is pinned instead ("No read articles from 30 days ago here").

**Verify the whole change:**
```sh
npm test
```
Then serve and walk the "Mark operations" section of `docs/GUI-CHECKLIST.md` — drag the slider (mouse or arrow keys), watch the count preview, Apply, Undo, mark everything read and check the direction flips.

---

## Post-hardening UI change #2 — zero-maintenance feeds, info card, minimal menu, resizable panes

User-driven change after the mark-menu redesign: config entries should need **only a URL and a folder** (id/title/site derived by the fetcher), every feed deserves an **information card** beside its title, the ⋯ menu sheds three dead weights (**Today**, **Recently read**, **Multiple select** — code and all), the **list⇄article divider** becomes draggable, and the keep-unread icon moves off the broken eye-off path to clean bookmark glyphs. Filters get an explicit working-verification pass (including the private-browsing / fresh-profile case).

| Commit | Change | Verify |
|---|---|---|
| (this) | **Backend derives what the config omits.** `id` is no longer required: it is derived stably from the URL (`yt-<channel id>` for YouTube feeds, `4chan-<board>` for boards, `hackernews` for HN, host+path slug otherwise; collisions get `-2` suffixes; an explicit config id always wins). `title` falls back to the feed's own `<title>`, `site` to the channel link, and the channel `<image>` is captured for the info card — each only when the config doesn't set it. `index.json` entries gain `xml` (raw feed URL), `origTitle` (the source's self-title, present only when the config renamed the feed), and `image`. | `npm run test:e2e` → runs 4–5: URL-derived data filename, title/site/xml from the feed, `origTitle` under rename, image capture, no trace of old ids |
| (this) | **Feed-id changes are read-state safe — and lossless.** Article ids are guid-keyed `stableId()` hashes with no feed-id component, so a config that drops explicit ids swaps feed files without touching article ids — pinned by e2e ("article ids survive the feed-id change"). When a feed's data file is missing under its current id, the fetcher first looks for a predecessor in the previous index — matched by the channel id inside a YouTube feed's old `site` URL, or by an exact `xml` match — and **adopts its articles and crawl status** (etag included, so conditional GET continues seamlessly). The 60-day history survives id renames and even a failed fetch on the transition run. Old data files for ids the config no longer names are wiped, and a directory sweep also removes orphan files with no config *and* no index entry (crashed-run leftovers). | `npm run test:e2e` → run 6 + "id-migration matchers": rename adopts all articles with identical ids, no false adoptions, a different channel never adopts; run 5: removed feed's file deleted, ghost file swept, index and all-feeds clean |
| (this) | **`config.json` minimized.** All 60 feed entries stripped to `{url, folder}` (HN keeps `type`+caps, 4chan keeps `board`+`minReplies`); display names now come from the sources themselves. New feed added to **Tech News**: `https://www.youtube.com/feeds/videos.xml?channel_id=UCgKePkWtPuF36bJy0n2cEMQ` (Jadi Mirmirani — the channel id as first pasted was 27 characters and 404s; the valid 24-char id sharing its 21-char prefix resolves to this channel). | `node -e "console.log(require('./config.json').feeds.length)"` → 61; first CI run re-keys data files under `yt-*` ids |
| (this) | **Feed information card.** A ⓘ button beside `#scope-title` (feed scopes only) opens a centered modal: pfp (feed image, else favicon/letter tile), name, "N articles · M unread", rows for **Original title** (only under a rename), **Website**, **XML address**, **Folder**, **Last post** (relative age or "Never"), **Last crawled** ("Success · age" / "Failed — error · age (last success …)" / "Disabled"), and a status dot. Closes via ✕, backdrop, or Esc; all links `target=_blank rel="noopener noreferrer"`. | `npm run test:ui` → "feed information modal" + "Last post reads Never" sections |
| (this) | **⋯ menu minimalism.** Today, Recently read, and Multiple select are gone — features *and* code: the two scopes (`scopeFilter`, the 7-day read window, all today/recently-read branches in the collectors/stats/sort/mark logic), the sidebar Today row, bulk-select mode (checkboxes, `#bulk-bar`, `bulkMark`, `state.bulkSel`), and the `#i-today`/`#i-bulk`/`#i-eyeoff` symbols. Remaining order: All articles, Unread, Show filtered-out, Refresh, Sort (Newest/Oldest), Reset read state. The `showToday` config key is dead and removed. | `npm run test:ui` → "header menus: minimal and reordered" section (structure + order pinned); `rg 'bulkSel\|recently-read\|pdinner_today\|i-eyeoff' assets/ index.html` → no hits |
| (this) | **Resizable list⇄article divider.** A 7px drag handle sits between `#list_pane` and `#article_pane` (`#reader_resizer`): pointer-drag sets `--list-w` (px) and lifts the 940px article cap (`--article-cap: none`), clamped to a 260px list minimum and a 320px article minimum (pane width measured once at drag start — no per-move layout reads). Persists in `ui.listW`, restores on boot (re-clamped to the viewport), double-click resets to the default 44/56 split, hidden below 1120px where the panes stack. | `npm run test:ui` → "resizable divider" section; browser walk in this entry's verification notes |
| (this) | **Keep-unread icon → bookmark glyphs.** The eye/eye-off pair (whose eye-off path rendered broken on some systems) is replaced by outline (`#i-bookmark`) / filled (`#i-bookmark-on`) bookmarks; aria-pressed and titles unchanged, `s` shortcut unchanged. `#i-eye` stays for "Show filtered-out articles". | `npm run test:ui` → "a kept article shows the FILLED bookmark glyph" |
| (this) | **Filters verified working — including the private-browsing case.** All four client-side actions pinned from a cold, empty profile (equivalent to a private window, since filters ship in `config.json` and apply before any state exists): hide (excluded rows vanish), highlight (only matches tint), markRead (auto-read at load), and **keepUnread — previously untested — guards its matches against both auto-marking and mark-on-open**. Per-feed fetch-time word filters were already pinned server-side. | `npm run test:ui` → "filter actions: keepUnread guards its matches (verified from a cold empty profile…)" + boot filter pins |

**Perf (jsdom, 55 feeds / 4090 articles / 1390-article feed):** info-modal open+close 3.3 ms mean (p95 3.6 ms — a one-off click action); divider drag 0.021 ms per pointermove (a 300-move sweep ≈ 6 ms total, <0.3% of a 60fps frame budget); no layout reads inside the drag loop. All Phase-4 hot paths untouched (row click, j/k, mark preview).

**Behavior notes (intentional trade-offs):**
- Feed **titles now follow the source**. If a channel renames itself, the sidebar follows on the next fetch; old `#feed/<old-title>` deep links self-clear with the standard toast (case/slug-forgiving matching still applies). A config `title` remains a hard override and enables the "Original title" row in the info card.
- Dropping the explicit ids from `config.json` re-keys every data file once (old files wiped, new `yt-*` files built). Read state and `#article/<id>` deep links survive untouched because article ids are guid-keyed; `#feed/<old-custom-title>` links follow the title rule above.
- Running **several Hacker News feeds** with different caps now requires explicit `id`s to tell them apart (single-HN setups derive `hackernews`).
- The mark menu's ▾ split button is now available in **every** scope (the Today scope that used to hide it no longer exists).

**Verify the whole change:**
```sh
npm test
```
Then serve any `data/` with `npm run serve` and walk the "Feed information card", "Mark operations", and divider items in `docs/GUI-CHECKLIST.md` — click a feed's ⓘ, drag the divider both ways, double-click it, reload, and confirm the split survives.

---

## How to verify the whole thing in one command

```sh
npm ci && npm test
```

and serve any generated `data/` with `npm run serve` and walk `docs/GUI-CHECKLIST.md`.
