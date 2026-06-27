import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteThroughSymlink } from "@oh-my-pi/pi-coding-agent/config/atomic-write";

describe("atomicWriteThroughSymlink", () => {
	test("follows a symlink: keeps the link, replaces the real target", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atomic-write-"));
		try {
			const real = path.join(dir, "config.yml");
			await fs.writeFile(real, "old\n");
			const link = path.join(dir, "linked.yml");
			await fs.symlink(real, link);

			await atomicWriteThroughSymlink(link, "new\n");

			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(real, "utf8")).toBe("new\n");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("resolves a symlink chain down to the final target", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atomic-write-"));
		try {
			const real = path.join(dir, "real.yml");
			await fs.writeFile(real, "old\n");
			const mid = path.join(dir, "mid.yml");
			await fs.symlink(real, mid);
			const link = path.join(dir, "link.yml");
			await fs.symlink(mid, link);

			await atomicWriteThroughSymlink(link, "new\n");

			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			expect((await fs.lstat(mid)).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(real, "utf8")).toBe("new\n");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("writes a plain file when the path is not a symlink, leaving no temp behind", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atomic-write-"));
		try {
			const p = path.join(dir, "config.yml");
			await atomicWriteThroughSymlink(p, "data\n");
			expect(await fs.readFile(p, "utf8")).toBe("data\n");
			expect((await fs.lstat(p)).isSymbolicLink()).toBe(false);
			expect(await fs.readdir(dir)).toEqual(["config.yml"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("creates the file when nothing exists at the path yet", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atomic-write-"));
		try {
			const p = path.join(dir, "nested", "config.yml");
			await atomicWriteThroughSymlink(p, "fresh\n");
			expect(await fs.readFile(p, "utf8")).toBe("fresh\n");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
