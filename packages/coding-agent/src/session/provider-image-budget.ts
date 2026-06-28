import type {
	Context,
	DeveloperMessage,
	ImageContent,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { providerImageBudget, providerImageByteBudget } from "@oh-my-pi/snapcompact";

const TOOL_RESULT_IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

function collectImageSizes(context: Context): number[] {
	const sizes: number[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") sizes.push(part.data.length);
		}
	}
	return sizes;
}

/** Count of oldest images to drop so the surviving image payload fits `byteLimit`. */
function imageDropCountForBytes(sizes: readonly number[], byteLimit: number): number {
	let total = 0;
	for (const size of sizes) total += size;
	let drops = 0;
	for (let index = 0; total > byteLimit && index < sizes.length; index++) {
		total -= sizes[index] ?? 0;
		drops++;
	}
	return drops;
}

function clampContent(
	content: readonly (TextContent | ImageContent)[],
	state: { remainingDrops: number },
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "image" && state.remainingDrops > 0) {
			state.remainingDrops--;
			changed = true;
			continue;
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

function clampUserMessage(message: UserMessage, state: { remainingDrops: number }): UserMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content } : message;
}

function clampDeveloperMessage(message: DeveloperMessage, state: { remainingDrops: number }): DeveloperMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content } : message;
}

function clampToolResultMessage(message: ToolResultMessage, state: { remainingDrops: number }): ToolResultMessage {
	if (state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	if (!content) return message;
	return { ...message, content: content.length > 0 ? content : [TOOL_RESULT_IMAGE_OMISSION] };
}

/** Drops oldest transient image blocks so outgoing vision requests fit the
 *  active provider's image budget — both the per-request image COUNT cap and the
 *  combined image-BYTE cap (a long snapcompact archive can stay under the count
 *  cap yet bust the request-size limit on summed frame bytes). */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const sizes = collectImageSizes(context);
	if (sizes.length === 0) return context;
	const countDrops = Math.max(0, sizes.length - providerImageBudget(model.provider));
	const byteDrops = imageDropCountForBytes(sizes, providerImageByteBudget(model.provider));
	const drops = Math.max(countDrops, byteDrops);
	if (drops <= 0) return context;

	const state = { remainingDrops: drops };
	const messages = context.messages.map(message => {
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
			case "toolResult":
				return clampToolResultMessage(message, state);
			case "assistant":
				return message;
		}
		return message;
	});
	return { ...context, messages };
}
