# Changelog

## 0.1.1 — 2026-11-16

- Validate against fixed MiniCore Host 0.12.5 / SPEC 4.11.4; update deployment
  guidance and real-Host fixtures to `--config-dir` with separate storage.
- Preserve historical failure reasons, native upstream diagnostics and full
  copies/exports; add browser-native last-error recall with original targets.
- Coordinate Session catalog reads, retain refresh demand and preserve newer
  observed state across late summaries, rename and deletion.
- Report asynchronous manual compaction failures once for their original Session
  and expose their actual cause in Context.
- Keep stable short Session IDs visible and bound tool/error preview text while
  retaining explicit access to complete results.
- Page large full tool output without altering its text, and keep Copy/export
  complete so a huge wrapped line cannot block the reading panel's layout.
- Keep Context panels bound to their original target, refresh open menu state and
  protect global keyboard shortcuts during IME composition.
- Preserve browser-specific send/steer/follow-up keys, native editing, reasoning
  line boundaries, incremental rendering and desktop/mobile interactions.

## 0.1.0 — 2026-11-14

- Extract the original minicore-tui 0.9.9 webpage into an independent static application;
  retain its CSS, rendering, keyboard controls and mobile layout.
- Replace the removed Phone wire protocol with authenticated MiniCore Host WSS JSON-RPC,
  native subscriptions, source identities, history pagination and UTF-8 output recovery.
- Migrate conversations, streaming, tool cards, approvals, input queues, cancellation,
  workspace files and diffs, session controls, model/reasoning changes and compaction.
- Add minimal Agent selection and explicit first-Agent bootstrap, using deployed defaults
  and the user-selected workspace.
- Integrate Host 0.11.1 `workspace.roots`, `workspace.list` and `workspace.mkdir`.
- Preserve read-only connection semantics and captured action targets; never automatically
  retry business writes after uncertain delivery.
- Keep credentials scoped to a browser tab and endpoint; cache only application assets.
- Add deterministic protocol/projection tests, actual-Host WSS integration, desktop/mobile
  Chromium scenarios, static builds and CI.
