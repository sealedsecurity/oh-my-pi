/**
 * SteerBridge routing + outcomes (comms-bus contract 6).
 *
 * `deliverSteer(agentId, frame, registry)` resolves an agent through the
 * registry and funnels the frame into `AgentSession.deliverIrcMessage`, the same
 * steer/aside/wake path in-session IRC uses. The contracts defended here are the
 * OUTCOME string the caller (broker, MCP steer, IrcBus) branches on, and the
 * exact `IrcMessage` the recipient session receives.
 *
 * Red reasoning: before this feature there was no steer-bridge — the broker/MCP
 * transports had nothing to route through, so every case below (outcome mapping,
 * the guard set, the minted-message shape) is new observable behavior that could
 * not have passed against pre-feature code.
 *
 * A fresh, isolated `AgentRegistry` is passed as the 3rd arg (the real
 * implementation, not the global), so these tests never touch process-global
 * state and each case controls exactly one ref.
 */
import { describe, expect, it } from "bun:test";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type DeliveryOutcome, deliverSteer, type SteerFrame } from "@oh-my-pi/pi-coding-agent/session/steer-bridge";

type DeliverCall = { msg: IrcMessage; opts?: { expectsReply?: boolean } };

/**
 * A hand-written fake session that records every `deliverIrcMessage` call and
 * either returns a fixed outcome or throws (to simulate a disposed recipient).
 * Only the one method the bridge invokes is implemented — everything else on
 * AgentSession is irrelevant to the routing contract.
 */
function fakeSession(behavior: { returns?: "injected" | "woken"; throws?: boolean }): {
	session: AgentSession;
	calls: DeliverCall[];
} {
	const calls: DeliverCall[] = [];
	const session = {
		async deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
			calls.push({ msg, opts });
			if (behavior.throws) throw new Error("Recipient session is disposed.");
			return behavior.returns ?? "injected";
		},
	} as unknown as AgentSession;
	return { session, calls };
}

describe("deliverSteer routing and outcomes", () => {
	const frame: SteerFrame = { from: "RemotePeer", body: "status check" };

	describe("unknown-agent guards", () => {
		it("returns unknown-agent when no ref exists for the id", async () => {
			const registry = new AgentRegistry();
			const outcome: DeliveryOutcome = await deliverSteer("Ghost", frame, registry);
			expect(outcome).toBe("unknown-agent");
		});

		it("returns unknown-agent for an aborted ref even with a live session", async () => {
			const registry = new AgentRegistry();
			const { session, calls } = fakeSession({ returns: "injected" });
			registry.register({ id: "A", displayName: "A", kind: "sub", session: null, status: "aborted" });
			registry.attachSession("A", session);
			const outcome: DeliveryOutcome = await deliverSteer("A", frame, registry);
			expect(outcome).toBe("unknown-agent");
			// A terminal agent must never receive the frame.
			expect(calls).toHaveLength(0);
		});

		it("returns unknown-agent for an advisor ref (observability-only, never messageable)", async () => {
			const registry = new AgentRegistry();
			const { session, calls } = fakeSession({ returns: "injected" });
			registry.register({ id: "Adv", displayName: "Adv", kind: "advisor", session: null, status: "running" });
			registry.attachSession("Adv", session);
			const outcome: DeliveryOutcome = await deliverSteer("Adv", frame, registry);
			expect(outcome).toBe("unknown-agent");
			expect(calls).toHaveLength(0);
		});

		it("returns unknown-agent for a live-status ref whose session was detached (parked with no session)", async () => {
			const registry = new AgentRegistry();
			// Registered and idle, but session === null (parked-style): not messageable.
			registry.register({ id: "P", displayName: "P", kind: "sub", session: null, status: "idle" });
			const outcome: DeliveryOutcome = await deliverSteer("P", frame, registry);
			expect(outcome).toBe("unknown-agent");
		});
	});

	describe("live delivery", () => {
		it("returns the session's outcome verbatim (injected)", async () => {
			const registry = new AgentRegistry();
			const { session } = fakeSession({ returns: "injected" });
			registry.register({ id: "A", displayName: "A", kind: "sub", session: null, status: "running" });
			registry.attachSession("A", session);
			const outcome: DeliveryOutcome = await deliverSteer("A", frame, registry);
			expect(outcome).toBe("injected");
		});

		it("returns the session's outcome verbatim (woken)", async () => {
			const registry = new AgentRegistry();
			const { session } = fakeSession({ returns: "woken" });
			registry.register({ id: "A", displayName: "A", kind: "sub", session: null, status: "idle" });
			registry.attachSession("A", session);
			const outcome: DeliveryOutcome = await deliverSteer("A", frame, registry);
			expect(outcome).toBe("woken");
		});

		it("mints an IrcMessage with to=agentId, from=frame.from, body=frame.body and no replyTo when absent", async () => {
			const registry = new AgentRegistry();
			const { session, calls } = fakeSession({ returns: "injected" });
			registry.register({ id: "Recv", displayName: "Recv", kind: "sub", session: null, status: "idle" });
			registry.attachSession("Recv", session);

			await deliverSteer("Recv", { from: "Sender", body: "hello there" }, registry);

			expect(calls).toHaveLength(1);
			const { msg } = calls[0]!;
			expect(msg.to).toBe("Recv");
			expect(msg.from).toBe("Sender");
			expect(msg.body).toBe("hello there");
			// replyTo is minted ONLY when the frame carries one — a bare frame must not fabricate it.
			expect("replyTo" in msg).toBe(false);
		});

		it("carries replyTo through only when the frame sets it", async () => {
			const registry = new AgentRegistry();
			const { session, calls } = fakeSession({ returns: "injected" });
			registry.register({ id: "Recv", displayName: "Recv", kind: "sub", session: null, status: "idle" });
			registry.attachSession("Recv", session);

			await deliverSteer("Recv", { from: "Sender", body: "re: earlier", replyTo: "msg-42" }, registry);

			expect(calls).toHaveLength(1);
			expect(calls[0]!.msg.replyTo).toBe("msg-42");
		});

		it("maps frame.urgent to the deliverIrcMessage expectsReply option", async () => {
			const registry = new AgentRegistry();
			const { session, calls } = fakeSession({ returns: "injected" });
			registry.register({ id: "U", displayName: "U", kind: "sub", session: null, status: "idle" });
			registry.attachSession("U", session);

			await deliverSteer("U", { from: "S", body: "urgent", urgent: true }, registry);
			await deliverSteer("U", { from: "S", body: "calm" }, registry);

			expect(calls).toHaveLength(2);
			// urgent → expectsReply true (allows an ephemeral auto-reply mid-turn);
			// unset → false, never undefined.
			expect(calls[0]!.opts?.expectsReply).toBe(true);
			expect(calls[1]!.opts?.expectsReply).toBe(false);
		});
	});

	describe("disposed", () => {
		it("returns disposed when deliverIrcMessage throws (session torn down mid-delivery)", async () => {
			const registry = new AgentRegistry();
			const { session } = fakeSession({ throws: true });
			registry.register({ id: "Dying", displayName: "Dying", kind: "sub", session: null, status: "running" });
			registry.attachSession("Dying", session);
			const outcome: DeliveryOutcome = await deliverSteer("Dying", frame, registry);
			expect(outcome).toBe("disposed");
		});
	});
});
