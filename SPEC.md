# MiniCore Web specification

Design baseline: **0.1.1, 2026-11-16**. This document specifies the independent
browser client. The matching backend is **MiniCore Host 0.12.5 / SPEC 4.11.4**,
fixed source `355d4b8bac4a3a634cd83a49fbf33fea7b67a262`.

## 1. Ownership and deployment

- Host owns Agents, Sessions, Turns, input queues, configuration, approvals,
  tools, persistence and operation rights. Web observes native facts and owns
  presentation, local drafts and browser preferences. It uses authenticated
  native WSS JSON-RPC without a proxy protocol or a second execution scheduler.
- A separately deployed Host must be upgraded independently of minicore-tui.
  Launch Host with `--config-dir <directory>` containing `host.json`; `agents/`
  and `roles/` may be absent. Web may still explicitly bootstrap a dynamic Agent
  from its public `initial_agent` configuration when the Host is empty.
- Web deployment `config.json` remains separate from the Host configuration
  directory. It contains no credentials. Host rejects unsupported old data
  formats; the client does not migrate storage, negotiate versions, downgrade
  protocols or rewrite configuration on reconnect.
- Preserve native Host/incarnation/Agent/Session/Load/Turn/response/tool
  identities. Capture action and panel targets before asynchronous work.
  Navigation cannot retarget pending actions. Accepted, completed, persisted,
  failed and unknown delivery remain separate facts.
- Connection recovery reads observations; it never retries business writes,
  restores execution or takes operation rights from another connection. Read-only
  users may read and edit local drafts. Native operation guards remain authoritative.

## 2. Complete errors and original targets

- Live failures retain the complete native Fault message. Historical failed
  Turns use the native persisted `reason` when no live Fault is available.
  Viewing, reopening, history pagination and export preserve that cause and
  actual outcome. A string reason does not create a fictitious Fault type/code.
- Show optional native upstream `http_status`, `provider_type`, `provider_code`
  and `request_id` only when provided. These are direct Fault `details` fields;
  the browser does not parse them out of the message or invent missing values.
- Keep the most recent error in memory with its original native target and
  operation identifiers, when available. A browser-native details sheet and Copy
  action allow recall after a toast is dismissed. A failure from A still names A
  while B is selected; attribution never uses the current Session as a substitute.
  Clear this local diagnostic on sign out or changing Host. It is not persisted
  in public configuration or the service-worker cache.
- Toasts and collapsed error views use bounded display copies. Expanded details,
  explicit full output/copy and exports retain the complete source message.
  A stale/unknown receipt is not relabelled as a confirmed execution failure.

## 3. Session catalog and native state

- All catalog refresh callers share one in-flight read. A request for another
  refresh during that read is retained and serviced after it; callers can await
  the resulting read. A request from a previous connection cannot install data
  into the new connection or clear that connection's pending work.
- Catalog metadata must not roll back after a rename/update or a newer catalog.
  Installing a directory snapshot reapplies already observed native Session state
  for the same identity instead of replacing newer running, interaction, metadata
  save or deletion facts with an older summary. Reuse native revision/load merge
  rules; introduce no independent execution lifecycle or invented revision clock.
- Deleted/reclaimed Sessions are removed according to owner facts. Refreshes do
  not resurrect them or make navigation cancel unrelated work. Background counts
  and the active view derive from the same observed facts.
- A Session row always includes a stable, separate short ID beside the title.
  The title may truncate on narrow screens; the ID does not shrink away. The full
  identity remains accessible and Copy session id retains the full native ID.
  Equal titles, title changes and reordered rows never change operation targets.

## 4. Manual compaction

- An accepted `session.compact` receipt is not a successful completion.
  Observe the actual compaction result. A failed result produces one error for
  that native operation and original Session, including the full fault, whether
  the Session is current or in the background. Repeated observations do not
  repeat the notification. `compacted`, `unchanged` and `cancelled` are not errors.
- Context shows a failed compaction's actual reason even when `block_reason` is
  absent. Historical/latest facts are not described as a new in-progress task.
  An old Load/connection cannot complete a newer operation in the UI.

