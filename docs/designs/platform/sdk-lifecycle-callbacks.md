# SDK lifecycle callbacks: restart + refresh pre-hook for embedded hosts

## Problem / Intent

Compass is pivoting from ACP to direct SDK embedding of the OMP engine — the
engine lives in a long-lived JS/TS host process with no per-agent process
boundary. Two lifecycle affordances are missing on that path: a way for a
session to signal "restart me" to the host that owns it, and a way for the host
to pull fresh skills, rules, and settings before OMP re-reads them (extensions
ride the restart path, not refresh — see Resolved decision (d)). This record adds
two host callbacks to `CreateAgentSessionOptions` —
`onRestartRequested` plus a driving `AgentSession.requestRestart()`, and
`onBeforeRefresh` threaded into `AgentSession.refresh()` — so the host decides
how restart and config-pull actually happen.

## Approach

### The core split: session recycle vs. binary pickup

An in-process embed cannot pick up a new OMP binary by itself: OMP's modules
are already loaded in the host's module graph, and nothing short of the host
recycling its own process swaps that code. The record therefore bakes in a hard
split:

- **Per-agent "restart" = session recycle.** Dispose the `AgentSession`,
  re-create it from the session file — same loaded code. This is exactly the
  pattern `AgentSession.reload()` already proves in-tree
  (`packages/coding-agent/src/session/agent-session.ts:15220-15224`):

  ```ts
  async reload(): Promise<void> {
      const sessionFile = this.sessionFile;
      if (!sessionFile) return;
      await this.switchSession(sessionFile);
  }
  ```

- **New-OMP-version pickup = host-level fleet operation.** Only the host
  bouncing its own process swaps the loaded code. It is never reachable as a
  per-agent OMP tool call, and one agent's restart request must never bounce
  the shared host process out from under its siblings.

The callback contract carries exactly the data the host needs to re-attach the
one session being recycled — `{ sessionId, sessionFile }` — and nothing that
would tempt a fleet-wide action from a single agent's request.

This SDK path is the embedded-host analog of the sealed ACP cooperative-restart
contract (SEA-1296); it is an independent, greenfield oh-my-pi design, not an
amendment of that record. There is no restart machinery in oh-my-pi today: the
only shutdown-adjacent surfaces are `SessionShutdownEvent`
(`packages/coding-agent/src/extensibility/shared-events.ts:92-94`, a
SIGINT/SIGTERM extension event) and the caller-less seed helper
`resolveOmpCommand()` (`packages/coding-agent/src/task/omp-command.ts:14`).

### Callback 1 — `onRestartRequested` + `AgentSession.requestRestart()`

**Attach point.** `CreateAgentSessionOptions`
(`packages/coding-agent/src/sdk.ts:384-578`), following the existing callback
precedent in the same interface (`sdk.ts:574`):

```ts
onFirstChatDispatch?: () => void;
```

**New option:**

```ts
 * Cooperative restart hook for embedded hosts. When the session (or its
 * host) calls `AgentSession.requestRestart()`, OMP latches out new turns,
 * waits for the running turn to settle, flushes the session file to disk,
 * disposes the session, then invokes this callback with the data needed to
 * re-attach. The session is already disposed when this fires, so the host
 * just re-opens: `createAgentSession({ sessionManager: await
 * SessionManager.open(file) })`. Recycles ONLY this session (same loaded
 * code); picking up a new OMP build is a host-process-level operation, never
 * triggered per-agent. Unset => `requestRestart()` refuses (restart
 * unavailable).
 */
onRestartRequested?: (
    info: { sessionId: string; sessionFile: string },
) => void | Promise<void>;
```

**New method on `AgentSession`:**

```ts
/**
 * Request a cooperative restart of THIS session. Refuses when no
 * `onRestartRequested` callback is bound, when there is no session file, or
 * when unpersisted input is queued. Latches out new turns, waits for the
 * running turn to settle, flushes the session to disk, disposes it (OMP
 * disposes first), then awaits the host callback with the data needed to
 * re-attach.
 */
async requestRestart(): Promise<RequestRestartResult>;

type RequestRestartResult =
    | { ok: true }
    | { ok: false; reason: "unavailable" | "no-session-file" | "busy" };
```

**Sequence** (all primitives exist today):

1. **Refuse when unbound.** If no `onRestartRequested` was supplied, return
   `{ ok: false, reason: "unavailable" }`. Mirrors the RefreshTool guard
   (`packages/coding-agent/src/tools/refresh.ts:78-84`):

   ```ts
   if (!this.session.refresh) {
       return {
           content: [
               { type: "text", text: "Refresh is unavailable in this session." },
           ],
           isError: true,
   ```

2. **Refuse in-memory sessions.** `sessionFile` is
   `string | undefined` — `agent-session.ts:7332-7335`:

   ```ts
   /** Current session file path, or undefined if sessions are disabled */
   get sessionFile(): string | undefined {
       return this.sessionManager.getSessionFile();
   }
   ```

   With no file there is nothing for the host to re-open, so
   `requestRestart()` returns `{ ok: false, reason: "no-session-file" }`
   rather than passing `undefined` through and making every host handle it.
   (Resolved decision (c) records this.)

3. **Latch, then quiesce the owning turn.** Set the `#restarting` latch first
   (so no new turn can start between the wait and the callback — see Latch
   semantics below), then `await this.waitForIdle()` (`agent-session.ts:6086-6089`
   — "Wait until streaming and deferred recovery work are fully settled") so the
   transcript is complete before capture. The host typically calls
   `requestRestart()` from outside a turn; the model-callable `restart` tool
   drives it too, from an untracked continuation (Task 4) that reports
   pre-dispose refusals to the transcript; a post-dispose throw there has no
   awaiting caller, so the continuation catches and logs it (recovery is via the
   durable session file, not the closed transcript).

4. **Capture the durable re-attach identity** — `sessionManager.getSessionId()`
   (`session-manager.ts:1295-1297`, the file-preserved `#sessionId`) and
   `sessionFile`. NOT the `sessionId` getter: it delegates
   `#activeProviderSessionId()` (`agent-session.ts:7333-7340`) and can return a
   fresh provider UUID that diverges from the id `SessionManager.open` restores
   from the file (`session-manager.ts:1920-1944`). The payload exists for
   re-attach, so it must be the id the host sees after re-opening.

5. **Durability barrier.** `await sessionManager.flush()` then
   `await sessionManager.ensureOnDisk()` — `session-manager.ts:1185-1195` and
   `:1177-1182`:

   ```ts
   /** Flush pending writes. Call before switching sessions or on shutdown. */
   async flush(): Promise<void> {
   ```

   so the file the host re-opens reflects the full transcript.

