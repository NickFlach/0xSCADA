/**
 * Minimal semver — parse, compare, and range satisfaction
 * ADR-0013 [13.6] — Issue #217
 *
 * The Wave-2 marketplace stored semver strings and never compared them;
 * dependency ranges and update checks here are actually enforced.
 * Supports exact versions, ^ (compatible), ~ (patch-level), and *.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(version: string): SemVer | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/** negative: a < b, 0: equal, positive: a > b. Throws on invalid input. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`Invalid semver: "${!pa ? a : b}"`);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/** Does `version` satisfy `range` ("1.2.3", "^1.2.0", "~1.2.0", "*")? */
export function satisfiesRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === '') return parseSemver(version) !== null;

  const v = parseSemver(version);
  if (!v) return false;

  if (trimmed.startsWith('^')) {
    const base = parseSemver(trimmed.slice(1));
    if (!base) return false;
    if (base.major > 0) {
      return v.major === base.major && compareSemver(version, trimmed.slice(1)) >= 0;
    }
    // ^0.x.y — minor acts as the compatibility boundary
    return (
      v.major === 0 && v.minor === base.minor && compareSemver(version, trimmed.slice(1)) >= 0
    );
  }
  if (trimmed.startsWith('~')) {
    const base = parseSemver(trimmed.slice(1));
    if (!base) return false;
    return (
      v.major === base.major &&
      v.minor === base.minor &&
      compareSemver(version, trimmed.slice(1)) >= 0
    );
  }
  const exact = parseSemver(trimmed);
  return exact !== null && compareSemver(version, trimmed) === 0;
}
