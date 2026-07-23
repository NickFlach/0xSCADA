/**
 * XML escaping helpers for the vendor code generators (#479, #509 review).
 *
 * The generators interpolate control-module / phase names, data types and
 * comments — all attacker-controllable via the request body — directly into
 * TIA Portal XML and Rockwell L5X markup. Names carrying `&`, `<`, `>`, quotes
 * or a `]]>` CDATA terminator would otherwise produce malformed markup, or in
 * the worst case inject arbitrary elements into a file a control engineer
 * imports into live PLC tooling. Escape at every interpolation site.
 */

/** Escape text/attribute content for XML element bodies and quoted attributes. */
export function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Make text safe to place inside a `<![CDATA[ ... ]]>` section. CDATA cannot be
 * escaped from within, so the only defense is to split any `]]>` terminator
 * across two adjacent CDATA sections so it can never close the block early.
 */
export function escapeCdata(value: unknown): string {
  return String(value ?? "").replace(/]]>/g, "]]]]><![CDATA[>");
}
