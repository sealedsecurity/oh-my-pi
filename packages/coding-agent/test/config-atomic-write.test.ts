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

	test("preserves the real target's 0600 permissions across the rename", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atomic-write-"));
		try {
			const p = path.join(dir, "config.yml");
			await fs.writeFile(p, "secret: old\n");
			await fs.chmod(p, 0o600);

			await atomicWriteThroughSymlink(p, "secret: new\n");

			expect(await fs.readFile(p, "utf8")).toBe("secret: new\n");
			expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("preserves permissions of the symlink's real target, keeping the link", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atomic-write-"));
		try {
			const real = path.join(dir, "config.yml");
			await fs.writeFile(real, "secret: old\n");
			await fs.chmod(real, 0o600);
			const link = path.join(dir, "linked.yml");
			await fs.symlink(real, link);

			await atomicWriteThroughSymlink(link, "secret: new\n");

			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(real, "utf8")).toBe("secret: new\n");
			expect((await fs.stat(real)).mode & 0o777).toBe(0o600);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("writes through a dangling symlink to its referent, preserving the link", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atomic-write-"));
		try {
			const referent = path.join(dir, "config.yml");
			const link = path.join(dir, "linked.yml");
			// Link points at a referent that does not exist yet (first-run dotfiles case).
			await fs.symlink(referent, link);

			await atomicWriteThroughSymlink(link, "fresh\n");

			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(referent, "utf8")).toBe("fresh\n");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("resolves a dangling symlink chain to its final referent, preserving every link", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atomic-write-"));
		try {
			// link -> mid -> config.yml, where the FINAL referent does not exist yet
			// (first-run dotfiles: a chain of links terminating at a not-yet-created
			// file). realpath throws ENOENT at the tail, so the resolver must walk
			// every hop rather than clobbering the first intermediate link.
			const referent = path.join(dir, "config.yml");
			const mid = path.join(dir, "mid.yml");
			const link = path.join(dir, "linked.yml");
			await fs.symlink(referent, mid);
			await fs.symlink(mid, link);

			await atomicWriteThroughSymlink(link, "fresh\n");

			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
			expect((await fs.lstat(mid)).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(referent, "utf8")).toBe("fresh\n");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("creates a brand-new file with 0600, never a world-readable default", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-atomic-write-"));
		const originalUmask = process.umask(0o022);
		try {
			// No existing target: a fresh config that may hold secrets must not be
			// born 0644. The temp is created at 0600 from the start, so the rename
			// never exposes contents even briefly under a permissive umask.
			const p = path.join(dir, "config.yml");
			await atomicWriteThroughSymlink(p, "secret: fresh\n");
			expect(await fs.readFile(p, "utf8")).toBe("secret: fresh\n");
			expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(originalUmask);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
