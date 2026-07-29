/**
 * Turning server-supplied names into filenames, safely.
 *
 * The export commands name their output files after fields in the API response
 * — `blueprint.name`, `cm.name`, `unit.name`, `phase.name`. Neither `path.join`
 * nor `path.resolve` sanitises anything: `path.join("out/cm-types",
 * "../../../pwned.yaml")` yields `../pwned.yaml`, and `path.resolve` on an
 * absolute name discards the base directory entirely.
 *
 * A CLI writing where the operator asked is fine. A CLI writing where the
 * SERVER asked is not — the operator running `oxscada blueprints export-all`
 * on an engineering workstation is not consenting to arbitrary file writes, and
 * the interesting targets (`~/.ssh/authorized_keys`, shell rc files, a startup
 * folder) are all reachable with their own permissions.
 */

import path from "path";

/** Characters that cannot appear in a filename on Windows, plus separators. */
const UNSAFE_CHARACTERS = /[\u0000-\u001F<>:"/\\|?*]/g;

/**
 * Reduce an untrusted string to a single, inert path segment.
 *
 * Deliberately conservative: this is a filename, not a path, so every separator
 * is replaced rather than interpreted. Names that reduce to nothing usable —
 * `..`, `.`, an empty string, a Windows reserved device name — fall back to
 * `fallback` rather than being silently skipped, so an export never loses an
 * entry without saying so.
 */
export function safeFileName(name: string, fallback = "unnamed"): string {
  const flattened = name.replace(UNSAFE_CHARACTERS, "_").trim();
  // Trailing dots and spaces are stripped by Windows, which would let "a. "
  // and "a" collide; and a leading dot would hide the file on POSIX.
  const trimmed = flattened.replace(/^\.+/, "").replace(/[. ]+$/, "");

  if (trimmed === "") return fallback;
  // CON, PRN, AUX, NUL, COM1-9, LPT1-9 — reserved on Windows with or without
  // an extension, and opening one talks to a device instead of a file.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(trimmed.split(".")[0])) {
    return `${fallback}-${trimmed}`;
  }
  return trimmed;
}

/**
 * Join a sanitised filename onto a directory, then prove the result stayed
 * inside it.
 *
 * `safeFileName` alone should be sufficient; the containment check is here
 * because a path-safety helper that is merely *believed* correct is worth
 * little. If the two ever disagree, this throws rather than writing.
 */
export function resolveWithinDirectory(
  directory: string,
  untrustedName: string,
  fallback?: string,
): string {
  const base = path.resolve(directory);
  const candidate = path.resolve(base, safeFileName(untrustedName, fallback));

  const relative = path.relative(base, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `refusing to write outside "${directory}": server-supplied name "${untrustedName}" ` +
        `resolved to "${candidate}"`,
    );
  }
  return candidate;
}
