/**
 * Regression test for the whole-session MCP outage: a successful-but-empty
 * `tools/list` during an aggregating gateway's cold-start warmup left the
 * session with zero MCP tools for its entire lifetime.
 *
 * Verbatim repro (see fixtures/warmup-empty-tools-mcp.ts): a healthy stdio MCP
 * server answers its first `tools/list` with `{"tools":[]}` (a 200, not an
 * error), then advertises its real tools on the next call. The connection
 * never drops, so recovery cannot come from the reconnect path — it must come
 * from an in-session re-list.
 *
 * Contracts defended:
 *   1. Auto-heal on connect: a connected server that first lists empty is
 *      re-listed on a bounded backoff; once its tools appear they are
 *      registered and `#onToolsChanged` fires — no reconnect, no user action.
 *   2. The empty pass is never cached (no 30-day poison) — asserted via the
 *      tool cache staying empty for that server after the empty list.
 *   3. `/mcp refresh` primitive: `refreshAllTools()` re-lists every live
 *      connection and picks up tools that appeared after the initial connect.
 *
 * Timing note: this is a real subprocess integration test. The auto-retry
 * backoff runs on the platform clock inside a spawned MCP server's transport,
 * so fake timers cannot drive it. Rather than sleep-poll, tests await the
 * manager's own `#onToolsChanged` signal directly; the `it(…, timeout)` bound
 * fails the test if the heal never fires.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "warmup-empty-tools-mcp.ts");
const BUN_EXEC = process.execPath;

function createFakeStorage(): AgentStorage & { raw: Map<string, string> } {
	const raw = new Map<string, string>();
	const stub = {
		raw,
		getCache(key: string): string | null {
			return raw.get(key) ?? null;
		},
		setCache(key: string, value: string): void {
			raw.set(key, value);
		},
	};
	return stub as unknown as AgentStorage & { raw: Map<string, string> };
}

describe("MCP empty-toolset warmup recovery", () => {
	let workDir: string;
	let listLog: string;
	const originalRetryMs = Bun.env.OMP_MCP_EMPTY_RETRY_MS;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-warmup-"));
		listLog = path.join(workDir, "lists.log");
		fs.writeFileSync(listLog, "");
		// Keep the auto-retry backoff tiny so the heal fires promptly instead of
		// waiting out the production schedule.
		Bun.env.OMP_MCP_EMPTY_RETRY_MS = "20";
	});

	afterEach(() => {
		if (originalRetryMs === undefined) delete Bun.env.OMP_MCP_EMPTY_RETRY_MS;
		else Bun.env.OMP_MCP_EMPTY_RETRY_MS = originalRetryMs;
		removeSyncWithRetries(workDir);
	});

	function stdioConfig(): MCPStdioServerConfig {
		return {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_TOOLS_PER_LIST: "0,1", OMP_TEST_LIST_LOG: listLog },
		};
	}

	function warmupTools(manager: MCPManager): { name: string }[] {
		return manager.getTools().filter(t => t.name.startsWith("mcp__warmup_"));
	}

	it("auto-heals a session that connected during the empty-list window", async () => {
		const storage = createFakeStorage();
		const manager = new MCPManager(workDir, new MCPToolCache(storage));

		// Await the real signal the heal emits rather than sleep-polling: resolve
		// once #onToolsChanged reports the warmed tool registered.
		const healed = Promise.withResolvers<void>();
		const toolsChangedCounts: number[] = [];
		manager.setOnToolsChanged(tools => {
			const warmed = tools.filter(t => t.name.startsWith("mcp__warmup_")).length;
			toolsChangedCounts.push(warmed);
			if (warmed === 1) healed.resolve();
		});

		try {
			// Initial connect lands in the empty window: 0 tools, but connected.
			const result = await manager.connectServers({ warmup: stdioConfig() }, {});
			expect(result.tools.filter(t => t.name.startsWith("mcp__warmup_"))).toEqual([]);

			// The empty pass must NOT be cached (that is the 30-day poison).
			expect(storage.raw.size).toBe(0);

			// Auto-retry re-lists and registers the warmed tool with no reconnect
			// and no user action.
			await healed.promise;

			expect(warmupTools(manager)).toHaveLength(1);
			// The heal fired #onToolsChanged with the populated set.
			expect(toolsChangedCounts.some(count => count === 1)).toBe(true);
			// The server never dropped — recovery came from a re-list, not a
			// reconnect.
			expect(manager.getConnectionStatus("warmup")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	it("re-lists live connections on refreshAllTools (/mcp refresh primitive)", async () => {
		// Disable auto-retry so the ONLY thing that can pick up the warmed tool
		// is the explicit refresh — isolates the manual-recovery contract.
		Bun.env.OMP_MCP_EMPTY_RETRY_MS = "0";
		const manager = new MCPManager(workDir);

		try {
			const result = await manager.connectServers({ warmup: stdioConfig() }, {});
			expect(result.tools.filter(t => t.name.startsWith("mcp__warmup_"))).toEqual([]);
			// With auto-retry off, the empty toolset stands until we refresh.
			expect(warmupTools(manager)).toEqual([]);

			await manager.refreshAllTools();

			expect(warmupTools(manager)).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});
