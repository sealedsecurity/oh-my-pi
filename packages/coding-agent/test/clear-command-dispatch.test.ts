import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

// Defends the discoverability + dispatch contract for /clear: it must be a
// registered builtin (so TUI autocomplete lists it) and typing it must route to
// the in-place context-reset handler — neither is covered by the type checker,
// which cannot catch a wrong command-name string literal.
function makeCtx() {
	const handleClearContextCommand = vi.fn(async () => {});
	let text = "";
	const editor = {
		onSubmit: undefined as undefined | ((t: string) => Promise<void>),
		getText: () => text,
		setText: (t: string) => {
			text = t;
		},
		addToHistory: vi.fn(),
		pendingImages: [] as unknown[],
		pendingImageLinks: [] as unknown[],
		clearDraft(historyText?: string) {
			if (historyText !== undefined) editor.addToHistory(historyText);
			text = "";
		},
	};
	const ctx = {
		editor,
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
		},
		focusedAgentId: undefined,
		collabGuest: undefined,
		handleClearContextCommand,
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;
	return { ctx, editor, handleClearContextCommand };
}

describe("/clear builtin command", () => {
	it("is registered in the autocomplete command set with a description", () => {
		const clear = BUILTIN_SLASH_COMMAND_DEFS.find(cmd => cmd.name === "clear");
		expect(clear).toBeDefined();
		expect(clear?.description).toBeTruthy();
	});

	it("routes a typed /clear to the in-place context reset handler", async () => {
		const { ctx, editor, handleClearContextCommand } = makeCtx();
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit?.("/clear");

		expect(handleClearContextCommand).toHaveBeenCalledTimes(1);
	});
});
