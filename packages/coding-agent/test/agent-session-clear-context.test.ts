import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

/** Flatten the text blocks of a resolved context so a single assertion can check content. */
function contextMessageText(messages: AgentMessage[]): string {
	const texts: string[] = [];
	for (const message of messages) {
		if (!("content" in message)) continue;
		const content = message.content;
		if (typeof content === "string") {
			texts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text") texts.push(block.text);
			}
		}
	}
	return texts.join("\n");
}

/** Append a user+assistant turn on the persisted branch (mirrors seedConversation). Returns the assistant entry id. */
function appendTurn(active: AgentSession, userText: string, assistantText: string): string {
	active.sessionManager.appendMessage({ role: "user", content: userText, timestamp: Date.now() });
	return active.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: assistantText }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

describe("AgentSession.clearSessionContext", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-clear-context-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await fs.promises
			.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
			.catch(() => undefined);
		vi.restoreAllMocks();
	});

	async function createSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["unused"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated({ "compaction.enabled": false });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return session;
	}

	function seedConversation(active: AgentSession): void {
		active.sessionManager.appendMessage({ role: "user", content: "first task", timestamp: Date.now() - 2 });
		active.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "did the first task" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1,
		});
		active.agent.replaceMessages(active.sessionManager.buildSessionContext().messages);
	}

	it("drops live context to empty, reports the dropped count, and preserves session identity + transcript", async () => {
		const active = await createSession();
		await active.setSessionName("My long-lived session", "user");
		seedConversation(active);
		await active.sessionManager.flush();

		const persistentId = active.sessionManager.getSessionId();
		const title = active.sessionName;
		const file = active.sessionFile;
		expect(file).toBeDefined();
		const liveBefore = active.messages.length;
		const transcriptBefore = active.sessionManager.buildSessionContext().messages.length;
		expect(liveBefore).toBeGreaterThan(0);
		expect(transcriptBefore).toBeGreaterThan(0);

		const result = await active.clearSessionContext();

		// The live conversation is gone and the dropped count is reported.
		expect(result).toEqual({ droppedCount: liveBefore });
		expect(active.messages).toHaveLength(0);

		// The session itself survives: persistent id, title, file path all remain.
		// The MODEL context is now empty (the /clear boundary starts emission after
		// itself for the non-transcript rebuild too), but the full-history EXPORT
		// transcript still walks the whole branch — clearing context is not
		// deleting history.
		expect(active.sessionManager.getSessionId()).toBe(persistentId);
		expect(active.sessionName).toBe(title);
		expect(active.sessionFile).toBe(file);
		expect(active.sessionManager.buildSessionContext().messages).toHaveLength(0);
		expect(active.sessionManager.buildSessionContext({ transcript: true }).messages).toHaveLength(transcriptBefore);
		const transcriptRaw = fs.readFileSync(file!, "utf8");
		expect(transcriptRaw).toContain("first task");
		expect(transcriptRaw).toContain("did the first task");
	});

	it("drops active checkpoint runtime state alongside the cleared conversation", async () => {
		const active = await createSession();
		seedConversation(active);
		// A checkpoint created but not yet rewound: its tool result is dropped with
		// the conversation, so the checkpoint runtime state must be cleared too —
		// otherwise the next turn forces a rewind onto the pre-clear transcript.
		active.setCheckpointState({
			checkpointMessageCount: active.messages.length,
			checkpointEntryId: null,
			startedAt: new Date().toISOString(),
		});
		expect(active.getCheckpointState()).toBeDefined();

		await active.clearSessionContext();

		expect(active.getCheckpointState()).toBeUndefined();
	});

	it("is a no-op that returns undefined while a response is streaming", async () => {
		const active = await createSession();
		seedConversation(active);
		const liveBefore = active.messages.length;
		expect(liveBefore).toBeGreaterThan(0);

		// Drive the real streaming flag rather than spying (Bun's spyOn can't stub
		// accessor getters); session.isStreaming reads agent.state.isStreaming.
		active.agent.state.isStreaming = true;
		const result = await active.clearSessionContext();
		active.agent.state.isStreaming = false;

		expect(result).toBeUndefined();
		expect(active.messages).toHaveLength(liveBefore);
	});

	it("keeps the model context empty after a resume/rebuild across a /clear (fix #4)", async () => {
		const active = await createSession();
		seedConversation(active);
		expect(active.messages.length).toBeGreaterThan(0);

		await active.clearSessionContext();
		expect(active.messages).toHaveLength(0);

		// Resume / /shake / reload rebuild the model context from the persisted
		// branch and swap it into the agent. Reverting fix #4 (re-gating the
		// boundary branch on transcript+collapseCompactedHistory) makes the
		// non-transcript buildSessionContext() replay the pre-clear turns, so this
		// replaceMessages repopulates the LLM context the /clear reported empty.
		active.agent.replaceMessages(active.sessionManager.buildSessionContext().messages);

		expect(active.messages).toHaveLength(0);
	});

	it("rebuilds the model context with only post-clear turns, not pre-clear history (fix #4)", async () => {
		const active = await createSession();
		seedConversation(active);
		await active.clearSessionContext();

		// A genuine turn recorded after the boundary.
		appendTurn(active, "post-clear task", "did the post-clear task");

		const rebuilt = active.sessionManager.buildSessionContext().messages;
		const text = contextMessageText(rebuilt);

		// The boundary starts emission after itself: only the post-clear pair is in
		// the model context. Reverting fix #4 walks the full branch, so the
		// pre-clear turns return and the length/exclusion assertions redden.
		expect(rebuilt).toHaveLength(2);
		expect(text).toContain("post-clear task");
		expect(text).toContain("did the post-clear task");
		expect(text).not.toContain("first task");
		expect(text).not.toContain("did the first task");
	});

	it("elides a compaction preceding the /clear boundary from the rebuilt model context (fix #4)", async () => {
		const active = await createSession();
		// Pre-compaction turn; its assistant entry anchors the compaction's kept tail.
		const keptId = appendTurn(active, "old task", "old answer");
		active.sessionManager.appendCompaction("summary of old work", "old", keptId, 1000);
		// Post-compaction, pre-clear turn.
		appendTurn(active, "mid task", "mid answer");

		await active.clearSessionContext();

		// Post-clear turn — everything before the boundary (including the
		// compaction summary + its kept tail) must be superseded by the boundary.
		appendTurn(active, "new task", "new answer");

		const rebuilt = active.sessionManager.buildSessionContext().messages;
		const text = contextMessageText(rebuilt);

		// Boundary is after the latest compaction, so it wins: only the post-clear
		// pair emits. Reverting fix #4 falls through to the compaction branch,
		// re-injecting the summary + kept tail + mid turn into the LLM context.
		expect(rebuilt).toHaveLength(2);
		expect(text).toContain("new task");
		expect(text).toContain("new answer");
		expect(text).not.toContain("summary of old work");
		expect(text).not.toContain("old answer");
		expect(text).not.toContain("mid answer");
	});

	it("refuses to clear while a foreground bash command is in flight (fix #3)", async () => {
		const active = await createSession();
		seedConversation(active);
		const liveBefore = active.messages.length;
		expect(liveBefore).toBeGreaterThan(0);
		expect(active.sessionManager.getBranch().filter(entry => entry.type === "clear_boundary")).toHaveLength(0);

		// Real in-flight seam: hang executeBash so its AbortController stays in the
		// set and isBashRunning is genuinely true (Bun's spyOn cannot stub the
		// getter). Release it after the assertions so the session tears down clean.
		const dispatched = Promise.withResolvers<void>();
		const release = Promise.withResolvers<bashExecutor.BashResult>();
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			dispatched.resolve();
			return release.promise;
		});

		const inFlight = active.executeBash("sleep 999");
		await dispatched.promise;
		expect(active.isBashRunning).toBe(true);

		const result = await active.clearSessionContext();

		// No-op: undefined, messages intact, and no clear_boundary appended.
		// Reverting fix #3 (guard back to isStreaming only) lets /clear proceed —
		// result becomes { droppedCount }, messages drop to 0, and a boundary lands.
		expect(result).toBeUndefined();
		expect(active.messages).toHaveLength(liveBefore);
		expect(active.sessionManager.getBranch().filter(entry => entry.type === "clear_boundary")).toHaveLength(0);

		release.resolve({
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 0,
			totalBytes: 0,
			outputLines: 0,
			outputBytes: 0,
		});
		await inFlight;
	});
});

