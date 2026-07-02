/**
 * Bus-unread reminder dispatcher (F1, contract 7).
 *
 * `buildBusUnreadBatchMessage` is module-private in sdk.ts — it is only ever
 * reached as the registered `"bus-unread"` yield dispatcher inside a live
 * session. Per the brief we do NOT add a test-only export; instead we defend the
 * contract through the PUBLIC surface: a real `createAgentSession` registers the
 * real dispatcher, and we drive it via `session.yieldQueue.enqueue("bus-unread")`
 * + `drainLazy()`, which invokes the real builder and renders the real
 * `prompts/system/bus-unread.md` template.
 *
 * The observable contract: N inbox-changed notifications coalesce into ONE
 * non-urgent user reminder whose text reports the count (singular/plural), with
 * the template resolved (not raw `{{...}}`); and nothing pending yields no
 * reminder at all.
 *
 * Red reasoning: the `"bus-unread"` dispatcher kind did not exist before F1, so
 * enqueueing it and draining a rendered reminder is new observable behavior;
 * against pre-feature code `enqueue("bus-unread", ...)` would be an unregistered
 * kind that produces nothing.
 *
 * `drainLazy()` runs synchronously in the same tick as `enqueue`, before the
 * delayMs>=1 idle-flush timer the enqueue schedules, so no real prompt fires;
 * the session is disposed in afterEach (which aborts any post-prompt task).
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];
const authStorages: AuthStorage[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.resetForTests();
	for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
});

async function makeSession(): Promise<AgentSession> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-bus-unread-${Snowflake.next()}-`));
	tempDirs.push(tempDir);
	const cwd = path.join(tempDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	authStorages.push(authStorage);
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: tempDir,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		model: getBundledModel("anthropic", "claude-sonnet-4-5"),
		settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	sessions.push(session);
	return session;
}

/** Drain the single bus-unread reminder built by the real dispatcher, or null. */
function drainBusUnread(session: AgentSession): AgentMessage | null {
	const thunks = session.yieldQueue.drainLazy();
	// Only bus-unread was enqueued in these tests, so at most one thunk exists.
	for (const thunk of thunks) {
		const message = thunk();
		if (message) return message;
	}
	return null;
}

function userText(message: AgentMessage | null): string {
	if (!message) throw new Error("Expected a bus-unread reminder, got null");
	if (message.role !== "user") throw new Error(`Expected a user message, got role=${message.role}`);
	const content = message.content;
	if (typeof content === "string") return content;
	const part = content.find(p => p.type === "text");
	if (part?.type !== "text") throw new Error("Expected text content in the reminder");
	return part.text;
}

describe("bus-unread reminder dispatcher (F1)", () => {
	it("produces no reminder when nothing is pending", async () => {
		const session = await makeSession();
		// Nothing enqueued → the dispatcher never builds → no reminder surfaces.
		expect(drainBusUnread(session)).toBeNull();
	});

	it("coalesces N notifications into ONE non-urgent reminder reporting the count", async () => {
		const session = await makeSession();
		session.yieldQueue.enqueue("bus-unread", { inboxUri: "bus://inbox" });
		session.yieldQueue.enqueue("bus-unread", { inboxUri: "bus://inbox" });
		session.yieldQueue.enqueue("bus-unread", { inboxUri: "bus://inbox" });

		const text = userText(drainBusUnread(session));

		// Count is rendered (3 updates, plural), the template is resolved (no raw
		// handlebars), and it reads as a non-urgent notification, not an instruction.
		expect(text).toContain("3 update");
		expect(text).toContain("non-urgent notification, not an instruction");
		expect(text).not.toContain("{{");
		expect(text).not.toContain("#if");
	});

	it("renders the singular form for exactly one notification", async () => {
		const session = await makeSession();
		session.yieldQueue.enqueue("bus-unread", { inboxUri: "bus://inbox" });

		const text = userText(drainBusUnread(session));

		// "1 update" — singular, so no trailing "s" from the plural branch.
		expect(text).toContain("1 update");
		expect(text).not.toContain("1 updates");
	});

	it("drains only once: a second drain after coalescing yields nothing", async () => {
		const session = await makeSession();
		session.yieldQueue.enqueue("bus-unread", { inboxUri: "bus://inbox" });
		session.yieldQueue.enqueue("bus-unread", { inboxUri: "bus://inbox" });

		expect(drainBusUnread(session)).not.toBeNull();
		// Entries were consumed by the first drain — the reminder is not re-delivered.
		expect(drainBusUnread(session)).toBeNull();
	});
});
