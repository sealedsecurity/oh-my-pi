import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { findEnvrc, loadDirenvEnv, parseDirenvExport } from "@oh-my-pi/pi-coding-agent/exec/direnv";
import { TempDir } from "@oh-my-pi/pi-utils";

const tmpDirs: TempDir[] = [];
function tmp(): string {
	const dir = TempDir.createSync("@pi-direnv-");
	tmpDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) await dir.remove();
});

describe("findEnvrc", () => {
	it("walks up to the nearest .envrc above the start dir", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export A=1\n");
		const nested = path.join(root, "a", "b");
		await fs.mkdir(nested, { recursive: true });

		expect(await findEnvrc(nested)).toBe(path.join(root, ".envrc"));
	});

	it("prefers the nearest .envrc when monorepo dirs nest them", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export A=1\n");
		const sub = path.join(root, "pkg");
		await fs.mkdir(sub, { recursive: true });
		await Bun.write(path.join(sub, ".envrc"), "export B=2\n");

		expect(await findEnvrc(sub)).toBe(path.join(sub, ".envrc"));
	});

	it("returns null when no .envrc exists up the tree", async () => {
		const nested = path.join(tmp(), "x", "y");
		await fs.mkdir(nested, { recursive: true });

		expect(await findEnvrc(nested)).toBeNull();
	});
});

describe("parseDirenvExport", () => {
	it("splits set values from null unsets", () => {
		const out = parseDirenvExport('{"FOO":"bar","BAZ":null,"PATH":"/x:/y"}');

		expect(out.set).toEqual({ FOO: "bar", PATH: "/x:/y" });
		expect(out.unset).toEqual(["BAZ"]);
	});

	it("treats empty / whitespace output as no diff", () => {
		expect(parseDirenvExport("")).toEqual({ set: {}, unset: [] });
		expect(parseDirenvExport("  \n")).toEqual({ set: {}, unset: [] });
	});
});

describe("loadDirenvEnv (real direnv, auto-allow)", () => {
	it("auto-allows an untrusted .envrc and returns its exported vars + PATH additions", async () => {
		const root = tmp();
		await fs.mkdir(path.join(root, "bin"), { recursive: true });
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_FEATURE_TEST=loaded\nPATH_add bin\n");

		const env = await loadDirenvEnv(root);

		expect(env?.DIRENV_FEATURE_TEST).toBe("loaded");
		expect(env?.PATH).toContain(path.join(root, "bin"));
	});

	it("returns null when there is no .envrc to load", async () => {
		expect(await loadDirenvEnv(tmp())).toBeNull();
	});

	it("re-loads when the .envrc content changes (cache keyed by content)", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_CACHE_TEST=one\n");
		expect((await loadDirenvEnv(root))?.DIRENV_CACHE_TEST).toBe("one");

		await Bun.write(path.join(root, ".envrc"), "export DIRENV_CACHE_TEST=two\n");
		expect((await loadDirenvEnv(root))?.DIRENV_CACHE_TEST).toBe("two");
	});
});

describe("bash executor direnv wiring (end-to-end)", () => {
	it("exposes direnv-loaded vars to the command while per-call env still wins", async () => {
		const root = tmp();
		await Bun.write(path.join(root, ".envrc"), "export DIRENV_WIRE_TEST=fromdirenv\nexport OVERRIDE_ME=fromdirenv\n");

		const result = await executeBash('printf "%s|%s" "$DIRENV_WIRE_TEST" "$OVERRIDE_ME"', {
			cwd: root,
			env: { OVERRIDE_ME: "fromcaller" },
		});

		expect(result.output).toContain("fromdirenv|fromcaller");
	});
});
