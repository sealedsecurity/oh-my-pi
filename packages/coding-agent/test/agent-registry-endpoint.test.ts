/**
 * AgentRegistry comms-bus endpoint (F3, contract 8).
 *
 * `setEndpoint(id, endpoint)` records an agent's reachability on `AgentRef` and
 * emits `status_changed` so roster consumers and the bus MCP client learn about
 * it. The observable contracts: the endpoint value on the ref, the event fired
 * (subscribed via `onChange`), the event's ref identity, and the silent no-op
 * for an unknown id.
 *
 * Red reasoning: `AgentRef.endpoint` and `setEndpoint` did not exist before this
 * feature, so a listener would never have seen a `status_changed` from an
 * endpoint change and the ref would never carry `{ socketPath, token }`.
 *
 * Uses a fresh `new AgentRegistry()` per test (the real class, isolated
 * instance) so nothing leaks into the process-global registry.
 */
import { describe, expect, it } from "bun:test";
import { AgentRegistry, type RegistryEvent } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

function subscribe(registry: AgentRegistry): { events: RegistryEvent[]; unsubscribe: () => void } {
	const events: RegistryEvent[] = [];
	const unsubscribe = registry.onChange(event => events.push(event));
	return { events, unsubscribe };
}

describe("AgentRegistry.setEndpoint", () => {
	it("records the endpoint on the ref and fires status_changed", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "A", displayName: "A", kind: "sub", session: null, status: "idle" });

		// Subscribe AFTER register so the `registered` event isn't counted here.
		const { events, unsubscribe } = subscribe(registry);
		try {
			registry.setEndpoint("A", { socketPath: "/run/omp/123.sock", token: "tok-A" });

			expect(registry.get("A")?.endpoint).toEqual({ socketPath: "/run/omp/123.sock", token: "tok-A" });
			expect(events).toHaveLength(1);
			expect(events[0]!.type).toBe("status_changed");
			expect(events[0]!.ref.id).toBe("A");
			// The event carries the same ref, now bearing the endpoint.
			expect(events[0]!.ref.endpoint).toEqual({ socketPath: "/run/omp/123.sock", token: "tok-A" });
		} finally {
			unsubscribe();
		}
	});

	it("clears the endpoint and fires status_changed again when passed undefined", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "A", displayName: "A", kind: "sub", session: null, status: "idle" });
		registry.setEndpoint("A", { socketPath: "/run/omp/123.sock", token: "tok-A" });

		const { events, unsubscribe } = subscribe(registry);
		try {
			registry.setEndpoint("A", undefined);

			expect(registry.get("A")?.endpoint).toBeUndefined();
			expect(events).toHaveLength(1);
			expect(events[0]!.type).toBe("status_changed");
			expect(events[0]!.ref.id).toBe("A");
			expect(events[0]!.ref.endpoint).toBeUndefined();
		} finally {
			unsubscribe();
		}
	});

	it("is a silent no-op for an unknown id: no throw and no event", () => {
		const registry = new AgentRegistry();
		const { events, unsubscribe } = subscribe(registry);
		try {
			expect(() => registry.setEndpoint("Ghost", { socketPath: "/run/omp/9.sock", token: "tok" })).not.toThrow();
			expect(events).toHaveLength(0);
			expect(registry.get("Ghost")).toBeUndefined();
		} finally {
			unsubscribe();
		}
	});

	it("delivers set then clear as two distinct events, snapshotting endpoint at emit time", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "A", displayName: "A", kind: "sub", session: null, status: "idle" });

		// The registry emits the LIVE ref (no per-event snapshot), so a second
		// mutation would overwrite what an earlier stored ref reads. Capture the
		// endpoint value INSIDE the listener at emit time to prove the ordered
		// transition set -> clear as each event actually fired.
		const seen: Array<{ type: string; token: string | undefined }> = [];
		const unsubscribe = registry.onChange(event => {
			seen.push({ type: event.type, token: event.ref.endpoint?.token });
		});
		try {
			registry.setEndpoint("A", { socketPath: "/run/omp/1.sock", token: "t1" });
			registry.setEndpoint("A", undefined);

			expect(seen).toEqual([
				{ type: "status_changed", token: "t1" },
				{ type: "status_changed", token: undefined },
			]);
			// End state: the endpoint is cleared on the live ref.
			expect(registry.get("A")?.endpoint).toBeUndefined();
		} finally {
			unsubscribe();
		}
	});
});
