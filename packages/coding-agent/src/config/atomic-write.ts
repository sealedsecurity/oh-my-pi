import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

/**
 * Atomically write `data` to `targetPath` while preserving a symlink at
 * `targetPath`. OMP-managed config (e.g. `config.yml`) is often a symlink into a
 * dotfiles/nix checkout; a plain `rename` onto the link path clobbers the link
 * into a regular file — stranding the repo copy and forcing a re-symlink. We
 * resolve the link to its real target first, then write a sibling temp file and
 * `rename` it onto the real path: the link stays intact and the write is
 * crash-atomic (no truncate-in-place window). Suitable for any file a user might
 * symlink, not just config.
 */
export async function atomicWriteThroughSymlink(targetPath: string, data: string): Promise<void> {
	let realPath = targetPath;
	try {
		if ((await fs.lstat(targetPath)).isSymbolicLink()) {
			realPath = await fs.realpath(targetPath);
		}
	} catch (error) {
		// Nothing at the path (or a dangling link) — write at the path itself.
		if (!isEnoent(error)) throw error;
	}

	const tmpPath = path.join(path.dirname(realPath), `.${path.basename(realPath)}.${process.pid}.${Date.now()}.tmp`);
	try {
		await Bun.write(tmpPath, data);
		await fs.rename(tmpPath, realPath);
	} catch (error) {
		await fs.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
}
