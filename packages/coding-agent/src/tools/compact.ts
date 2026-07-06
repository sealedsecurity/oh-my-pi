import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import compactDescription from "../prompts/tools/compact.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const compactSchema = type({
	"instructions?": type("string").describe("optional focus for the summary (what context to preserve)"),
});

type CompactParams = typeof compactSchema.infer;

export interface CompactToolDetails {
	/** Marks the turn's tool results so the session compacts at turn settle. */
	requested: true;
	/** Optional focus instructions forwarded to the compaction summary. */
	instructions?: string;
	meta?: OutputMeta;
}

/** Compaction restructures the whole session, so it only runs for a top-level agent. */
function isTopLevelSession(session: ToolSession): boolean {
	const depth = session.taskDepth;
	return depth === undefined || depth === 0;
}

/**
 * Model-callable context compaction. The tool itself only *signals* intent:
 * `execute` returns a result carrying `requested: true`, and the AgentSession's
 * `onTurnEnd` hook runs the actual `compact()` once the turn settles. That
 * deferral is the whole point — `AgentSession.compact()` aborts the current
 * agent operation first, so compacting synchronously from `execute` would abort
 * the very turn that called the tool. At turn settle the abort is a no-op
 * because the turn is already done. Mirrors the checkpoint/rewind signal-then-
 * apply split.
 */
export class CompactTool implements AgentTool<typeof compactSchema, CompactToolDetails> {
	readonly name = "compact";
	readonly approval = "read" as const;
	readonly label = "Compact Context";
	readonly summary = "Compact your own conversation context at a clean breakpoint";
	readonly description: string;
	readonly parameters = compactSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly intent = (): string => "compacting context";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(compactDescription);
	}

	static createIf(session: ToolSession): CompactTool | null {
		// Subagents hand their result back to the parent and are discarded; there
		// is no long-lived context worth compacting, and compaction would rewrite
		// the transcript the parent collects. Top-level sessions only.
		if (!isTopLevelSession(session)) return null;
		return new CompactTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CompactParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CompactToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CompactToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Compaction is not available in subagents.");
		}
		const instructions = params.instructions?.trim() || undefined;
		return toolResult<CompactToolDetails>({ requested: true, instructions })
			.text("Compaction scheduled — it runs when this turn settles. This does not interrupt the current turn.")
			.done();
	}
}
