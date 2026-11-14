# MiniCore Web 0.1.0

## Goal

Migrate the existing MiniCore webpage into an independent static browser client,
preserving its UI while using MiniCore Host WSS and native owner contracts.

## Baselines

- Web UI: minicore-tui 0.9.9; source `2451d7289214385e3d21b46174b36f32a41dce45`.
- Initial Host: 0.11.0, `32f074c57868533af81b0c6491440bae24b872c8`, SPEC 4.10.2.
- Authorized Host extension: SPEC first, then `workspace.roots/list/mkdir`.
- Work branch: `dev`. First Web release: 0.1.0.

## Work

1. Preserve the static UI and useful renderer tests.
2. Implement native WSS, Host queries/actions and source-aware presentation.
3. Complete directory selection, configuration, interactions and recovery.
4. Validate real Host integration, desktop/mobile rendering, build and CI.

## Progress

- 2026-11-14: Imported the original static UI into `web/`. Implementation started.
- Backend and frontend workers requested with `gpt-6-astra`, `max` reasoning.
- Validation and publication are pending.
