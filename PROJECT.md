# MiniCore Web 0.1.0

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
- Desktop/mobile Chromium scenarios and fixed-source Host integration are
  configured in CI. The local desktop Chromium launch is blocked by the runtime's
  process/socket restrictions; browser execution is verified in CI separately.
- The GitHub connector publishes the locally checked trees in their original
  logical order. Commit metadata can differ from local preparation; tree hashes
  are checked before moving `dev`, with no force update or published-history rewrite.
- Backend and frontend workers were explicitly requested with `gpt-6-astra`,
  `max` reasoning, in parallel. Runtime settings are not independently attested.
- CI publication/results are recorded after the remote runs complete.
