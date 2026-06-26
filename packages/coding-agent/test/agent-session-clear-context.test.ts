import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

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

		// The session itself survives: persistent id, title, file path, and the
		// on-disk transcript all remain — clearing context is not deleting history.
		expect(active.sessionManager.getSessionId()).toBe(persistentId);
		expect(active.sessionName).toBe(title);
		expect(active.sessionFile).toBe(file);
		expect(active.sessionManager.buildSessionContext().messages).toHaveLength(transcriptBefore);
		const transcriptRaw = fs.readFileSync(file!, "utf8");
		expect(transcriptRaw).toContain("first task");
		expect(transcriptRaw).toContain("did the first task");
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
});
