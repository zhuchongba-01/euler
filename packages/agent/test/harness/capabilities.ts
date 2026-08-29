import { randomBytes } from "node:crypto";
import { symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Probe once whether the OS allows creating real symlinks.
 *
 * Windows requires Developer Mode or elevated rights to create symlinks;
 * the capability probe lets symlink-specific tests skip gracefully there
 * instead of failing with EPERM.
 */
export const canSymlink: boolean = (() => {
	const link = join(tmpdir(), `euler-symprobe-${process.pid}-${randomBytes(4).toString("hex")}`);
	try {
		symlinkSync(tmpdir(), link, "dir");
		unlinkSync(link);
		return true;
	} catch {
		return false;
	}
})();
