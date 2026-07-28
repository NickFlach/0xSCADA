/**
 * Generator for the committed GOOSE replay capture.
 *
 *   npx tsx server/protocols/iec61850-goose/__tests__/generate-replay-pcap.ts
 *
 * Writes `fixtures/goose-replay.pcap` from {@link buildReplayScenario}. The
 * fixture is committed so the replay test is self-contained, and
 * `pcap-replay.test.ts` asserts the committed bytes equal what this script
 * produces — so the binary can never silently drift from its source.
 *
 * Issue: #465
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePcap } from "../pcap.js";
import { buildReplayScenario } from "./fixtures.js";

/** Absolute path of the committed replay capture. */
export const REPLAY_PCAP_PATH = fileURLToPath(
  new URL("./fixtures/goose-replay.pcap", import.meta.url),
);

/** Encode the scenario exactly as it is stored on disk. */
export function encodeReplayPcap(): Buffer {
  return encodePcap(
    buildReplayScenario().map(({ timestampMs, data }) => ({ timestampMs, data })),
  );
}

function main(): void {
  const scenario = buildReplayScenario();
  const bytes = encodeReplayPcap();
  mkdirSync(dirname(REPLAY_PCAP_PATH), { recursive: true });
  writeFileSync(REPLAY_PCAP_PATH, bytes);
  process.stdout.write(
    `wrote ${REPLAY_PCAP_PATH} (${bytes.length} bytes, ${scenario.length} packets)\n`,
  );
  for (const [index, packet] of scenario.entries()) {
    const offset = packet.timestampMs - scenario[0].timestampMs;
    process.stdout.write(
      `  [${index}] +${offset}ms ${packet.data.length}B — ${packet.description}\n`,
    );
  }
}

// Only run when executed directly, so the module can be imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