describe("clear boundary durable display", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-clear-boundary-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await fs.promises
			.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
			.catch(() => undefined);
		vi.restoreAllMocks();
	});

	async function createSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["unused"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated({ "compaction.enabled": false });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return session;
	}

	function seedTurn(active: AgentSession, userText: string, assistantText: string): void {
		active.sessionManager.appendMessage({ role: "user", content: userText, timestamp: Date.now() });
		active.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: assistantText }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	function transcriptTexts(active: AgentSession, collapse: boolean): string[] {
		const sm = active.sessionManager;
		const ctx = buildSessionContext(sm.getBranch(), undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: collapse,
		});
		const texts: string[] = [];
		for (const message of ctx.messages) {
			if (!("content" in message)) continue;
			const content = message.content;
			if (typeof content === "string") {
				texts.push(content);
			} else {
				for (const block of content) {
					if (block.type === "text") texts.push(block.text);
				}
			}
		}
		return texts;
	}

	it("hides pre-clear messages from the collapsed live transcript after clearSessionContext()", async () => {
		const active = await createSession();
		seedTurn(active, "pre-clear question", "pre-clear answer");
		await active.clearSessionContext();
		seedTurn(active, "post-clear question", "post-clear answer");

		const live = transcriptTexts(active, true).join("\n");
		expect(live).toContain("post-clear question");
		expect(live).toContain("post-clear answer");
		expect(live).not.toContain("pre-clear question");
		expect(live).not.toContain("pre-clear answer");
	});

	it("keeps the full pre-clear history in the non-collapsed export/resume transcript", async () => {
		const active = await createSession();
		seedTurn(active, "pre-clear question", "pre-clear answer");
		await active.clearSessionContext();
		seedTurn(active, "post-clear question", "post-clear answer");

		const full = transcriptTexts(active, false).join("\n");
		expect(full).toContain("pre-clear question");
		expect(full).toContain("pre-clear answer");
		expect(full).toContain("post-clear question");
		expect(full).toContain("post-clear answer");
	});

	it("persists the clear_boundary entry so it round-trips through save/load", async () => {
		const active = await createSession();
		seedTurn(active, "pre-clear question", "pre-clear answer");
		await active.clearSessionContext();
		seedTurn(active, "post-clear question", "post-clear answer");
		await active.sessionManager.flush();

		const file = active.sessionFile;
		expect(file).toBeDefined();
		const raw = fs.readFileSync(file!, "utf8");
		const parsed = parseSessionEntries(raw);
		const boundaries = parsed.filter(entry => entry.type === "clear_boundary");
		expect(boundaries).toHaveLength(1);

		// Reload from disk and confirm the boundary still gates the collapsed
		// live transcript while the full history survives.
		const reloaded = await SessionManager.open(file!, tempDir);
		try {
			const branch = reloaded.getBranch();
			expect(branch.some(entry => entry.type === "clear_boundary")).toBe(true);
			const liveCtx = buildSessionContext(branch, undefined, undefined, {
				transcript: true,
				collapseCompactedHistory: true,
			});
			const liveTexts: string[] = [];
			for (const message of liveCtx.messages) {
				if (!("content" in message)) continue;
				const content = message.content;
				if (typeof content === "string") {
					liveTexts.push(content);
				} else {
					for (const block of content) {
						if (block.type === "text") liveTexts.push(block.text);
					}
				}
			}
			const liveText = liveTexts.join("\n");
			expect(liveText).toContain("post-clear question");
			expect(liveText).not.toContain("pre-clear question");
		} finally {
			await reloaded.close();
		}
	});
});
