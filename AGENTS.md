# Engineering instructions

MiniCore Web is a static browser client for MiniCore Host. The initial UI is
ported from minicore-tui 0.9.9, source commit
`2451d7289214385e3d21b46174b36f32a41dce45`, `src/remote/web`.

- Work on `dev` and preserve the existing layout, styling, incremental Markdown,
  tool cards, keyboard/mobile interactions and scroll anchors. Keep the first
  release focused on migrating working features.
- `SPEC.md` is the Web design baseline (0.1.1). Its browser contracts accompany
  Host 0.12.5 / SPEC 4.11.4; follow the exact Host revision recorded there.
- Host owns Agents, Sessions, Turns, queues, configuration, approvals, tools,
  persistence and operation rights. The browser owns presentation and local
  preferences/drafts. Use native authenticated Host WSS JSON-RPC directly.
- Read the matching Host SPEC and its rules. Directory picker methods are
  `workspace.roots`, `workspace.list` and `workspace.mkdir`; their contract must
  be committed in Host SPEC before backend implementation.
- Remove the old Phone protocol, device tokens, view epochs and wire reducer.
  Plain local UI actions and display blocks are allowed; do not wrap Host data
  in fabricated Phone frames or implement a second backend state machine.
- Use small native ES modules. No framework rewrite, generic SDK platform,
  automatic business retries, compatibility fallback or speculative features.
- Preserve actual Host, incarnation, Agent, Session, Load, Turn, response and
  tool identities. Capture targets before async work; navigation cannot retarget
  a pending action. Receipts report actual acceptance/partial results.
- Output offsets are UTF-8 bytes. History positions and opaque cursors identify
  canonical content. Reconnect and resync recover observations, never execution.
  Message and operation IDs are correlation identifiers, not idempotency keys.
- One initialized connection may operate; other connections stay read-only.
  No takeover or implicit rights recovery. Session config applies to later Turns.
- Keep secrets out of public configuration, URLs, logs, fixtures and commits.
  Host access keys are entered locally, scoped to the endpoint, and cleared on
  sign out. Static caches contain app assets only.
- Cover meaningful protocol, rendering and browser integration behavior. Use
  real Host owners for WSS integration, with explicitly named controllable
  model/tool boundaries. Do not claim live-provider or manual validation from
  fixtures. Report blocked checks accurately.
- Parallel workers own disjoint paths and coordinate public module contracts.
  User-requested workers use `gpt-6-astra`, `max` reasoning. Record requested
  settings without claiming independent runtime verification.
- English commits use `type(scope): summary`, author zqcli, no co-author trailers.
  Commit logical changes with their tests/docs. Never force-push or rewrite
  published history. Keep README, changelog and task progress accurate.