## 5. Transcript and preview boundaries

- Preserve Host reasoning part/item boundaries exactly. Tokens within one part
  concatenate; real boundaries are supplied by Host. Web does not insert a line
  break per delta, guess boundaries from headings or reconstruct old merged text.
- Tool-only empty assistant bodies do not add visible spacers. Whitespace-only
  bodies may be hidden, but actual partial/recovery notices stay visible. Preserve
  canonical block identity and meaningful whitespace inside real text.
- Tool and error previews have both a line budget and a character/byte budget
  before DOM construction. Avoid splitting a complete large result simply to
  select a few preview lines. Do not cut a Unicode scalar in half. Indicate
  truncation accurately and retain full Open/Copy/export access.
- These are UI preview budgets only; they never limit native body, stored
  history, transport frames or tool execution. Explicitly opened full details
  may contain the full text. Preserve incremental Markdown and scroll anchors.

## 6. Browser controls

- A Context panel keeps the target captured when opened. Its status, action
  enablement and reload dependencies use that target after the main view moves
  elsewhere. Already-open Session menus update connection, operation rights and
  target state without requiring the user to close and reopen them.
- Composition events (`isComposing` or legacy key code 229) cannot reach global
  Escape/stop/navigation shortcuts. Preserve native textarea/input composition,
  selection, paste and undo behavior.
- Preserve existing keyboard semantics: Ctrl/Cmd+Enter sends or steers;
  Alt/Option+Enter queues a follow-up while busy; Shift+Enter inserts a newline.
  Enter/Alt+Enter with an open completion menu retains its existing completion
  behavior. Do not import terminal ESC sequences, Ctrl+Alt+J, Option-as-Meta
  settings, terminal editor commands or process lifecycle controls.
- Keep layout, mobile drawers, sheet focus, accessibility, permission guards and
  browser-owned local preferences. First-Agent preview includes actual configured
  Agent instructions as well as Role instructions, without synthesizing either.

## 7. Authentication and caches

Host access keys stay in endpoint-scoped tab session storage and are cleared on
sign out. Only static application assets enter the PWA cache. No credentials,
Host configuration, WSS messages, conversation bodies or error history are cached.
The cache version changes with the Web release. Closing a tab does not stop Host.

## 8. Required verification

| Area | Acceptance |
| --- | --- |
| Startup | Fixed Host 0.12.5 starts with a real config directory, TLS/WSS and empty-Host bootstrap; no old `--config` flag. |
| Error continuity | Multi-line Unicode cause survives live output, reopen/history and export; optional fields stay native; delayed A errors remain attributed to A; recall and Copy retain full text. |
| Catalog | Deferred old read/new rename, unknown Session during pending read, running/approval before an older summary, deletion, reconnect and foreground/background navigation. |
| Compaction | Real acceptance followed by failed result, repeat observation, background target, Context cause, and successful/nonfailed results. |
| Identity | Same titles, long prefixes, rename, running/idle and narrow mobile rows keep visible stable IDs and full native targets. |
| Preview | Very large single-line Unicode and many-line output remain bounded in cards, signal truncation and preserve full data; normal tool cards and empty assistant spacing remain usable. |
| Browser behavior | Captured Context target, menus across disconnect/read-only changes, composing Enter/Escape, existing send/steer/follow-up keys, native paste, focus and desktop/mobile flows. |
| Existing contracts | Static build, unit regressions, real Host WSS owners, storage/local tools, approvals, queues, cancellation, configuration, history, read-only/recovery and static-only PWA caching. |

Use controllable model/tool boundaries only where explicitly labelled. Prefer
real Host owners and actual browser events for integration. Synthetic module
interleavings prove specific client behavior, not arbitrary Host event ordering;
crossed Controller/Runner revision tuples that the current Host cannot emit are
contract checks, not reported production failures. Distinguish automated Chromium
from physical macOS/Safari/IME or live-provider validation. Record commands,
counts, screenshots, fixed revisions and any blocked checks in PROJECT.md.
