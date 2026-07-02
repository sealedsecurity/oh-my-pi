# Cross-session comms-bus delivery (OMP fork)

## Problem / Intent

An external MCP server (the comms bus, SEA-1020) lets separate OMP sessions
message each other. Its **pull** tier (`wait`/`roster`/`inbox`) needs nothing
from OMP. This change adds the two **push** tiers — delivering a message *into* a
running OMP session — plus the presence hook the bus needs to address a session:

- **F1 `message` tier** — ambient "N unread bus messages" reminder, no polling.
- **F2 `ping` tier** — urgent message carried into the agent as a steer
  (mid-turn → non-interrupting aside at the next step boundary; idle → wakes a
  turn), reusing the exact in-session IRC delivery path.
- **F3 presence** — each session advertises `{agent_id, codename, endpoint,
  token}` at register and withdraws at exit, so the bus can reach it.

## Approach

**F2 ships as F2a (per-session local socket), not F2b (MCP notification).**
Verified this session: the bus sits behind LiteLLM as an aggregated server, and
LiteLLM **drops server→client MCP messages in transparent-proxy mode** — *"the
gateway only proxies client→server messages. When an upstream MCP server sends
[a server-initiated message], the message has no path back to the client and is
silently dropped"* ([BerriAI/litellm#23761](https://github.com/BerriAI/litellm/issues/23761),
closed stale/unimplemented 2026-06-22). So an F2b steer-notification would never
fire today. F2a bypasses the gateway: the bus POSTs directly to a Unix socket in
the session's runtime dir.

