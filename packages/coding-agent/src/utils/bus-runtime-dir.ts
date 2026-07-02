import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Owner-private runtime directory for the comms-bus delivery socket.
 *
 * Prefers `$XDG_RUNTIME_DIR/omp` — the correct Linux home for per-user runtime
 * sockets (tmpfs, auto-cleaned on logout, already `0700`). Falls back to
 * `os.tmpdir()/omp-run` when unset (macOS, containers), created `0700` and
 * chmod'd defensively since `os.tmpdir()` is world-shared — same posture as the
 * shell-snapshot dir. Returns the ensured directory path.
 */
export function busRuntimeDir(): string {
	const xdg = process.env.XDG_RUNTIME_DIR?.trim();
	const dir = xdg ? path.join(xdg, "omp") : path.join(os.tmpdir(), "omp-run");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// best-effort: dir may be owned by another user on a shared box
	}
	return dir;
}

/** Absolute path of this process's delivery socket under {@link busRuntimeDir}. */
export function busSocketPath(): string {
	return path.join(busRuntimeDir(), `${process.pid}.sock`);
}