6. **Drain the refresh mutex, then dispose, then invoke.** First
   `await this.#refreshTail` so any `refresh()` already inside its critical
   section (a seconds-scale `onBeforeRefresh` pull) completes. Its
   `setActiveSkills`/`setActiveRules` swaps (`reload.ts:112`/`:122`) mutate
   in-memory process globals — they are *not* persisted, and the replacement
   re-scans disk and re-swaps the globals itself at construction
   (`setActiveSkills`/`setActiveRules`, `sdk.ts:1681`/`:1686`). Draining before
   dispose therefore guards two in-memory races, not the session file: (i) the
   refresh's `onBeforeRefresh` disk writes settle before the replacement
   re-scans them, and (ii) the refresh's `applyReloadedSkills` fan-out
   (`agent-session.ts:7007`, which writes `#skills` into every registered
   session) completes while only the old session is registered, so it cannot
   clobber the replacement's freshly-scanned `#skills` once the host creates and
   registers it. The `#restarting` latch (set in step 3) already refuses *new*
   refreshes, so nothing chains on behind the drained one. Then
   `await this.dispose()` (idempotent, single shared
   `#disposeCall` promise, `agent-session.ts:5861-5865`), then
   `await this.#onRestartRequested({ sessionId, sessionFile })`. OMP disposes
   first (Resolved decision (b)): create-before-dispose is unsafe in-process —
   the `AsyncJobManager` singleton guard (`sdk.ts:1505-1506`, issue #1923) would
   hand a replacement built while the old session lives *no* async job manager,
   and the lock-free append writer (`session-storage.ts`) would leave two writers
   on one file. Dispose flips ownership of both cleanly before the host re-creates.

7. Return `{ ok: true }` once the callback resolves. Failures split on whether
   `dispose()` (step 6) has begun — detected by `#disposeCall` being set. A
   **pre-dispose failure** (`waitForIdle()`, the `flush()`/`ensureOnDisk()`
   barrier, or the `#refreshTail` drain throwing before dispose) is *recoverable*:
   the session is still alive, so `requestRestart()` drops the `#restarting` latch
   and clears `#restartCall` before rethrowing, and the host may retry a fresh
   restart (decision (h)). A **post-dispose failure** — the host callback throwing
   after dispose — is terminal; OMP must not swallow it, so the rejection
   propagates, and who receives it splits by path (direct host `await` vs. the
   model tool's untracked catch-and-log) — see decision (a) and Task 4.

**Re-entrancy.** `requestRestart()` coalesces an in-flight restart onto a single
shared `#restartCall` promise: a second call while one is in flight returns the
same promise, so the host callback fires exactly once per restart even under
concurrent or repeated calls. The coalescing is *not* symmetric with `dispose()`'s
terminal `#disposeCall` cache (`agent-session.ts:5861-5865`), though: dispose is
one-way, so caching its settled promise forever is correct, whereas a restart that
fails in its pre-dispose window is recoverable and must *not* be cached — see
decision (h).

**Latch semantics.** `waitForIdle()` (`agent-session.ts:6086-6089`) is a
*wait*, not a *latch* — after it resolves, an IRC wake (`#promptIrcRecords`,
fire-and-forget `void this.agent.prompt`), an async-job completion enqueued to
`yieldQueue` (`sdk.ts:1509-1522`), a queued-message drain
(`agent-session.ts:8478-8495`), or a host `prompt()` could start a new turn and
append past the durability barrier. So `requestRestart()` sets a `#restarting`
latch *before* the wait and holds it through the callback: while latched the
session refuses to begin a new turn (new prompts reject / no-op through the
same guard the unbound path uses), refuses to *start* a new `refresh()` (the
lock acquirer early-returns `{ refused: "restarting" }` while `#restarting`, so
no roster re-scan chains on behind the one restart drains in step 6 — an
in-flight refresh is drained, a new one is turned away with an explicit refusal
rather than a silent no-op), and async-job delivery is paused: while
`#restarting`, `onJobComplete` (`sdk.ts:1509-1522`) short-circuits before
`session.yieldQueue.enqueue` (`sdk.ts:1515`), the same early-return shape as the
existing `isDeliverySuppressed(jobId)` gate (`sdk.ts:1510-1512`), so a job that
finishes mid-recycle holds its delivery instead of waking a new turn. Parked
in-memory input is not silently dropped: if `agent.hasQueuedMessages()`
(`packages/agent/src/agent.ts:888`) is true at entry, `requestRestart()` returns
`{ ok: false, reason: "busy" }` rather than recycling over queued steering /
follow-up messages that are not yet persisted. The guard uses the **raw** method
(`#steeringQueue.length > 0 || #followUpQueue.length > 0`,
`packages/agent/src/agent.ts:888-890`), NOT the displayable-filtered
`session.queuedMessageCount` (`agent-session.ts:8825-8829`, which the SDK
`SessionContext.hasQueuedMessages` field at `sdk.ts:2208` wraps): a
non-displayable queued steer must still block restart, or the durability promise
leaks in exactly the multi-tenant deployment this serves. This makes that promise
("the file the host re-opens is the full transcript") true for the always-on
agents Compass drives (Dispatcher / Warden, `compass.md` §4.2/§4.3, a repo
outside this tree — see decision (f)), which cannot guarantee external idleness.
`{ ok: true }` still means "the
callback returned"; the host's re-attach is what completes the restart.

**Host re-attach recipe** (documented on the option): OMP has already disposed
the session when the callback fires, so the host just re-opens —
`SessionManager.open(sessionFile)` (`session-manager.ts:1920-1925`), a
path-shaped re-adopt that preserves the session id — and passes the manager to
a fresh `createAgentSession` (`sdk.ts:1110`). The host must NOT create the
replacement before the callback (it cannot: the old session is gone), which is
exactly the create-before-dispose hazard Resolved decision (b) rules out.

**Multi-agent invariant — structural, by process topology.** This record
designs for **one embedded engine per process**: Compass gives each agent its
own rootless-podman container with its own engine (`compass.md` §5.3, "Each
agent runs in its own container"; §7.1, the daemon "runs each agent in its own
container"). So the process-global swaps `createAgentSession` performs —
`setActiveSkills`/`setActiveRules` (`sdk.ts:1680-1686`), `MCPManager.setInstance`
(`sdk.ts:1818`) — and the `AsyncJobManager` singleton (`sdk.ts:1505-1506`) have
no sibling session to disturb: exactly one top-level session per container.
`requestRestart()` itself touches only `this` session's state and hands the host
only this session's `{ sessionId, sessionFile }`. Version pickup is a host fleet
op with its own (host-side, out-of-scope) trigger. If a future host runs
multiple top-level engines in one process, per-session scoping of those globals
becomes a prerequisite — its own design record. See Resolved decision (f).

### Callback 2 — `onBeforeRefresh` pre-hook

**Why a pre-hook, not an in-memory content provider.** The engine *does* accept
in-memory config at creation — `skills` (`sdk.ts:1402`), `rules`
(`sdk.ts:1422`), `extensions` (`sdk.ts:1859`), and `mcpManager` (`sdk.ts:1707`)
are all taken as objects — so "hand the session objects instead of staging
files" is a fair question. The answer is per-surface, and mixed:

- **rules** — coherent in-memory. `Rule` carries `content`
  (`capability/rule.ts:47`) and `rule://` serves it straight from memory
  (`internal-urls/rule-protocol.ts:33`); `reloadSkillsAndRules` already accepts
  an in-memory `skills` roster (`extensibility/reload.ts:71,104`), and a `rules`
  param could join it.
- **skills** — *not* coherent in-memory. `Skill` carries only `filePath` /
  `baseDir`, no content field (`extensibility/skills.ts:18-32`), and
  `skill://<name>` reads the file at resolve time
  (`internal-urls/skill-protocol.ts:97`, `await Bun.file(targetPath).text()`).
  An injected `Skill` still points at a file that must exist on disk; in-memory
  skill *content* would mean adding a content field to `Skill` plus a VFS branch
  in every skill reader — large and invasive.
- **settings** — `settings.reload()` re-reads disk.
- **mcp** — a live `MCPManager` can be handed over at creation, but a config
  *refresh* rediscovers `.mcp.json` from disk and spawns each `command` as a
  subprocess (`tools/refresh.ts:51-53`).

So an in-memory provider is coherent for rules only and silently partial for
skills — a leaky API. The **pre-hook is the one mechanism uniform across every
refreshable surface**, and it matches how an embedded host naturally stages
config it pulls from a server: Compass gives each agent a container + repo clone
(`compass.md` §5.3), so writing fresh skill/rule/settings files into that
clone's config dirs and calling `refresh()` is the natural path — the files must
land on disk for `skill://` to serve them regardless. The hook fires before the
rescan so the host stages first, then OMP re-reads via the existing
`reloadSkillsAndRules` (`extensibility/reload.ts:97-131`).

**Extensions are out of scope for refresh.** `refresh()` covers
skills/rules/settings/mcp only (`REFRESH_SCOPES`, `extensibility/reload.ts:32`);
there is no extension-reload path in `refresh()`. Handing the session *new
extensions* is therefore not a refresh operation — it is picked up on session
recycle (the restart callback re-runs `createAgentSession`, which re-runs
extension discovery). See Resolved decision (d).

**New option** on `CreateAgentSessionOptions`:

```ts
/**
 * Awaited at the top of `AgentSession.refresh(scope)`, before any config
 * surface is re-read. Gives an embedded host the chance to pull fresh
 * skills/rules/settings/MCP config and WRITE it to the disk paths the
 * session scans; the refresh then re-reads from disk as usual. Receives
 * the scope so the host pulls only what is being refreshed. Unset => no-op
 * (existing behavior unchanged). A rejection aborts the refresh.
 */
onBeforeRefresh?: (scope: RefreshScope) => void | Promise<void>;
```

The name says what it is: a hook that runs *before* refresh, not a replacement
for it. `RefreshScope` is the existing exported union
(`extensibility/reload.ts:32-33`):

```ts
export const REFRESH_SCOPES = ["skills", "rules", "settings", "mcp", "all"] as const;
export type RefreshScope = (typeof REFRESH_SCOPES)[number];
```

**Threading.** `AgentSession.refresh(scope)` becomes a thin lock acquirer that
chains onto the refresh mutex and delegates to a private `#doRefresh(scope)`; the
`onBeforeRefresh` hook is the first statement *inside* the critical section,
before the `doRoster`/`doSettings`/`doMcp` branches (`agent-session.ts:6912-6915`
today), so the hook, every re-scan, and every swap are all under the one lock:

```ts
async refresh(scope: RefreshScope = "all"): Promise<RefreshResult> {
    // restart in progress: refuse a new refresh so nothing chains on behind the
    // one restart drains, and report the refusal (not a silent no-op).
    if (this.#restarting) return { refused: "restarting" };
    // serialize: chain onto the tail so overlapping callers run in order
    const run = this.#refreshTail.then(() => this.#doRefresh(scope));
    this.#refreshTail = run.then(() => {}, () => {}); // never reject the tail
    return run;
}

async #doRefresh(scope: RefreshScope): Promise<RefreshResult> {
    if (this.#onBeforeRefresh) await this.#onBeforeRefresh(scope);
    const doRoster = scope === "all" || scope === "skills" || scope === "rules";
    // ...existing re-scan / swap body...
}
```

Because it lives inside `refresh()` itself, it fires for every surface that
drives a refresh: the model-callable `RefreshTool`
(`tools/refresh.ts:85`, `await this.session.refresh(scope)` via the
`ToolSession.refresh` binding at `sdk.ts:1631`), the `/refresh` command path
(`slash-commands/builtin-registry.ts:1468`, `await runtime.session.refresh(scope)`),
and direct SDK calls.

**Error semantics: propagate.** If the host's pull throws, the refresh aborts
and the error reaches the refresh caller (the RefreshTool already surfaces
errors as tool errors). Rationale: a failed pull means the disk state is not
what the host intended; silently re-scanning stale disk would report a
"successful" refresh of the wrong content.

**Concurrency — serialized via an in-session refresh mutex.** `refresh()` has no
mutex today, and the hook widens the window: awaiting a host network pull at the
top stretches a millisecond-scale re-scan into a seconds-scale one, during which
a second `refresh()` (model `RefreshTool`, `/refresh`, or a direct host call) can
enter. `RefreshTool`'s `concurrency: "exclusive"` (`tools/refresh.ts:67`) only
serializes within one agent's tool batch, not against host-driven calls, so two
overlapping refreshes could interleave the separate `setActiveSkills`/
`setActiveRules`/settings/MCP swaps and leave the process holding skills from
pull A beside rules from pull B. Because the hook makes this window
deployment-real for the always-on multi-tenant target, this record closes it:
`refresh()` acquires a session-level mutex spanning the **whole** operation —
`onBeforeRefresh` hook, every disk re-scan, and every surface swap — so
concurrent callers run strictly one-at-a-time and each sees a fully-applied prior
refresh. The mechanism is a private promise-tail chain (`#refreshTail =
#refreshTail.then(runThisRefresh)`), the *serializing* sibling of
`#disposeCall`'s *coalescing* guard (`agent-session.ts:5861-5865`), whose
`#restartCall` analogue this record adds:
coalescing dedupes to one shared result, but two refreshes of different scopes
must both run, in order, so the tail chains rather than shares. Each caller still
gets its own `RefreshResult`. The abort guarantee is unaffected and now
lock-backed: the hook is the first statement inside the critical section, before
any surface is swapped, so a hook throw releases the mutex with all
roster/settings/MCP state untouched and no half-applied interleave visible to the
next waiter.

The same mutex is what `requestRestart()` drains: the restart latch refuses a
*new* refresh (the acquirer early-returns `{ refused: "restarting" }` while
`#restarting`), and restart
`await`s `#refreshTail` before dispose so an in-flight refresh's
`applyReloadedSkills` fan-out and `onBeforeRefresh` disk writes complete while
only the old session is registered — they cannot clobber the freshly-scanned
`#skills`/on-disk config the replacement re-reads for itself (Task 1 step 6,
decision (e)).

**Companion `onAfterRefresh` — not included.** A
`(scope, result: RefreshResult) => void | Promise<void>` companion would give
host observability, but `refresh()` already returns `RefreshResult`
(`reload.ts:39-50`) to whoever called it, and on the embedded path the host is
the caller. Non-load-bearing; can be added later without touching this
contract. (Recorded under Resolved decisions as an explicit non-blocking deferral.)

### Wiring

Both options travel the same road `onFirstChatDispatch` travels today:
`createAgentSession(options)` (`sdk.ts:1110`) reads them off
`CreateAgentSessionOptions` and threads them into the `AgentSession`
constructor config (`AgentSessionConfig`, `agent-session.ts:722`; the SDK
builds the session at `sdk.ts:2863`, `session = new AgentSession({ ... })`).
`AgentSessionConfig` gains the same two optional fields; `AgentSession` stores
them as `#onRestartRequested` / `#onBeforeRefresh` privates.

A model-callable `restart` tool is included (Resolved decision (a), Task 4):
`approval: "exec"` (auto-runs only in yolo mode; always prompts in always-ask /
write), guarded on the callback being bound, and — critically — it neither
inline-awaits `requestRestart()` nor schedules it as a tracked post-prompt task
(both self-deadlock): it fires the call from an untracked continuation and
reports pre-dispose refusals to the transcript. On the direct path the host
`await`s `requestRestart()` and a post-dispose throw rejects to it; on the model
path the continuation has no awaiting caller, so it catches the throw and logs it
(recovery via the durable session file — Task 4). Restart is
also drivable host-side directly (`session.requestRestart()` from the embedding
daemon).

## Alternatives considered

### In-memory content provider for refresh (rejected)

`onRefreshContent?: () => { skills: Skill[]; rules: Rule[]; ... }` — the host
hands content objects straight to the session. Coherent for **rules** only
(`Rule.content` exists and `rule://` serves from memory,
`internal-urls/rule-protocol.ts:33`); silently partial for **skills**, whose
content is read from `filePath` on disk at resolve time
(`internal-urls/skill-protocol.ts:97`) because `Skill` has no content field
(`extensibility/skills.ts:18-32`). Making it whole would need a content field on
`Skill` plus an in-memory VFS threaded through every skill reader — a large,
invasive change for no benefit over "stage to disk, then re-scan", which the
existing refresh machinery already does end to end and which is the natural path
for a host pulling config from a server anyway.

### OMP-side self-restart (execvp) in the embed (rejected)

The sealed SEA-1296 ACP design re-execs the OMP process. In the embedded model
there is no OMP process — the engine is a library in the host's module graph —
so self-re-exec would bounce the entire multi-agent host from one agent's
request. The cooperative callback is the only shape that respects the process
model. (Matt's frozen decision; recorded for completeness.)

### Restart via a `SessionShutdownEvent`-style extension event (rejected)

`SessionShutdownEvent` (`shared-events.ts:92-94`) is a process-exit
notification fanned to extensions, not a host contract: no payload targeting a
re-attach, no awaited host acknowledgment, and extension handlers are the wrong
audience (the host embeds the SDK; it is not an extension). A first-class SDK
option matches the existing `onFirstChatDispatch` precedent and keeps the
contract typed.

### Worker-thread-per-agent (forward-compat note, not designed here)

A future Compass architecture could run each agent in its own worker thread,
making per-agent code swap possible without a host bounce. The callback
contract is compatible: the worker becomes the "host" that receives
`onRestartRequested` and recycles itself. Explicitly out of scope.

## Plan

### Global Constraints

- TypeScript strict mode; no `any`, no non-null assertions to paper over the
  `sessionFile: string | undefined` reality.
- Formatting/linting via biome (repo standard); tests via `bun test`.
- Personal-repo commit identity (Matt + seal co-author trailer,
  `rule://commit-conventions`); branch `omp-sdk-lifecycle-callbacks-design`
  lineage, PRs via `gt submit`.
- No execvp / process re-exec anywhere in oh-my-pi — restart is cooperative
  callback only.
- Existing behavior unchanged when neither callback is set: `refresh()`
  byte-identical no-op path preserved (prompt caching), no new tool registered.
- Tests are authored by the Tester agent per `rule://red-green-testing`
  (red first, then implement); the matrices below are the contract for those
  tests, not inline test code.
- New public API carries doc comments in the style of the surrounding
  `CreateAgentSessionOptions` fields (`sdk.ts:384-578`).

### Task 1 — `onRestartRequested` option + `AgentSession.requestRestart()`

Add the option to `CreateAgentSessionOptions` (next to `onFirstChatDispatch`,
`sdk.ts:574`) and to `AgentSessionConfig` (`agent-session.ts:722`); thread it
through the `new AgentSession({ ... })` construction site (`sdk.ts:2863`).
Implement `requestRestart()` on `AgentSession` with the sequence from the
Approach: return the in-flight `#restartCall` if one exists → unbound guard →
no-session-file guard → busy guard (`hasQueuedMessages()`) — these return
`{ ok: false }` without latching or caching → set `#restarting` latch (refuse new
turns *and* new refreshes, pause async-job delivery) and cache the committed
attempt on `#restartCall` → `waitForIdle()` → capture durable `getSessionId()` +
`sessionFile` → `flush()` + `ensureOnDisk()` → `await #refreshTail` (drain
in-flight refresh; Task 2's mutex) → `dispose()` → `await` callback → `{ ok: true }`.
Wrap the latch-and-fallible-ops region: a throw before `dispose()` begins (detected
via `#disposeCall` unset) clears `#restarting` and `#restartCall` then rethrows, so
the session resumes and the host can retry; a throw at or after `dispose()` stays
terminal (decision (h)).

Interfaces:

```ts
// sdk.ts — CreateAgentSessionOptions
onRestartRequested?: (
    info: { sessionId: string; sessionFile: string },
) => void | Promise<void>;

// agent-session.ts — AgentSessionConfig
onRestartRequested?: (
    info: { sessionId: string; sessionFile: string },
) => void | Promise<void>;

// agent-session.ts — AgentSession
export type RequestRestartResult =
    | { ok: true }
    | { ok: false; reason: "unavailable" | "no-session-file" | "busy" };
async requestRestart(): Promise<RequestRestartResult>;
```

Consumes: `this.waitForIdle()` (`agent-session.ts:6086`),
`sessionManager.getSessionId()` (`session-manager.ts:1295`) + `this.sessionFile`
getter (`agent-session.ts:7333-7335`),
`sessionManager.flush()` / `ensureOnDisk()` (`session-manager.ts:1185`,
`:1177`). Produces: the awaited host callback invocation with the captured
info; errors from the callback propagate.

Test cycle (Tester agent, red → green):

- callback fires exactly once with the session's durable identity —
  `sessionId` equals `sessionManager.getSessionId()`, `sessionFile` equals the
  session file path;
- returns `{ ok: false, reason: "unavailable" }` and does NOT flush when no
  callback is bound;
- returns `{ ok: false, reason: "no-session-file" }` for an in-memory session
  (`SessionManager.inMemory()`), callback not invoked;
- durability: a message appended before `requestRestart()` is readable from
  `sessionFile` inside the callback (re-open the file in the callback body);
- async callback is awaited: `requestRestart()` does not resolve before the
  callback's promise settles;
- sibling isolation: two sessions in one process; session A's
  `requestRestart()` invokes only A's callback with A's info, session B's
  state untouched (B still prompts successfully after);
- a throwing callback rejects `requestRestart()` with that error.
- re-entrancy: two concurrent `requestRestart()` calls invoke the host callback
  exactly once and both resolve to the same result (shared in-flight promise).
- latch: while a `requestRestart()` is in flight, a concurrently-started prompt
  does not begin a new turn (no transcript append past the durability barrier);
- busy guard: `requestRestart()` returns `{ ok: false, reason: "busy" }` and
  does NOT dispose when `agent.hasQueuedMessages()` is true at entry;
- dispose-first: the session is disposed before the host callback fires (the
  callback observes a disposed session; OMP does not write the file afterward).
- refresh coordination (regression for the drain/refuse gap): with a slow
  `onBeforeRefresh` hook in flight, a concurrent `requestRestart()` awaits the
  in-flight `refresh()` (its `applyReloadedSkills`/roster swaps complete) before
  dispose, AND a `refresh()` *started* after the `#restarting` latch is set
  early-returns without re-scanning — assert restart does not dispose until the
  in-flight refresh settles, and the post-latch refresh performs no swap.
- pre-dispose failure recovery (decision (h)): force a pre-dispose step to reject
  (e.g. stub `ensureOnDisk()` to throw) and assert `requestRestart()` rejects, the
  `#restarting` latch is dropped (a subsequent prompt starts a turn and `refresh()`
  is no longer refused), `#restartCall` is cleared, and a second `requestRestart()`
  runs the full sequence to `{ ok: true }`; separately, a callback throw *after*
  dispose leaves the session terminal (no unlatch, a retry does not re-dispose).

### Task 2 — `onBeforeRefresh` option + refresh mutex, threaded into `refresh()`

Add the option to `CreateAgentSessionOptions` and `AgentSessionConfig`; store
as `#onBeforeRefresh`. Split `refresh()` into a thin lock acquirer that chains
onto a private `#refreshTail` mutex and a `#doRefresh(scope)` critical section;
make the awaited `onBeforeRefresh` call the first statement of `#doRefresh`,
before the `doRoster`/`doSettings`/`doMcp` scope flags are computed
(`agent-session.ts:6912-6915` today). The mutex spans the hook, every re-scan,
and every surface swap, so overlapping refreshes cannot interleave (see
Approach → Concurrency).

Interfaces:

```ts
// sdk.ts — CreateAgentSessionOptions
onBeforeRefresh?: (scope: RefreshScope) => void | Promise<void>;

// agent-session.ts — AgentSessionConfig
onBeforeRefresh?: (scope: RefreshScope) => void | Promise<void>;

// agent-session.ts — AgentSession private mutex tail
#refreshTail: Promise<unknown> = Promise.resolve();

// extensibility/reload.ts — RefreshResult gains a refusal marker so a refresh
// refused while #restarting is distinguishable from a successful no-op
refused?: "restarting";

// tools/refresh.ts — summarizeRefresh() renders the refusal instead of
// collapsing it into "nothing to reload"; RefreshTool.execute (refresh.ts:87)
// and the /refresh command (builtin-registry.ts:1469) both route through it and
// inherit the message with no branch of their own
if (result.refused) return `Refresh skipped (${scope}): restart in progress.`;

// agent-session.ts — refresh() chains onto the tail, delegates to #doRefresh;
// onBeforeRefresh is the first statement inside #doRefresh (the critical section)
if (this.#onBeforeRefresh) await this.#onBeforeRefresh(scope);
```

Consumes: `RefreshScope` (`extensibility/reload.ts:32-33`). Produces: a
serialized `refresh()` whose critical section opens with the awaited pre-hook
before any disk re-scan; rejection aborts that refresh and propagates to the
caller (RefreshTool / `/refresh` / direct SDK call) while releasing the mutex for
the next waiter.

Test cycle (Tester agent, red → green):

- hook fires before any re-scan with the exact scope passed (spy ordering
  against a stubbed `reloadSkillsAndRules` or a marker file read);
- async hook is awaited (refresh result not produced until hook settles);
- no-op when unset: `refresh()` result identical to today's behavior
  (existing `refresh-*.test.ts` suites stay green untouched);
- write-then-rescan surfaces new disk content: the hook writes a new rule
  file; after `refresh("rules")`, `rule://<name>` resolves it
  (`rule-protocol.ts` path; discovery re-scan via `reloadSkillsAndRules`,
  `reload.ts:97-131`);
- a throwing hook rejects `refresh()` and no surface is re-read (roster
  globals unchanged);
- hook fires on the RefreshTool path too (`RefreshTool.execute` →
  `session.refresh`, `tools/refresh.ts:85`);
- mutex serializes overlapping refreshes: with a hook that blocks on a released
  gate, start `refresh("skills")` then `refresh("rules")` before releasing —
  assert the second hook does not start until the first refresh fully resolves
  (record hook-enter / refresh-exit ordering), so no interleave of the separate
  surface swaps;
- mutex survives a throwing refresh: a first refresh whose hook rejects still
  releases the lock, and a subsequent `refresh()` runs normally (the tail never
  stays rejected).
- restart refusal: while `#restarting` is set, `refresh()` returns
  `{ refused: "restarting" }` without chaining onto `#refreshTail` or re-scanning
  (assert no `onBeforeRefresh` call, no surface swap, and the marker is present).
- refused marker renders, not "nothing to reload": `summarizeRefresh` on a
  `{ refused: "restarting" }` result returns "Refresh skipped (<scope>): restart
  in progress." (assert the exact string, and that `RefreshTool.execute` /
  `/refresh` surface it — not the empty-`RefreshResult` no-op summary).

### Task 3 — SDK wiring + docs

Thread both options from `createAgentSession(options)` (`sdk.ts:1110`) into
the `AgentSession` construction (`sdk.ts:2863`), mirroring how the other
config callbacks travel. Document the host re-attach recipe on
`onRestartRequested` (OMP already disposed → host
`SessionManager.open(sessionFile)` (`session-manager.ts:1920`) →
`createAgentSession`; never create-before-dispose) and the
write-to-disk-then-rescan contract on `onBeforeRefresh`. Update the SDK README
section on embedded hosts if one exists in this repo's README.

Interfaces:

```ts
// sdk.ts — createAgentSession, AgentSession construction site
session = new AgentSession({
    // ...existing config...
    onRestartRequested: options.onRestartRequested,
    onBeforeRefresh: options.onBeforeRefresh,
});
```

Consumes: Tasks 1-2 fields. Produces: end-to-end SDK surface.

Test cycle (Tester agent, red → green):

- integration: `createAgentSession({ onRestartRequested })` →
  `session.requestRestart()` fires the host callback (full SDK path, not a
  hand-built `AgentSession`);
- integration: `createAgentSession({ onBeforeRefresh })` →
  `session.refresh("skills")` fires the hook before the roster re-scan.

### Task 4 — model-callable `restart` tool

A `RestartTool` in `src/tools/`, `approval: "exec"` (auto-runs only in yolo
mode; always prompts in always-ask / write — same tier and reasoning as
`RefreshTool`, `tools/refresh.ts:51-57`), guarded on the callback being bound
exactly as RefreshTool guards on `session.refresh` (`tools/refresh.ts:78`),
returning "Restart is unavailable in this session." when unbound.

**Critical shape: run `requestRestart()` from an untracked post-drain hook.**
Two mechanisms are wrong; the third is the contract.

- *Inline await (wrong).* Step 3 of the sequence is `await waitForIdle()`, which
  resolves only when the current turn settles — but the turn cannot settle while
  it is blocked inside the tool's `execute()`. A circular wait that hangs the
  turn forever.
- *Tracked post-prompt task (also wrong — the subtle one).* Scheduling
  `requestRestart()` via `#schedulePostPromptTask` (`agent-session.ts:4328-4353`)
  does not fix it: that scheduler always registers the task in `#postPromptTasks`
  (`#trackPostPromptTask`, `agent-session.ts:4352` → `:4316`). `requestRestart()`
  then waits on a set that contains itself, two ways: (i) its own step-3
  `waitForIdle()` → `#waitForPostPromptRecovery()` awaits `#postPromptTasksPromise`
  (`agent-session.ts:4470-4471`), which resolves only when `#postPromptTasks`
  empties (`:4322-4323`); (ii) the `dispose()` in step 6 awaits
  `#cancelPostPromptTasks()` → `Promise.allSettled(pendingTasks)`
  (`:4438`/`:4444`). Either way the scheduled restart task is *in* the set being
  awaited → self-deadlock. `#schedulePostPromptTask`'s `AbortSignal` (`:4333`)
  does not rescue it: the task is synchronously deep in `waitForIdle`/`dispose`,
  not parked at an abort checkpoint.
- *Untracked continuation (the contract).* `execute()` returns immediately
  with an acknowledgement, then fires `requestRestart()` from a continuation
  **not** registered in `#postPromptTasks` (never through
  `#schedulePostPromptTask`, which always tracks — `:4352`→`:4316`).
  Deadlock-freedom comes from that untracked-ness, *not* from timing: absent
  from `#postPromptTasks`, the continuation sits in neither set
  `requestRestart()` drains — `#waitForPostPromptRecovery`'s
  `await #postPromptTasksPromise` (`:4470-4471`) nor `dispose()`'s
  `Promise.allSettled` (`:4438`/`:4444`) — so its own step-3 `waitForIdle()`
  and step-6 `dispose()` await a set that structurally excludes it.
  (`requestRestart()`'s step-3 `waitForIdle()` supplies the "let this turn
  settle" wait, so the continuation need only be untracked, fired at the
  post-prompt idle transition — not a bare `queueMicrotask` inside `execute()`
  masquerading as post-drain.) Result reporting splits on dispose ordering: the
  **pre-dispose refusals** (`{ ok: false, reason: "busy" | "unavailable" |
  "no-session-file" }`, all returned before step-6 dispose) are written to the
  still-open transcript as a system notice, so the model sees them. A
  **post-dispose failure** — the host callback throwing after dispose closed the
  append writer (`session-manager.ts:1246`) — has no transcript left to append
  to. `requestRestart()` still rejects, but who receives it splits by path: on
  the direct SDK path the host `await`s the call and owns re-attach/recovery
  (step 7); on the model path the continuation is untracked with no awaiting
  caller, so it attaches `.catch(err => logger.error(...))`, following OMP's
  fire-and-forget catch+log pattern — the IRC wake at `agent-session.ts:2100`
  (`void this.agent.prompt(...).catch(logger.warn)`; warn there for a recoverable
  wake, error here because a lost restart is not recoverable), explicitly not the
  empty `.catch(() => {})` swallow at `#trackPostPromptTask` (`:4319`), which would
  re-hide the failure this catch exists to surface. The failure is operator-visible via
  the log, and recovery is via the durable session file flushed at step 5, since
  dispose has closed the transcript. The `execute()` ack means
  "scheduled", not "restarted". `RefreshTool` is NOT a valid template —
  `session.refresh()` (`sdk.ts:1631`) never waits for turn idle, so it can be
  awaited inline; restart cannot.

Interfaces:

```ts
// tools/restart.ts
export class RestartTool
    implements AgentTool<typeof restartSchema, RestartToolDetails>
{
    readonly name = "restart";
    readonly approval = "exec" as const;
    // execute(): guard the binding, return an acknowledgement result, then fire
    // requestRestart() from an UNTRACKED continuation (never through
    // #schedulePostPromptTask). Report pre-dispose refusals to the transcript;
    // a post-dispose callback throw has no awaiting caller here — catch + log it
    // (recovery via the durable session file), do not leave it unhandled.
}

// tools/index.ts — ToolSession (next to refresh, index.ts:390)
requestRestart?: () => Promise<RequestRestartResult>;
```

Test cycle (Tester agent, red → green):

- refuses with a clear message when the session has no `requestRestart`
  binding or the callback is unbound;
- does NOT deadlock: the tool call returns while a turn is in flight, and
  `requestRestart()` runs after the turn settles (assert the host callback
  fires post-turn, not during `execute()`). Regression guard for the tracked-task
  trap: the scheduled restart must complete — a version that enqueues it into
  `#postPromptTasks` hangs here (self-inclusion in the drained set), so the test
  fails closed if an executor reaches for `#schedulePostPromptTask`;
- reports the real outcome, split on dispose ordering: a pre-dispose refusal
  (`{ ok: false, reason: "busy" }`, input queued after the ack) is surfaced to
  the still-open transcript, not swallowed behind the `execute()` success ack; a
  post-dispose host-callback throw on the model path is caught and logged (no
  awaiting caller; assert it neither goes unhandled nor silently vanishes, and
  the durable session file remains re-attachable);
- requires exec approval (mirror `refresh-tool.test.ts`'s
  `requiresApproval` coverage).

## Tasks

- [ ] Task 1 — `onRestartRequested` option + `AgentSession.requestRestart()`
      (re-entrancy + busy guards, latch that also refuses new refreshes, capture,
      durability barrier, drain `#refreshTail` before dispose, dispose, awaited
      callback, pre-dispose failure unlatches while post-dispose stays terminal
      (decision (h)); tests) — the drain/refuse depends on Task 2's `#refreshTail`
- [ ] Task 2 — `onBeforeRefresh` option + refresh mutex, threaded into
      `AgentSession.refresh()` (serialized critical section, awaited hook,
      propagate-on-throw + lock-release, no-op unset, acquirer early-returns
      `{ refused: "restarting" }` while `#restarting`, `summarizeRefresh` renders
      that marker so `RefreshTool`/`/refresh` report the refusal; tests)
- [ ] Task 3 — SDK wiring through `createAgentSession` + host-recipe docs
      (integration tests)
- [ ] Task 4 — model-callable `restart` tool (`approval: "exec"`, untracked
      post-drain scheduling + result reporting, unbound guard; tests)

## Resolved decisions

All design forks are decided; the record is ready to freeze. Entries below
carry the decision and its grounded rationale.

### (a) Model-callable `restart` tool — included

The model can invoke restart via a `restart` tool (Task 4), alongside
host-driven `session.requestRestart()`. `approval: "exec"` (auto-runs only in
yolo mode; always prompts in always-ask / write), guarded on the callback being
bound, mirroring how `refresh` guards on `session.refresh`
(`tools/refresh.ts:78`). The tool returns an acknowledgement, then fires
`requestRestart()` from an untracked continuation (never an inline await, and
never a tracked `#postPromptTask` — both deadlock; see Task 4). Reporting splits
on dispose ordering: a pre-dispose refusal
(`busy`/`unavailable`/`no-session-file`) is written to the still-open transcript
so the model sees it; a post-dispose callback throw has no awaiting caller on the
model path, so the untracked continuation catches and logs it (recovery via the
durable session file), since dispose has already closed the transcript.

### (b) Teardown ordering — OMP disposes before the callback

The alternative (host owns teardown, keeps the old session alive for a
blue/green recycle) is **unsafe in-process**: creating the replacement before
disposing the old session builds it while the old `AsyncJobManager` singleton is
still set, so the guard `!AsyncJobManager.instance()` (`sdk.ts:1505-1506`) hands
the replacement **no async job manager** — background `bash`/`task` silently
broken (issue #1923, `sdk.ts:1497-1504`) — and the lock-free append writer
(`session-storage.ts`, plain `fs.openSync(fpath, "a")`, no `flock`) leaves two
writers on one session file. So OMP disposes the session before invoking the
callback; blue/green is not actually reachable given those constraints.
`dispose()` is idempotent (`agent-session.ts:5861-5865`), so a host that also
calls it is harmless.

### (g) Refresh concurrency — serialize with an in-session mutex

`refresh()` has no mutex today; the `onBeforeRefresh` pre-hook stretches the
critical section from a millisecond re-scan to a seconds-scale network pull, so
two overlapping refreshes (host-driven + `/refresh`, or two host calls) could
interleave the separate `setActiveSkills`/`setActiveRules`/settings/MCP swaps and
leave the process publishing config from two different pulls. Chosen: close it in
this contract with a session-level mutex over the whole operation (hook + rescans
+ swaps), mechanized as a `#refreshTail` promise chain — the serializing sibling
of `#disposeCall`'s coalescing guard (`agent-session.ts:5861-5865`), whose
`#restartCall` analogue this record adds; coalescing dedupes to one result, but two refreshes
of different scopes must both run in order, so the tail chains rather than shares.
Rejected: leaving it documented as a known non-guarantee. The race pre-exists the
hook, but the hook makes it deployment-real for the always-on multi-tenant target
this record serves, and a design record that adds the widening hook should not
ship the widened race unclosed. `RefreshTool`'s `concurrency: "exclusive"`
(`tools/refresh.ts:67`) is not sufficient — it only serializes within one agent's
tool batch, not against host-driven or `/refresh` calls.

A refresh refused because a restart is in progress returns
`{ refused: "restarting" }` (a new `RefreshResult` marker) rather than an empty
result. Today every caller funnels through `summarizeRefresh` (`tools/refresh.ts:36`),
which reads only the populated-surface counts, so it renders an empty result as
"Refreshed (all): nothing to reload." — reporting the refusal *as* a successful
no-op. Task 2 therefore gives `summarizeRefresh` a leading `refused` branch
("Refresh skipped (<scope>): restart in progress."); `RefreshTool` (`refresh.ts:87`)
and `/refresh` (`builtin-registry.ts:1469`) both route through it and inherit the
message. So a caller can tell a refused refresh from a successful no-op — the same
anti-silent-lie stance as the hook-throw error semantics above.

### (e) Restart latch — `requestRestart()` latches, not just waits

`waitForIdle()` (`agent-session.ts:6086-6089`) is a *wait*, not a *latch*: after
it resolves, an IRC wake (`#promptIrcRecords`, fire-and-forget
`void this.agent.prompt`), an async-job completion enqueued to `yieldQueue`
(`sdk.ts:1509-1522`), a queued-message drain (`agent-session.ts:8478-8495`), or
a host `prompt()` could start a new turn and append past the durability barrier;
it also misses in-flight starts that `isStreaming` counts via
`#promptInFlightCount` (`agent-session.ts:6077-6078`) but `waitForIdle` does
not, and in-memory steering/follow-up queues (`agent.hasQueuedMessages()`, the
raw `#steeringQueue`/`#followUpQueue` predicate at `packages/agent/src/agent.ts:888-890`,
not the displayable-filtered `sdk.ts:2208` field) are never persisted. So `requestRestart()` sets a `#restarting`
latch before the wait (refusing new turns, refusing to *start* a new `refresh()`,
and pausing async-job delivery through the callback) and refuses with
`{ ok: false, reason: "busy" }` when input is queued at entry. Because the latch
turns away only *new* refreshes, restart also `await`s `#refreshTail` before
dispose (Task 1 step 6) to drain a refresh already in its critical section — its
in-memory `applyReloadedSkills` fan-out and `onBeforeRefresh` disk writes must
complete while only the old session is registered, so they cannot clobber the
`#skills`/config the replacement re-scans for itself (decision (g)). This makes the durability promise true for the always-on agents
Compass drives (Dispatcher / Warden, `compass.md` §4.2/§4.3), which cannot
guarantee external idleness. Rejected: snapshot + documented "call only when
externally idle" precondition — cheap, but an always-on multi-tenant host cannot
reliably honor it, so it would drop transcript tails and parked input in exactly
this record's target deployment.

### (h) Pre-dispose failure unlatches; post-dispose failure is terminal

The re-entrancy guard caches `#restartCall` the way `dispose()` caches
`#disposeCall` (decision (e), `agent-session.ts:5861-5865`), but the two failure
modes are not symmetric. `dispose()` is one-way, so caching its settled promise
forever — resolved or rejected — is correct. `requestRestart()` sets the
`#restarting` latch (step 3) and then runs fallible work while the session is
*still alive*: `waitForIdle()`, the `flush()`/`ensureOnDisk()` durability barrier
(step 5), and the `#refreshTail` drain (step 6, before `dispose()`). If any of
these throws, a naive shared-promise cache strands the session — `#restarting`
stays set (new turns reject, `refresh()` returns `{ refused: "restarting" }`) and
`#restartCall` holds the rejection, so every later `requestRestart()` replays the
stale error: a live but permanently wedged session. A transient `ENOSPC` on
`flush()` would trigger exactly this on the always-on Compass hosts this record
serves.

Chosen: a pre-dispose failure is *recoverable*. The latch-and-fallible-ops region
is wrapped; on a throw with `#disposeCall` still unset (dispose has not begun) it
clears both `#restarting` and `#restartCall`, then rethrows. The session resumes
normal turns and refreshes immediately; recovery does not depend on a retry. A
caller that observes the rejection (the direct-await path of step 7, not the model
tool's catch-and-log) may then call `requestRestart()` again. Only a failure at or
after `dispose()` stays terminal:
the callback throw of step 7, the old session already gone, with nothing to
unlatch and no retry that may re-dispose.

```ts
// requestRestart(), synchronous prefix:
this.#restarting = true;                          // latch (step 3), before any await
this.#restartCall = this.#doRequestRestart();     // coalesce the committed attempt

// inside #doRequestRestart (async): waitForIdle → barrier → drain → dispose → callback
try {
    /* ...the fallible restart work... */
} catch (err) {
    if (!this.#disposeCall) {           // threw before dispose began — recoverable
        this.#restarting = false;
        this.#restartCall = undefined;  // drop the cache so the host can retry
    }
    throw err;                          // post-dispose (callback) failure stays terminal
}
```

Rejected: hold `#restarting` after a pre-dispose failure and add a separate
unlatch affordance — a transient disk hiccup during a hygiene-recycle would park a
live always-on agent until manual intervention, against the
durability-for-always-on goal; terminal-bricking behind a documented
non-guarantee is worse still. Surfaced as Greptile P1 on the round-7 review;
Matt's call.

### Refresh callback shape: disk pre-hook, not an in-memory provider

`onBeforeRefresh(scope)` is a pre-hook — the host stages fresh config to the
disk paths the session scans, then OMP re-reads. Not an in-memory content
provider: that shape is coherent for rules only and silently partial for skills
(whose content is read from `filePath` at resolve time,
`internal-urls/skill-protocol.ts:97`; `Skill` has no content field,
`extensibility/skills.ts:18-32`). Full rationale in Approach → "Why a pre-hook,
not an in-memory content provider".

### (c) In-memory sessions (`sessionFile === undefined`) refuse restart

`getSessionFile()` returns `string | undefined` (`session-manager.ts:1299`). An
in-memory session has no re-attach handle, so `requestRestart()` returns
`{ ok: false, reason: "no-session-file" }` and the callback payload keeps
`sessionFile: string` non-optional — every bound host's happy path stays
type-safe. A host that wants restartable agents opts into persistence.

### (d) Extensions ride restart, not refresh

Matt's ask named "skills/settings/**extensions**", but `refresh()` has no
extension-reload path — `REFRESH_SCOPES` is skills/rules/settings/mcp
(`extensibility/reload.ts:32`). New extension *code* is picked up on session
recycle: the restart callback's re-attach recipe calls `createAgentSession`,
which always re-runs `loadExtensions` (`sdk.ts:1891`/`:1899`) while the reopened
session file replays the conversation. True *in-session* hot-reload (swapping
extensions under a live session object) is deliberately excluded: extensions
register across five subsystems (`#toolRegistry`; `modelRegistry` providers +
models, `sdk.ts:1927-1935`; the runner's flags/shortcuts/commands/handlers,
`runner.ts:361-517`; message/thinking renderers; system-prompt contributions)
and there is no per-extension teardown hook — only fire-and-forget
`session_shutdown` (`runner.ts:80-86`) — so an in-place swap would leak any
pipe/timer/subprocess an extension holds until a dispose lifecycle is added.
That is its own design record if Compass ever needs it. The result is a clean
three-tier model: **`refresh`** for in-session config surfaces (skills / rules /
settings / mcp), **`restart`** (session recycle) for extensions and everything
else frozen at creation — project context / `AGENTS.md`, slash commands and
prompt templates, the tool roster, and the model/provider registry (none has a
re-read path in `refresh()`, `REFRESH_SCOPES`, `reload.ts:32`) — and **host
process bounce** for a new OMP/Compass binary. A host that stages a frozen
surface and calls `refresh("all")` gets a silent no-op for it, so those surfaces
must go through restart; the option doc comments say which tier each belongs to.

### (f) Process topology: one embedded engine per process

Compass runs each agent in its own rootless-podman container with its own engine
(`compass.md` §5.3, "Each agent runs in its own container"; §7.1). This record
designs for that: exactly one top-level `AgentSession` per process. It makes the
multi-agent invariant structural (no siblings share the process, so
`createAgentSession`'s process-global swaps —
`setActiveSkills`/`setActiveRules`/`MCPManager.setInstance`, the `AsyncJobManager`
singleton — disturb nothing) rather than a doc-comment promise. If a future host
multiplexes several top-level engines in one process, per-session scoping of
those globals is a prerequisite and gets its own record. This is Matt's frozen
product topology (§5.3); flagged in the `ask` so he can correct it if the
deployment changes.

### Non-load-bearing deferral: `onAfterRefresh(scope, result)`

Host observability companion. Deferred — on the embedded path the host is the
`refresh()` caller and already receives `RefreshResult` (`reload.ts:39-50`)
directly. Can be added later without touching this contract.
