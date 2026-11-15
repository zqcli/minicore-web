# MiniCore Web

## 0.1.1 upgrade — design accepted, implementation in progress

- 2026-11-16: user authorized the Web upgrade following the read-only TUI/Web
  review. `SPEC.md` records the behavior before implementation. Planned release:
  0.1.1; companion Host 0.12.5 / SPEC 4.11.4, fixed revision
  `355d4b8bac4a3a634cd83a49fbf33fea7b67a262`.
- Scope: Host launch/CI baseline, complete historical and recalled errors with
  original targets, coordinated Session catalog, asynchronous compaction failure,
  stable short Session IDs, bounded previews, captured Context/menu state and
  global IME guards. Preserve browser keyboard, native editing and WSS ownership.
- Three workers requested with `gpt-6-astra`, `max` reasoning own disjoint state,
  rendering and browser UI paths. Effective runtime settings are not independently
  attested. The coordinator owns specification, deployment, test fixtures and
  combined real-Host/browser validation.
- No implementation or new-version test result is claimed at this design checkpoint.

## 0.1.0 delivery record

## Goal

Migrate the existing MiniCore webpage into an independent static browser client,
preserving its UI while using MiniCore Host WSS and native owner contracts.

## Baselines

- Web UI: minicore-tui 0.9.9; source `2451d7289214385e3d21b46174b36f32a41dce45`.
- Initial Host: 0.11.0, `32f074c57868533af81b0c6491440bae24b872c8`, SPEC 4.10.2.
- Authorized Host extension: SPEC first, then `workspace.roots/list/mkdir`.
- Work branch: `dev`. First Web release: 0.1.0.

## Implemented

- Preserved the original CSS byte-for-byte, along with incremental Markdown,
  tool cards, desktop controls, mobile sheets, keyboard behavior and scroll anchors.
- Replaced the Phone wire layer with native authenticated WSS JSON-RPC,
  subscriptions, source-aware projection, backward history and UTF-8 range repair.
- Migrated Session actions, Agent selection/first bootstrap, approvals, queues,
  cancellation, workspace files/diffs, model/reasoning and manual compaction.
- Added the three Host directory methods through SPEC-first Host work. The
  companion Host source is `a0b560ee59c9b04057361ede2757e99f21295613`
  (0.11.1, SPEC 4.10.3); CI checks out this fixed source.
- Preserved original action targets and connection identities across navigation
  and reconnect. A later observation failure does not erase an accepted receipt.
  Partial first-Agent creation reuses the published Agent on the next explicit Start.
- Ported 28 applicable renderer regressions and added native transport/projection,
  lifecycle, directory, Windows-path and service-worker coverage.

## Validation and publication

- 2026-11-14: local syntax/import checks, static build and 64 unit/UI cases pass.
- Four integration cases pass against a real Host subprocess, trusted TLS/WSS,
  storage, Git workspace and local tools. They cover the application workflow,
  approvals and real writes, queues/removal/cancellation, compaction, new-Session
  lifecycle/deletion, read-only connections and canonical history.
- The model SSE endpoint is a controlled local fixture, not a live external
  provider. No live-provider result is claimed.
- Desktop/mobile Chromium scenarios and fixed-source Host integration pass in
  CI. The local desktop Chromium launch remains blocked by the runtime's
  process/socket restrictions; browser execution was verified remotely.
- Real Chromium first-bootstrap scenarios exposed a missing-Session access in
  operation dispatch. [The Session guard fix](https://github.com/zqcli/minicore-web/commit/452e9d5dbd3af571f9f7d4d4a700b8566db478b2)
  preserves the captured native target. [The mobile drawer test](https://github.com/zqcli/minicore-web/commit/42014d87c39418f42dc0c5d283a9db69d58730f3)
  now waits for the drawer to become hidden and checks that `main.inert` is false.
- Verified functional checkpoint:
  `42014d87c39418f42dc0c5d283a9db69d58730f3`, tree
  `2cc0a4b138081687b5c6109a844c96d2b535a5db`.
  [CI run 43555928972](https://github.com/zqcli/minicore-web/actions/runs/43555928972)
  completed successfully: the [static job](https://github.com/zqcli/minicore-web/actions/runs/43555928972/job/132328646121)
  and [real Host plus Chromium job](https://github.com/zqcli/minicore-web/actions/runs/43555928972/job/132328646511)
  passed all 64 unit/UI, four real Host TLS/WSS integration and two desktop/mobile
  Chromium cases, with no skipped cases. The Host pin remains
  `a0b560ee59c9b04057361ede2757e99f21295613` (0.11.1, SPEC 4.10.3).
- [Screenshot artifact 14098740699](https://github.com/zqcli/minicore-web/actions/runs/43555928972/artifacts/14098740699)
  contains four PNGs. Desktop streaming/restored views and mobile
  conversation/drawer views were visually checked. The original CSS remains
  byte-identical; the frontend migration scope is unchanged.
- The GitHub connector publishes the locally checked trees in their original
  logical order. Commit metadata can differ from local preparation; tree hashes
  are checked before moving `dev`, with no force update or published-history rewrite.
- Backend and frontend workers were explicitly requested with `gpt-6-astra`,
  `max` reasoning, in parallel. Runtime settings are not independently attested.
