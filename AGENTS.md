You are a senior engineer performing a full production-hardening pass on this codebase.
Work phase by phase. You may NOT start a phase until the previous phase's EXIT GATE
is met. Merging phases = failure.

the repo in question: https://github.com/DarkReaperBoy/rssfeed
your api key: 

GLOBAL RULES (apply to every phase):
1. One atomic change at a time. Verify it before moving to the next.
2. Never mix concerns: a bug fix, a refactor, and an optimization never travel together.
3. The test suite is the contract — green after every single change, no exceptions.
4. Severity order for everything: data loss/crash > security > wrong behavior >
   degraded UX > cosmetic > extremely needed quality of life feature.
5. No placeholders.
6. If a change cannot be tested, it cannot be made.
7. Maintain a changelog: every change, its phase, and how to verify it.
8. Do not include comment on code as it snowballs wrong biases.
9. Upgrade Dependencies to latest version. Read all warning/error and sweep them.
10. Outcome must be production ready, rock solid.
11. If something is not specified in the prompt, use your own intuition for the unix perfection with verified outcome.

────────────────────────────────────────
PHASE 0 — FULL RECON (read-only, zero modifications)
- Read the ENTIRE codebase, every file, start to finish. No sampling, no skipping,
  no summarizing, no relying on filenames to guess contents.
- Produce a written map: entry points, architecture, data flow, state management,
  dependencies, external APIs, auth flow, every route/page/component.
- List every critical user journey (login, core actions, payment/submit, error paths).
- Flag risk zones: race conditions, unvalidated input, manual event-listener/timer
  management, duplicated state, swallowed errors.
EXIT GATE: the map + journey list + risk list are written down.

────────────────────────────────────────
PHASE 1 — SAFETY NET (tests BEFORE touching anything)
- Set up/verify test infrastructure (unit + integration + E2E).
- Write characterization tests pinning down CURRENT behavior for every critical
  journey — including current buggy behavior, marked as "known behavior."
- Write the browser-GUI checklist NOW (used in the final phase): journeys, expected
  outcomes, edge cases — empty states, network failure, invalid input, rapid
  clicking, refresh mid-action, back button.
EXIT GATE: full suite green. This suite is the regression detector for all
remaining phases; without it you are working blind.

────────────────────────────────────────
PHASE 2 — CORRECTNESS (bugs only, nothing else)
- Hunt with dedicated sweeps, one lens per pass: logic errors → race conditions →
  async/await mistakes → unhandled rejections → error swallowing → edge cases →
  memory leaks (unremoved listeners/timers/subscriptions).
- Fix ONE bug per iteration: write a failing test → fix → test passes → full suite green.
- No refactoring, no optimizing, no restyling in this phase.
EXIT GATE: a full sweep across all lenses yields zero findings above cosmetic severity.

────────────────────────────────────────
PHASE 3 — PRUNE & REFACTOR (behavior-preserving only)
- Dead code: verify true deadness via usage analysis across the whole codebase
  (imports, references, dynamic usage) before deleting. In doubt → mark, don't delete.
- Refactor for clarity: duplication, naming, oversized functions, tangled state.
- Suite must stay green after every change. If a "refactor" changes behavior,
  that's a bug — revert it.
EXIT GATE: suite green, changelog lists every deletion with its verification evidence.

────────────────────────────────────────
PHASE 4 — PERFORMANCE (measure, never guess, for both frontend and backend, time and resources).
- Profile FIRST: find real hot paths (slow renders, redundant re-renders, N+1
  queries, bundle size, startup time, long tasks).
- Record baseline numbers BEFORE changing anything.
- Optimize only measured hot paths. One optimization per iteration:
  measure → change → re-measure → suite green.
- Reject optimizations that don't beat baseline or that add complexity for
  marginal gains. "perfection" is the target.
EXIT GATE: before/after numbers documented per optimization.

────────────────────────────────────────
PHASE 5 — UI/UX & POLISH
- Visual consistency: spacing, typography, alignment, colors across ALL screens.
- The states code forgets: loading, empty, error, offline, permission-denied, slow network.
- Interaction quality: jank, input lag, focus states, keyboard navigation,
  double-submit protection.
- Responsive (mobile/tablet/desktop) and cross-browser (Chrome/Firefox/Safari).
- Accessibility: contrast, labels, ARIA where needed, tab order.
EXIT GATE: every page/state checked against this list.

────────────────────────────────────────
PHASE 6 — SECURITY
- Input validation and sanitization at every boundary (client AND server).
- XSS, injection, CSRF, open redirects.
- Authorization checks on every protected route and API endpoint.
- No secrets in code or logs; error messages must not leak internals.
EXIT GATE: every item verified, findings fixed via the Phase 2 fix loop.

────────────────────────────────────────
PHASE 7 — FULL VERIFICATION
- Run the ENTIRE suite: unit + integration + E2E. Zero failures.
- Extensive browser GUI testing against the Phase 1 checklist: every critical
  journey end-to-end, every edge state, rapid interaction, refresh mid-flow,
  back-button behavior, console must be error-free, mobile viewport.
- Any failure: reproduce it as a test FIRST, then fix, then re-run everything.
EXIT GATE: all checks pass. Deliver the changelog organized by phase,
with verification instructions for every change.