**F2b remains the long-term goal.** The design routes *both* transports through
one internal seam — `SteerBridge.deliver()` → `AgentSession.deliverIrcMessage()`
— so when LiteLLM grows Mode A relay (tracked as a separate LiteLLM-fork issue,
out of this repo's scope), F2b becomes a second caller of the same bridge with
no change to the delivery core. The MVP builds F2a; F2b is explicitly deferred,
not stubbed.

### Why reuse `deliverIrcMessage`

The steer/aside/wake behavior the `ping` tier needs already exists verbatim for
in-session IRC (`agent-session.ts:12863`, verified):

```ts
async deliverIrcMessage(msg: IrcMessage, opts?): Promise<"injected" | "woken"> {
    if (this.#isDisposed) throw new Error("Recipient session is disposed.");
    // ...builds a custom `irc:incoming` record...
    void this.#emitSessionEvent({ type: "irc_message", message: record });
    if (this.isStreaming) { this.#pendingIrcAsides.push(record); return "injected"; }
    this.#wakeForIrc([record]);                       // idle → real turn
    return "woken";
}
```

Mid-turn asides drain at the next step boundary via the aside provider
(`agent-session.ts:1873`); idle wake is `#wakeForIrc` (`agent-session.ts:1681`).
The only gap is that `IrcBus` is a **process-global singleton**
(`irc/bus.ts:49-50`, `static #global`) that routes by looking the recipient up
in `AgentRegistry.global()` and calling `deliverIrcMessage` on its session
(`bus.ts:105,142-148`) — it can't be *driven* cross-process. F2a adds one
cross-process front door that performs the **same registry lookup + call**.

### Component shape — one shared per-process broker

A single `SessionDeliveryBroker` per OMP process owns **one** Unix socket and
routes each incoming frame by `frame.to` (agent id) through
`AgentRegistry.global()` — exactly mirroring `IrcBus.send` (`bus.ts:105`). This
covers the main agent and every subagent in that process through one FD, instead
of a socket per session. Per-agent auth still holds: each agent's minted token is
checked against `frame.to`.

```
bus (external) --POST /deliver {to,from,body,...}--> [one Unix socket per PROCESS]
                                              |            $XDG_RUNTIME_DIR/omp/<pid>.sock
                                    SessionDeliveryBroker (new)
                                     token check (per frame.to) + registry lookup
                                              |
                                     SteerBridge.deliver(agentId, frame)  (new seam)
                                              |
                                AgentSession.deliverIrcMessage()  (existing)
                                     injected | woken   → irc_message event → TUI card

Future front-ends, same SteerBridge seam:
  F2b (later):  MCP steer-notification → #handleServerNotification (generalized)
  post-MVP:     NATS/broker subscription → SteerBridge.deliver (see "Post-MVP")
```

- **F1** is independent of the socket: it rides the existing
  `setOnResourcesChanged` → `yieldQueue.enqueue("mcp-notification")` path
  (`sdk.ts:2946-2959`) with a dedicated dispatcher that renders an unread card,
  plus auto-subscription of bus resources so the client needn't hand-subscribe.

### Post-MVP: external message broker (NATS et al.)

The Unix socket is deliberately the thinnest transport that works today (local,
no deps, no gateway). It is **one front-end onto `SteerBridge`**, not the
architecture. If cross-host delivery or fan-out/durability is later needed, a
broker (NATS is the natural fit — lightweight, subject-based `agent.<id>.steer`
routing, JetStream for durable `message`-tier mail) slots in as another
front-end calling `SteerBridge.deliver` — no change to the delivery core or the
`irc:incoming` contract. This is explicitly **deferred**: the MVP ships the
socket + `SteerBridge` seam, and a follow-up issue captures the broker option
(evaluate NATS vs. staying socket-only once multi-host is a real requirement).
Not built now; documented so the seam is designed for it.

## Global Constraints

- **Package:** all code under `packages/coding-agent/src/...` in the OMP fork
  (`mattwilkinsonn/oh-my-pi`), branch `omp-comms-bus--polo` off `main` (v16.2.6+).
- **No prompts in code** — the reminder + injected-ping copy live in `.md` files
  imported with `{ type: "text" }`; dynamic bits via Handlebars (repo rule).
- **Injected content is non-authoritative** (compass §6.7): a delivered body is
  *content the agent is told about*, never instructions it must follow. Reuse the
  existing `irc:incoming` framing verbatim — it already establishes this.
- **Auth mandatory:** the broker rejects any frame whose `Authorization` token
  doesn't match the minted secret for that frame's `to` agent. Socket dir is
  `0700`, socket `0600`. No/wrong token → no delivery (prevents arbitrary
  same-user procs from steering any agent).
- **No `console.*`** — use `logger` (repo rule). **No `mock.module()`** in tests;
  `spyOn` the imported object. **Bun APIs** (`Bun.serve({ unix })`, `Bun.file`)
  over `node:*` where they cover it.
- **F2b is deferred, not built** — no dead notification-handler branch that
  silently no-ops. The `SteerBridge` seam is the only forward-looking surface,
  and it is exercised by F2a, so it is live code, not a stub.
- **Loopback/local only** — one Unix domain socket per process under
  `$XDG_RUNTIME_DIR/omp/` (fallback `os.tmpdir()/omp-run`, `0700`, matching the
  shell-snapshot precedent at `utils/shell-snapshot.ts:238`); no TCP port, no
  network listener.

## Plan

### T1 — `SteerBridge`: the delivery seam
`session/steer-bridge.ts` (new). A stateless module that resolves an agent id via
`AgentRegistry.global()` and calls `deliverIrcMessage` on its live session —
mirroring `IrcBus.send` (`bus.ts:105,142-148`). The single funnel every transport
(socket now, F2b/NATS later) calls; no per-session state.
- **Interfaces:**
  - `deliver(agentId: string, frame: SteerFrame): Promise<DeliveryOutcome>`
  - consumes `SteerFrame = { from: string; body: string; replyTo?: string; urgent?: boolean }`
  - produces `DeliveryOutcome = "injected" | "woken" | "unknown-agent" | "disposed"`
  - resolves `AgentRegistry.global().get(agentId)?.session` (`agent-registry.ts:65`), returns `"unknown-agent"` when absent/aborted/advisor (mirror `bus.ts:106-116`)
  - calls `AgentSession.deliverIrcMessage(msg, { expectsReply: frame.urgent })` (`agent-session.ts:12863`); `toIrcMessage` mints `IrcMessage` (`irc/bus.ts:22`) with `to = agentId`, `from = frame.from`, `id = Snowflake.next()`, `ts = Date.now()`

### T2 — `SessionDeliveryBroker`: one per-process socket front door
`session/delivery-broker.ts` (new), a process-global singleton (like `IrcBus`).
Lazily opens `Bun.serve({ unix: <socketPath> })` on first agent registration when
`bus.delivery=on`; closes on process teardown. Accepts `POST /deliver` with
`Authorization: Bearer <token>` + JSON `{ to, from, body, replyTo?, urgent? }`;
checks the token against the per-agent secret for `to`; on success calls
`SteerBridge.deliver(to, frame)`, returns `{ outcome }`. 401 bad/absent token,
404 unknown agent, 410 after the agent's teardown.
- **Interfaces:**
  - socket path: `path.join(busRuntimeDir(), \`${process.pid}.sock\`)`; `busRuntimeDir()` = new helper → `$XDG_RUNTIME_DIR/omp` when set, else `os.tmpdir()/omp-run`, `mkdir 0o700` (precedent `utils/shell-snapshot.ts:238`)
  - `SessionDeliveryBroker.global()`, `registerAgent(agentId, token)`, `unregisterAgent(agentId)` — token table keyed by agent id
  - lifecycle: `registerAgent` called after `#agentId` is set (`agent-session.ts:1910`); `unregisterAgent` in `beginDispose()` (`agent-session.ts:5033`); socket removed when the table empties
  - gated by setting `bus.delivery` (default `off`) — no socket opened unless enabled

### T3 — F3 presence advertisement
`registry/agent-registry.ts` — extend `AgentRef` (`agent-registry.ts:33-46`) with
an optional `endpoint?: { socketPath: string; token: string }` and a
`setEndpoint(id, endpoint)` method emitting `status_changed`. `socketPath` is the
shared per-process socket; `token` is that agent's own secret. The bus MCP client
reads the roster to learn reachability; withdrawn on `removed`.
- **Interfaces:**
  - `AgentRef.endpoint?: { socketPath: string; token: string }`
  - `AgentRegistry.setEndpoint(id: string, endpoint: AgentRef["endpoint"]): void` emitting `status_changed` (`agent-registry.ts:101-110` pattern)
  - populated by T2 at `registerAgent`; cleared on `unregisterAgent`

### T4 — F1 unread-reminder dispatcher
`sdk.ts` — register a dedicated yield dispatcher kind (`bus-unread`) alongside the
existing `mcp-notification` register (`sdk.ts:2761`), rendering a compact
"N new messages in your bus inbox" card via `YieldDispatcher.build`
(`yield-queue.ts:4`). Auto-subscribe the bus resource so it works without a
hand-subscription (today gated on `mcp.notifications` + explicit subscribe).
- **Interfaces:**
  - `session.yieldQueue.register<BusUnreadEntry>("bus-unread", { build, isStale? })` (`yield-queue.ts:42`)
  - entry `{ unreadCount: number; inboxUri: string }`; coalesce repeats (reuse debounce shape at `sdk.ts:2949-2961`)
  - reminder copy in `prompts/system/bus-unread.md` (Handlebars `{{count}}`)
  - opt-in via `bus.inboxResourceUri` setting; auto-subscribe when set

### T5 — Settings + docs
`config/settings-schema.ts` — add the `bus.*` group next to `mcp.*`
(`settings-schema.ts:3737`): `bus.delivery` (`off`|`on`, default `off`),
`bus.inboxResourceUri` (string, default `""`). CHANGELOG `### Added`.
- **Interfaces:** `"bus.delivery"`, `"bus.inboxResourceUri"` settings keys.

### T6 — Tests (red→green, delegated to Tester)
- **BDD/integration:** start a real `SessionDeliveryBroker` on a temp socket dir,
  register a fake agent + token, POST an authed frame, assert delivery routed to
  the right session (`injected` mid-turn / `woken` idle) — the same contract
  `deliverIrcMessage` proves for IRC. Wrong `to` → 404. Bad/absent token → 401.
  After `unregisterAgent` → 410.
- **Unit:** `SteerBridge.deliver` routing (`unknown-agent` when absent/advisor);
  `toIrcMessage` shape; F1 dispatcher `build` renders the count card and
  coalesces; F3 `setEndpoint` emits `status_changed`.
- **Auth negative:** a frame with a token minted for agent A cannot deliver to
  agent B; a tokenless frame never reaches `deliverIrcMessage` (spy asserts zero
  calls).

### T7 — Ship
Push `omp-comms-bus--polo`; add to `rebase-dogfood.sh` BRANCHES; rebuild dogfood.
Open two follow-ups (both outside this repo): (a) the **LiteLLM-fork issue** for
Mode A server→client relay (the F2b prerequisite); (b) a **broker-transport
evaluation** issue (NATS vs. socket-only) to revisit once cross-host delivery is
a real requirement.

## Tasks

- [ ] T1 — `SteerBridge` seam (`session/steer-bridge.ts`)
- [ ] T2 — `SessionDeliveryBroker` per-process socket (`session/delivery-broker.ts`) + `busRuntimeDir()` helper + lifecycle wiring in `agent-session.ts`
- [ ] T3 — F3 presence: `AgentRef.endpoint` + `setEndpoint` (`registry/agent-registry.ts`)
- [ ] T4 — F1 unread dispatcher + auto-subscribe (`sdk.ts`, `prompts/system/bus-unread.md`)
- [ ] T5 — `bus.*` settings (`config/settings-schema.ts`) + CHANGELOG
- [ ] T6 — tests (delegate to Tester): broker routing/integration, cross-agent auth negative, bridge/dispatcher/presence units
- [ ] T7 — push branch, fold into octomerge; open LiteLLM-fork (F2b relay) + broker-transport (NATS) follow-up issues
