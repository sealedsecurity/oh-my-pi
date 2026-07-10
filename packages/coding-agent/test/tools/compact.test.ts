import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CompactTool } from "@oh-my-pi/pi-coding-agent/tools/compact";

function createToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("compact tool factory (BUILTIN_TOOLS.compact / CompactTool.createIf)", () => {
	it("returns a tool for a top-level session (taskDepth undefined)", () => {
		const tool = CompactTool.createIf(createToolSession());
		expect(tool).not.toBeNull();
		expect(tool?.name).toBe("compact");
	});

	it("returns a tool for a top-level session (taskDepth 0)", () => {
		expect(CompactTool.createIf(createToolSession({ taskDepth: 0 }))).not.toBeNull();
	});

	it("returns null for a subagent session (taskDepth >= 1)", () => {
		expect(CompactTool.createIf(createToolSession({ taskDepth: 1 }))).toBeNull();
		expect(CompactTool.createIf(createToolSession({ taskDepth: 3 }))).toBeNull();
	});

	it("is registered in BUILTIN_TOOLS", () => {
		expect(typeof BUILTIN_TOOLS.compact).toBe("function");
	});
});

describe("compact tool metadata", () => {
	it("exposes name/approval/loadMode contract", () => {
		const tool = new CompactTool(createToolSession());
		expect(tool.name).toBe("compact");
		expect(tool.approval).toBe("read");
		expect(tool.loadMode).toBe("essential");
	});
});

describe("compact tool execute (signal-only, no inline compaction)", () => {
	it("returns details.requested === true with a text confirmation and does not compact inline", async () => {
		const session = createToolSession();
		const tool = new CompactTool(session);
		// The tool must be a pure signal: the ToolSession stub has no compaction
		// machinery, so any attempt to actually compact from execute() would throw
		// or touch session state. A clean resolve with requested:true proves the
		// deferral — the session runs compaction later at turn settle.
		const result = await tool.execute("call_compact", {});

		expect(result.details?.requested).toBe(true);
		expect(result.isError).toBeUndefined();
		const text = result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
		expect(text.length).toBeGreaterThan(0);
		expect(text.toLowerCase()).toContain("compaction");
	});

	it("trims instructions into details.instructions", async () => {
		const tool = new CompactTool(createToolSession());
		const result = await tool.execute("call_compact", { instructions: "  keep the API contract  " });
		expect(result.details?.instructions).toBe("keep the API contract");
	});

	it("normalizes blank/whitespace-only instructions to undefined", async () => {
		const tool = new CompactTool(createToolSession());
		const blank = await tool.execute("call_compact", { instructions: "   " });
		expect(blank.details?.instructions).toBeUndefined();

		const omitted = await tool.execute("call_compact", {});
		expect(omitted.details?.instructions).toBeUndefined();
	});

	it("throws when invoked in a subagent (defense in depth beyond createIf)", async () => {
		const tool = new CompactTool(createToolSession({ taskDepth: 2 }));
		await expect(tool.execute("call_compact", {})).rejects.toThrow("subagent");
	});
});
