# Codex Completion Fallback Design

Date: 2026-04-09

## Goal

Keep `notify` as the primary Codex completion path, but let `codex-session-watch`
send one fallback completion notification when legacy `notify` does not arrive.

This design is intentionally narrower than a full completion pipeline rewrite:

- completion remains `notify`-first
- watcher only provides delayed fallback
- current watcher responsibilities for `PermissionRequest` and `QuestionNotification`
  stay unchanged

## Current Context

Today the package has three distinct roles:

- default `ai-agent-notify` entrypoint handles Claude hook stdin and Codex legacy
  `notify` argv payloads
- `codex-session-watch` handles watcher-driven reminders for approval and input
  requests
- `codex-mcp-sidecar` records startup-time terminal observations and makes sure
  the watcher is running

The active architecture explicitly keeps completion on the `notify` path and
keeps watcher logic focused on approval-side event processing. That boundary is
still useful and should not be thrown away just to cover a fallback case.

There is also already evidence that completion can fail to arrive through
legacy `notify` on Windows in some sessions. The package therefore needs a
fallback path, but the fallback should remain subordinate to the existing
`notify` route rather than replacing it.

## Alternatives Considered

### 1. Recommended: `notify` primary, watcher delayed fallback

`notify` keeps first responsibility for completion. Watcher observes completion
candidates independently, waits a short grace window, and only emits a fallback
completion if no receipt from the `notify` path is present.

Why this is the recommended option:

- preserves the current architecture
- contains complexity to one fallback branch
- keeps duplicate suppression explicit instead of heuristic

### 2. Dual-primary completion paths with dedupe

Both `notify` and watcher would treat themselves as first-class completion
senders, and a shared dedupe layer would try to suppress duplicates.

Why this is not the first version:

- larger architectural change
- much higher risk of double notification
- more documentation, state, and test churn than needed

### 3. Heuristic-only fallback for known bad cases

Watcher would only emit completion fallback for specific “known broken”
situations such as long-lived sessions or specific origin types.

Why this is rejected:

- brittle and hard to trust
- encodes machine-specific history into runtime behavior
- does not create a clear general model

## Final Design

### Completion Receipts

The package will add a small local completion receipt store.

The default `notify` path will write a receipt as soon as the incoming payload
has been normalized into a valid Codex completion notification shape. This
receipt is not the notification itself; it is only proof that the `notify`
route reached this package.

The receipt should be written before terminal-context preparation, PowerShell
spawn, flash handling, or any other notification-side work. The receipt exists
to suppress fallback quickly, so delaying it would force watcher grace windows
to become longer.

Each receipt key should include:

- `sessionId`
- `turnId`
- `eventName = Stop`

That key is specific enough to prevent one completion from suppressing a later
completion in the same session.

The receipt store should be local, temporary, and TTL-based. It is only meant
to coordinate short-lived watcher fallback decisions, not to become a permanent
history database.

### Watcher Completion Candidates

Watcher will gain a new completion candidate path, separate from the existing
approval and input flows.

Important scope limit for the first version:

- use rollout JSONL only
- do not add legacy log completion parsing yet

This keeps the first version narrow and avoids inventing a legacy log completion rule
before there is evidence that the rollout-based signal is insufficient.

The watcher will not emit completion immediately on sight. Instead it will
queue a pending completion candidate with a short grace window. When that grace
window expires:

- if a matching completion receipt exists, the watcher drops the candidate
- if no matching receipt exists, the watcher emits a fallback `Stop`
  notification

During that grace window, watcher may do non-emitting preparation work early,
for example:

- building the fallback notification spec
- reconciling sidecar state
- resolving the best terminal candidate

But the final “should I emit the fallback?” decision should happen immediately
before `emitNotification()` is called, with one last receipt check at that
point. This overlaps some preparation with the grace window without weakening
dedupe correctness.

### Emission Path

Watcher fallback completions should reuse the existing notification runtime and
`notify.ps1` path rather than introducing a second toast implementation.

This keeps all Windows-specific behavior in one place:

- icon composition
- flash behavior
- Windows Terminal tab color logic
- logging

The watcher should construct a normal `Stop` notification spec and hand it to
the existing runtime layer.

### Separation from Existing Approval/Input Logic

Completion fallback should not be added to the current
`pendingApprovalNotifications` machinery.

Instead, it should have parallel state with its own names and logs, for
example:

- `pendingCompletionNotifications`
- `completionReceipts`

Reasons:

- approval and completion have different semantics
- their grace windows exist for different reasons
- mixing them would make logs and tests harder to understand

The current watcher handling for `PermissionRequest` and `QuestionNotification` should
remain intact.

## Data Flow

### Normal path

1. Codex emits legacy `notify`
2. `ai-agent-notify` normalizes the payload
3. runtime writes a completion receipt
4. runtime sends the normal completion notification
5. watcher later sees the same completion candidate
6. watcher finds the receipt and drops the fallback

### Fallback path

1. Codex completion happens but legacy `notify` does not reach this package
2. watcher sees a rollout completion candidate
3. watcher queues it for a short grace window
4. watcher may prepare fallback state during that grace window
5. immediately before emitting, watcher checks receipt state one more time
6. no matching receipt exists, so watcher emits one fallback `Stop`
   notification

## Error Handling

- If receipt persistence fails, log it and continue; missing receipts must not
  break the normal notify path.
- If watcher cannot persist or read completion pending state, log it and fail
  closed by not emitting speculative duplicates immediately.
- If watcher can prepare fallback context but receipt state changes before final
  emit, the receipt wins and watcher must drop the fallback.
- If rollout completion parsing proves too weak in real usage, add a later
  follow-up design for legacy log completion fallback rather than broadening this
  version ad hoc.

## Testing Strategy

Add tests for:

- `notify` writing completion receipts for Codex completion payloads
- watcher dropping pending completion fallback when a matching receipt exists
- watcher emitting fallback completion when no receipt exists
- no duplicate completion across multiple turns in the same session
- existing approval and input watcher behavior remaining unchanged

Regression scope should cover both architecture and behavior:

- watcher still handles `PermissionRequest`
- watcher still handles `QuestionNotification`
- completion remains `notify`-first
- watcher completion uses rollout-only signals in v1

## Out of Scope

- replacing `notify` as the primary completion path
- legacy log-based completion fallback in the first version
- changing approval signal priority or sidecar semantics
- solving every historical Windows session-origin edge case in one pass

## Success Criteria

The design is successful when:

- normal Codex completion still behaves exactly as today
- a missing legacy `notify` can be covered by watcher fallback
- duplicate completion notifications are suppressed through receipts instead of
  heuristics
- watcher approval and input flows remain unchanged
