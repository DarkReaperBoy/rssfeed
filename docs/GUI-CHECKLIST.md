# Browser GUI verification checklist

Run against a local static serve of the working tree with generated fixture data (`npm run fetch` against a small config, or the published `data/`). Every check runs in Chrome, Firefox, and Safari where available, plus the mobile viewport (390×844) and a narrow desktop (1120px breakpoint). Console must stay error-free throughout.

## Boot & shell
- [ ] Fresh profile load: sidebar renders folders + feeds with unread badges; list opens oldest-first; title shows "(N) siteName".
- [ ] Reload with read state: badge reflects read articles; oldest sort preserved; no phantom unread.
- [ ] Offline load (DevTools → Offline): "You look offline" empty state; previously cached data still usable after reconnect + reload.
- [ ] No `data/` yet: "No data yet" empty state with the Actions hint.
- [ ] Theme: light, dark, auto — all three; system-preference switch flips auto live; no flash of wrong theme on reload (early script).
- [ ] Favicon failures (block s2 favicons via DevTools): fallback letter tiles appear, no broken-image icons.

## Reading flow
- [ ] Click a row: reader opens on the right; row marked read; badge/sidebar/title counters drop by one; URL becomes `#article/<id>`.
- [ ] Opened row stays in the list (highlighted); click again or Esc: reader closes, hash clears.
- [ ] j/k walk the list; clamps at both ends; prev/next buttons mirror them and disable at the ends.
- [ ] o or v: original opens in a new tab (popup allowed).
- [ ] m toggles read/unread on the open article; s toggles keep-unread (badge recounts).
- [ ] Rapid double-click a row: opens then closes; no stuck loading or duplicate toasts.
- [ ] Refresh mid-read (F5 with reader open): same article reopens from the hash, stays read.
- [ ] Back/forward through opened articles: reader follows; rapid back-forward spam stays consistent.
- [ ] Long article: scroll inside the reader; sticky toolbar; scroll-nav buttons appear only with an article open.

## Mark operations
- [ ] ✓ button marks all read in the current scope (confirm dialog); Undo toast restores exactly.
- [ ] When caught up, the SAME button flips to "Mark all as unread" (confirm); the ▾ menu flips direction too — only ONE direction is ever offered.
- [ ] ▾ menu age slider: 1–30 days; sentence, value, count preview, and apply button all name the current direction; dragging or arrow keys update the preview live; the last-used value persists across opens.
- [ ] Apply closes the menu, marks exactly the previewed set, and offers Undo.
- [ ] The ▾ split button is available in every scope (the Today scope that used to disable it is gone).
- [ ] Sidebar badge tick (hover shows ✓): marks that feed/folder/all; works from inside any scope; Undo works.
- [ ] Rapid triple-click on a confirm: lands once.
- [ ] Zero-result toasts ("No unread articles older than…") + boundary hint naming the data start.

## Feed information card
- [ ] A ⓘ button sits beside the scope title **only** in a feed scope (absent in Newsfeed/folder scopes).
- [ ] Clicking it opens a centered modal: pfp (feed image or favicon), name, "N articles · M unread", and rows Website / XML address / Folder / Last post / Last crawled.
- [ ] "Last post" shows a relative age ("1h ago") or "Never" for an empty feed; "Last crawled" shows "Success · <age>" or "Failed — <error> · <age> (last success <age>)".
- [ ] An "Original title" row appears only when the config title differs from the feed's own name.
- [ ] Close via the ✕, the backdrop, or Esc; links open in new tabs with `rel="noopener noreferrer"`.

## Scopes & deep links
- [ ] All/Unread status via the ⋯ menu; counts chip matches; the menu offers exactly: All, Unread, Show filtered-out, Refresh, Sort (Newest/Oldest), Reset read state — in that order, and nothing else.
- [ ] Folder and feed click scope the list; folder chevron expands/collapse without changing selection.
- [ ] `#folder/<Name>` / `#feed/<Title>` links: exact, slug, lowercase, with/without spaces all resolve; URL updates on click; back/forward moves scopes.
- [ ] Unknown folder/feed link: hash clears, toast explains.
- [ ] Unknown `#article/<id>`: hash clears, toast explains, list renders.
- [ ] Share a link, open in a second tab: same view opens (cross-tab state via storage events, badge converges).

## Search
- [ ] `/` focuses search; typing filters after debounce; Esc closes and clears.
- [ ] Operators: `feed:`, `title:`, `before:`, `after:`, `unread:true`, `is:read`, quoted phrases, OR groups.
- [ ] Search is global (crosses the current scope); closing restores the scope.
- [ ] No-match: "No matches" empty state names the query.
- [ ] Trailing OR does not match everything.

## Data refresh
- [ ] Manual refresh: "Already up to date" when unchanged; "N new articles synced" when new.
- [ ] Simulate failure (DevTools → block `data/index.json`): previous articles stay on screen; no crash toast spam.
- [ ] Slow network: click a mark action during a slow load → "Still loading" toast, then the action lands.
- [ ] Last-updated line updates ("Updated just now").

## Visual & interaction quality
- [ ] Dark/light parity across sidebar, list, reader, dropdowns, toasts, and modals.
- [ ] Focus-visible rings on all interactive elements; tab order sensible (sidebar → header → list → reader).
- [ ] Hover states: rows, buttons, badges (✓ appears on badge hover).
- [ ] Keyboard: full read/mark/open/nav flow without a mouse.
- [ ] Mobile: sidebar becomes a drawer with scrim; article pane takes over below 1120px; touch targets ≥34px (coarse pointer CSS).
- [ ] Narrow desktop resize: sidebar resizer drag (210–480px), persists across reload.
- [ ] Reduced motion: transitions suppressed.
- [ ] Empty states never overlap the list; toasts never cover a modal.
- [ ] No layout shift when favicons/thumbnails swap in; failed thumbnails removed cleanly.
- [ ] List⇄article divider: drag both directions with the mouse; clamps at the list minimum (260px) and the article minimum (320px); persists across reload; double-click resets to the default split; hidden below 1120px; drag never selects text or freezes iframes.

## Console
- [ ] Zero errors and zero unhandled promise rejections across the whole walk (watch the console during every section above).
