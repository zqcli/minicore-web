# Changelog

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
