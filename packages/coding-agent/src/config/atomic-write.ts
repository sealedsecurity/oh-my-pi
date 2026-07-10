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
	// Resolve `targetPath` to the real file the write should land on, preserving
	// any symlink(s) at or above it. `realpath` handles the common case (every
	// hop's referent exists); the fallback below handles a symlink whose final
	// referent does not exist yet.
	let realPath = targetPath;
	try {
		if ((await fs.lstat(targetPath)).isSymbolicLink()) {
			try {
				realPath = await fs.realpath(targetPath);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				// A symlink chain whose FINAL referent is missing (e.g. a first-run
				// config.yml -> current.yml -> not-yet-created.yml into a dotfiles
				// checkout). `realpath` throws ENOENT at the missing tail, so walk the
				// chain hop by hop — following each existing intermediate link — until
				// the referent is a non-symlink or does not exist. Writing to that
				// final referent preserves every intermediate link instead of
				// clobbering one into a regular file.
				let current = targetPath;
				for (;;) {
					const referent = await fs.readlink(current);
					const resolved = path.resolve(path.dirname(current), referent);
					let nextIsLink = false;
					try {
						nextIsLink = (await fs.lstat(resolved)).isSymbolicLink();
					} catch (lstatError) {
						if (!isEnoent(lstatError)) throw lstatError;
					}
					if (!nextIsLink) {
						realPath = resolved;
						break;
					}
					current = resolved;
				}
			}
		}
	} catch (error) {
		// Nothing at the path — write at the path itself.
		if (!isEnoent(error)) throw error;
	}

	// Preserve the real target's permissions and never briefly widen them. A
	// tightened (e.g. 0600) config can hold secrets, so the temp must be created
	// with a restrictive mode from the start — `Bun.write` would create it at the
	// umask default (typically 0644), exposing secrets in the window before a
	// later chmod. Create the temp at the target's mode (0600 when the target
	// does not exist yet, so a brand-new secret file is never born world-readable)
	// and chmod after writing to pin it exactly against the process umask.
	let mode: number | undefined;
	try {
		mode = (await fs.stat(realPath)).mode & 0o777;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const createMode = mode ?? 0o600;

	const tmpPath = path.join(path.dirname(realPath), `.${path.basename(realPath)}.${process.pid}.${Date.now()}.tmp`);
	try {
		// `Bun.write` auto-created missing parents; `fs.writeFile` does not, so
		// recreate that for a first-run target under a not-yet-existing dir.
		await fs.mkdir(path.dirname(tmpPath), { recursive: true });
		await fs.writeFile(tmpPath, data, { mode: createMode });
		await fs.chmod(tmpPath, createMode);
		await fs.rename(tmpPath, realPath);
	} catch (error) {
		await fs.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
}
