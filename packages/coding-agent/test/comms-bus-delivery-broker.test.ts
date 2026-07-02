/**
 * SessionDeliveryBroker real-socket integration (comms-bus contracts 1-5).
 *
 * The broker is the process's one Unix-socket front door: the external bus POSTs
 * `/deliver` with a Bearer token, the broker authenticates per recipient and
 * routes through `deliverSteer` into the target agent's live session. These
 * tests exercise the REAL socket end to end via `fetch(..., { unix })` — the
 * wire status codes (200/400/401/404/405) and the delivery side-effects are
 * exactly what an external caller depends on.
 *
 * Red reasoning: no socket, no auth, no routing existed before this feature — a
 * pre-feature build has no `SessionDeliveryBroker`, so every wire code and every
 * spy assertion below is new observable behavior.
 *
 * Isolation: each test gets a fresh temp `XDG_RUNTIME_DIR` (so the socket path,
 * `<dir>/<pid>.sock`, is unique and cleaned up), the process-global broker +
 * registry are reset in afterEach, and the broker is stopped so no socket leaks.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionDeliveryBroker } from "@oh-my-pi/pi-coding-agent/session/delivery-broker";
import { Snowflake } from "@oh-my-pi/pi-utils";

type DeliverCall = { msg: IrcMessage; opts?: { expectsReply?: boolean } };

/** A hand-written fake session recording IRC deliveries; only the bridge-read method exists. */
function fakeSession(returns: "injected" | "woken"): { session: AgentSession; calls: DeliverCall[] } {
	const calls: DeliverCall[] = [];
	const session = {
		async deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
			calls.push({ msg, opts });
			return returns;
		},
	} as unknown as AgentSession;
	return { session, calls };
}

/** Register a live, messageable fake session in the GLOBAL registry (what deliverSteer resolves against). */
function registerLiveAgent(id: string, returns: "injected" | "woken" = "injected"): { calls: DeliverCall[] } {
	const registry = AgentRegistry.global();
	const { session, calls } = fakeSession(returns);
	registry.register({ id, displayName: id, kind: "sub", session: null, status: "running" });
	registry.attachSession(id, session);
	return { calls };
}

function deliver(socketPath: string, init: { headers?: Record<string, string>; body?: string; bodyObj?: unknown }) {
	const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers ?? {}) };
	const body = init.body ?? (init.bodyObj !== undefined ? JSON.stringify(init.bodyObj) : undefined);
	return fetch("http://localhost/deliver", { unix: socketPath, method: "POST", headers, body });
}

