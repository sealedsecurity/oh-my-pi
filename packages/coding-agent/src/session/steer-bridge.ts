/**
 * SteerBridge — transport-agnostic delivery seam for external messages.
 *
 * Routes an inbound message to a live agent session by id, reusing the exact
 * in-session IRC delivery path (`AgentSession.deliverIrcMessage`): mid-turn it
 * lands as a non-interrupting aside at the next step boundary, idle it wakes a
 * real turn. This mirrors `IrcBus.send` (which resolves the recipient via the
 * global registry and calls the same method), but takes an already-resolved
 * `agentId` + a plain frame instead of an `IrcMessage`, so any cross-process
 * transport can drive it: the local Unix-socket broker today, and (later) an MCP
 * server->client steer notification or an external message broker, all funnel
 * through this one function.
 *
 * Delivered content is non-authoritative input, never instructions — the
 * `irc:incoming` framing `deliverIrcMessage` applies already establishes that.
 */
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { IrcMessage } from "../irc/bus";
import { AgentRegistry } from "../registry/agent-registry";

/** A message handed to the bridge by any transport (socket, MCP, broker). */
export interface SteerFrame {
	/** Display label for the sender (e.g. a remote agent id or bus handle). Rendered as text, not trusted. */
	from: string;
	/** Message body. */
	body: string;
	/** Id of a prior message this answers, if any. */
	replyTo?: string;
	/** Urgent hint: allow an ephemeral auto-reply when the recipient is mid-turn with async disabled. */
	urgent?: boolean;
}

/**
 * Outcome of a steer delivery:
 * - `injected` — recipient was mid-turn; folded in at the next step boundary.
 * - `woken` — recipient was idle; a real turn was started.
 * - `unknown-agent` — no messageable agent by that id (absent, aborted, advisor, or parked with no live session).
 * - `disposed` — the agent existed but its session was torn down mid-delivery.
 */
export type DeliveryOutcome = "injected" | "woken" | "unknown-agent" | "disposed";

/** Build an `IrcMessage` for `agentId` from a transport frame. */
function toIrcMessage(agentId: string, frame: SteerFrame): IrcMessage {
	return {
		id: Snowflake.next(),
		from: frame.from,
		to: agentId,
		body: frame.body,
		ts: Date.now(),
		...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
	};
}

/**
 * Deliver `frame` to the live session registered as `agentId`.
 *
 * Resolves via `AgentRegistry.global()` and calls `deliverIrcMessage`. Returns
 * `unknown-agent` when the id names no messageable live agent (mirrors the
 * absent/aborted/advisor guard in `IrcBus.send`), and `disposed` if the session
 * was torn down between the lookup and the call.
 */
export async function deliverSteer(
	agentId: string,
	frame: SteerFrame,
	registry: AgentRegistry = AgentRegistry.global(),
): Promise<DeliveryOutcome> {
	const ref = registry.get(agentId);
	// Advisor refs are observability-only transcripts, never messageable peers;
	// aborted agents are terminal. Both mirror the IrcBus.send guards.
	if (!ref || ref.status === "aborted" || ref.kind === "advisor") return "unknown-agent";
	const session = ref.session;
	if (!session) return "unknown-agent";
	try {
		return await session.deliverIrcMessage(toIrcMessage(agentId, frame), { expectsReply: frame.urgent ?? false });
	} catch {
		// Session disposed between lookup and delivery (recipient shutting down).
		return "disposed";
	}
}
