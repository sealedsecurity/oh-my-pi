/**
 * SessionDeliveryBroker — one Unix-socket front door per OMP process.
 *
 * The external comms bus delivers a `ping` into a running session by POSTing to
 * this socket; the broker authenticates per recipient and routes through
 * {@link deliverSteer} to that agent's live session (same steer/aside/wake path
 * as in-session IRC). One socket per process serves the main agent and every
 * subagent — routing is by the frame's `to` id, exactly like `IrcBus.send`.
 *
 * Gated by the `bus.delivery` setting: the socket is opened lazily on the first
 * `registerAgent` and closed when the last agent unregisters, so it never exists
 * unless delivery is enabled and at least one agent is live.
 *
 * Wire protocol: `POST /deliver`, `Authorization: Bearer <token>`, JSON body
 * `{ to, from, body, replyTo?, urgent? }`. Responses: 200 `{ outcome }`,
 * 400 malformed, 401 bad/absent token, 404 unknown agent, 405 wrong route.
 */
import * as fs from "node:fs";
import { logger } from "@oh-my-pi/pi-utils";
import { busSocketPath } from "../utils/bus-runtime-dir";
import { type DeliveryOutcome, deliverSteer, type SteerFrame } from "./steer-bridge";

/** A delivery request as it arrives on the wire (before auth/validation). */
interface DeliverRequestBody {
	to?: unknown;
	from?: unknown;
	body?: unknown;
	replyTo?: unknown;
	urgent?: unknown;
}

/** Constant-time-ish token comparison: length check + full-length char scan. */
function tokensMatch(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export class SessionDeliveryBroker {
	static #global: SessionDeliveryBroker | undefined;

	static global(): SessionDeliveryBroker {
		if (!SessionDeliveryBroker.#global) {
			SessionDeliveryBroker.#global = new SessionDeliveryBroker();
		}
		return SessionDeliveryBroker.#global;
	}

	/** Reset the global broker (stops any live socket). Test-only. */
	static async resetGlobalForTests(): Promise<void> {
		await SessionDeliveryBroker.#global?.stop();
		SessionDeliveryBroker.#global = undefined;
	}

	/** Per-agent delivery tokens, keyed by agent id. */
	readonly #tokens = new Map<string, string>();
	#server: Bun.Server<undefined> | undefined;
	#socketPath: string | undefined;

	/** Absolute path of the live socket, or undefined when not listening. */
	get socketPath(): string | undefined {
		return this.#socketPath;
	}

	/**
	 * Register an agent as reachable with its delivery token, opening the socket
	 * on the first registration. Returns the socket path so callers can advertise
	 * `{ socketPath, token }` for presence.
	 */
	registerAgent(agentId: string, token: string): string {
		this.#tokens.set(agentId, token);
		this.#ensureListening();
		// #ensureListening sets #socketPath unless serve() failed; fall back to the
		// computed path so a caller always gets a usable value to advertise.
		return this.#socketPath ?? busSocketPath();
	}

	/** Withdraw an agent; closes the socket once the last agent is gone. */
	unregisterAgent(agentId: string): void {
		this.#tokens.delete(agentId);
		if (this.#tokens.size === 0) void this.stop();
	}

	#ensureListening(): void {
		if (this.#server) return;
		const socketPath = busSocketPath();
		// A hard crash can leave a stale <pid>.sock; Bun.serve throws EADDRINUSE on
		// it (it does not auto-unlink), so clear a stale file first. Graceful stop
		// already removes the socket, so this only matters after an unclean exit
		// whose PID has been reused.
		fs.rmSync(socketPath, { force: true });
		try {
			this.#server = Bun.serve({
				unix: socketPath,
				fetch: request => this.#handle(request),
			});
			this.#socketPath = socketPath;
			logger.debug("Delivery broker listening", { path: socketPath });
		} catch (error) {
			logger.warn("Delivery broker failed to open socket", {
				path: socketPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/deliver") {
			return Response.json({ error: "not found" }, { status: 405 });
		}

		let payload: DeliverRequestBody;
		try {
			payload = (await request.json()) as DeliverRequestBody;
		} catch {
			return Response.json({ error: "invalid JSON body" }, { status: 400 });
		}

		if (typeof payload.to !== "string" || typeof payload.from !== "string" || typeof payload.body !== "string") {
			return Response.json({ error: "missing required fields: to, from, body" }, { status: 400 });
		}
		if (payload.replyTo !== undefined && typeof payload.replyTo !== "string") {
			return Response.json({ error: "replyTo must be a string" }, { status: 400 });
		}

		const expected = this.#tokens.get(payload.to);
		const presented = this.#bearer(request);
		// One check for both "no such agent" and "wrong token" would leak which
		// ids exist; but an absent agent genuinely has no token, so 401 first
		// (auth), then a resolved-but-dead agent surfaces as 404 from the bridge.
		if (!presented || !expected || !tokensMatch(presented, expected)) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}

		const frame: SteerFrame = {
			from: payload.from,
			body: payload.body,
			...(typeof payload.replyTo === "string" ? { replyTo: payload.replyTo } : {}),
			...(payload.urgent === true ? { urgent: true } : {}),
		};

		const outcome: DeliveryOutcome = await deliverSteer(payload.to, frame);
		if (outcome === "unknown-agent") {
			return Response.json({ error: "unknown agent", outcome }, { status: 404 });
		}
		return Response.json({ outcome }, { status: 200 });
	}

	#bearer(request: Request): string | undefined {
		const header = request.headers.get("authorization");
		if (!header) return undefined;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		return match ? match[1] : undefined;
	}

	/** Stop listening and remove the socket file. Idempotent. */
	async stop(): Promise<void> {
		if (!this.#server) return;
		await this.#server.stop(true);
		this.#server = undefined;
		this.#socketPath = undefined;
	}
}