describe("SessionDeliveryBroker socket integration", () => {
	let prevXdg: string | undefined;
	let runtimeDir: string;

	beforeEach(() => {
		prevXdg = process.env.XDG_RUNTIME_DIR;
		runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-bus-broker-${Snowflake.next()}-`));
		process.env.XDG_RUNTIME_DIR = runtimeDir;
	});

	afterEach(async () => {
		await SessionDeliveryBroker.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = prevXdg;
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	});

	// --- Contract 1: routing + auth happy path ---

	it("routes an authed frame to the live session and returns 200 {outcome:injected}", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");
		const { calls } = registerLiveAgent("A", "injected");

		const res = await deliver(socketPath, {
			headers: { authorization: "Bearer token-A" },
			bodyObj: { to: "A", from: "RemotePeer", body: "ping you" },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ outcome: "injected" });
		// The frame reached the session as an IrcMessage addressed to A.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.msg.to).toBe("A");
		expect(calls[0]!.msg.from).toBe("RemotePeer");
		expect(calls[0]!.msg.body).toBe("ping you");
	});

	it("surfaces a woken outcome verbatim on 200", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");
		registerLiveAgent("A", "woken");

		const res = await deliver(socketPath, {
			headers: { authorization: "Bearer token-A" },
			bodyObj: { to: "A", from: "Peer", body: "wake up" },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ outcome: "woken" });
	});

	it("carries replyTo and urgent through to the session", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");
		const { calls } = registerLiveAgent("A", "injected");

		const res = await deliver(socketPath, {
			headers: { authorization: "Bearer token-A" },
			bodyObj: { to: "A", from: "Peer", body: "re: earlier", replyTo: "m-7", urgent: true },
		});

		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.msg.replyTo).toBe("m-7");
		expect(calls[0]!.opts?.expectsReply).toBe(true);
	});

	// --- Contract 2: auth negatives ---

	it("rejects a missing Authorization header with 401 and never delivers", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");
		const { calls } = registerLiveAgent("A", "injected");

		const res = await deliver(socketPath, {
			bodyObj: { to: "A", from: "Peer", body: "no auth" },
		});

		expect(res.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it("rejects a token minted for A used to reach B with 401 and never delivers", async () => {
		const broker = SessionDeliveryBroker.global();
		broker.registerAgent("A", "token-A");
		const socketPath = broker.registerAgent("B", "token-B");
		const { calls: aCalls } = registerLiveAgent("A", "injected");
		const { calls: bCalls } = registerLiveAgent("B", "injected");

		// Present A's token but address B (whose token differs) → mismatch → 401.
		const res = await deliver(socketPath, {
			headers: { authorization: "Bearer token-A" },
			bodyObj: { to: "B", from: "Peer", body: "cross-agent" },
		});

		expect(res.status).toBe(401);
		expect(aCalls).toHaveLength(0);
		expect(bCalls).toHaveLength(0);
	});

	it("rejects a wrong token for a known agent with 401", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");
		const { calls } = registerLiveAgent("A", "injected");

		const res = await deliver(socketPath, {
			headers: { authorization: "Bearer wrong-token" },
			bodyObj: { to: "A", from: "Peer", body: "bad token" },
		});

		expect(res.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	// --- Contract 3: unknown agent (authed, but no live session) ---

	it("returns 404 for an authed frame to an id with a token but no live session", async () => {
		const broker = SessionDeliveryBroker.global();
		// Token registered with the broker, but the agent is never registered in the
		// AgentRegistry — the bridge resolves nothing and returns unknown-agent → 404.
		const socketPath = broker.registerAgent("A", "token-A");

		const res = await deliver(socketPath, {
			headers: { authorization: "Bearer token-A" },
			bodyObj: { to: "A", from: "Peer", body: "nobody home" },
		});

		expect(res.status).toBe(404);
		const body = (await res.json()) as { outcome?: string; error?: string };
		expect(body.outcome).toBe("unknown-agent");
	});

	// --- Contract 4: malformed + wrong route/method ---

	it("returns 400 for a non-JSON body", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");
		registerLiveAgent("A", "injected");

		const res = await deliver(socketPath, {
			headers: { authorization: "Bearer token-A" },
			body: "not json at all {",
		});

		expect(res.status).toBe(400);
	});

	it("returns 400 when required fields are missing", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");
		registerLiveAgent("A", "injected");

		for (const bad of [
			{ from: "P", body: "b" },
			{ to: "A", body: "b" },
			{ to: "A", from: "P" },
		]) {
			const res = await deliver(socketPath, {
				headers: { authorization: "Bearer token-A" },
				bodyObj: bad,
			});
			expect(res.status).toBe(400);
		}
	});

	it("returns 405 for a GET and for a POST to the wrong route", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");
		registerLiveAgent("A", "injected");

		const getRes = await fetch("http://localhost/deliver", { unix: socketPath, method: "GET" });
		expect(getRes.status).toBe(405);

		const wrongRoute = await fetch("http://localhost/nope", {
			unix: socketPath,
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer token-A" },
			body: JSON.stringify({ to: "A", from: "P", body: "b" }),
		});
		expect(wrongRoute.status).toBe(405);
	});

	// --- Contract 5: lifecycle ---

	it("opens the socket file on first registerAgent", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");

		expect(broker.socketPath).toBe(socketPath);
		expect(fs.existsSync(socketPath)).toBe(true);
	});

	it("stops the socket after the last agent unregisters: socketPath undefined and connections refused", async () => {
		const broker = SessionDeliveryBroker.global();
		const socketPath = broker.registerAgent("A", "token-A");
		registerLiveAgent("A", "injected");

		// Sanity: it works while up.
		const up = await deliver(socketPath, {
			headers: { authorization: "Bearer token-A" },
			bodyObj: { to: "A", from: "P", body: "hi" },
		});
		expect(up.status).toBe(200);

		broker.unregisterAgent("A");
		// unregisterAgent triggers an async stop(); let it settle without a timer race.
		await broker.stop();

		expect(broker.socketPath).toBeUndefined();
		// A subsequent connection to the old socket must fail (broker gone).
		await expect(
			deliver(socketPath, {
				headers: { authorization: "Bearer token-A" },
				bodyObj: { to: "A", from: "P", body: "after stop" },
			}),
		).rejects.toThrow();
	});

	it("keeps the socket up while any agent remains, closing only when the last unregisters", async () => {
		const broker = SessionDeliveryBroker.global();
		broker.registerAgent("A", "token-A");
		const socketPath = broker.registerAgent("B", "token-B");
		registerLiveAgent("A", "injected");
		registerLiveAgent("B", "injected");

		broker.unregisterAgent("A");
		// B still registered → socket stays up.
		expect(broker.socketPath).toBe(socketPath);
		const stillUp = await deliver(socketPath, {
			headers: { authorization: "Bearer token-B" },
			bodyObj: { to: "B", from: "P", body: "still routing" },
		});
		expect(stillUp.status).toBe(200);
	});
});
