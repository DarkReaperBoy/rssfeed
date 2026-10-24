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

## How to verify the whole thing in one command

```sh
npm ci && npm test
```

and serve any generated `data/` with `npm run serve` and walk `docs/GUI-CHECKLIST.md`.
