import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    try {
      await directory.sync();
    } catch (error) {
      // Node can open directories on Windows, but FlushFileBuffers on that
      // handle is unsupported. POSIX filesystems must not silently lose the
      // durability guarantee when directory fsync fails.
      if (
        process.platform !== "win32" ||
        !isNodeError(error) ||
        (error.code !== "EPERM" && error.code !== "EINVAL")
      ) {
        throw error;
      }
    }
  } finally {
    await directory.close();
  }
}

/**
 * Atomically replaces a file and makes both its contents and containing
 * directory entry durable before resolving on platforms that support
 * directory fsync. Node rejects directory fsync on Windows, where the helper
 * still provides file fsync plus atomic replacement.
 *
 * The parent directory is created when absent. A failed write removes its
 * unique temporary file and preserves the original error.
 */
export async function writeFileAtomicDurable(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
