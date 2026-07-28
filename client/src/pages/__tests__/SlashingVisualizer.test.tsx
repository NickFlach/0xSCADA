/**
 * UI provenance tests for the Slashing & Liveness Visualizer (issue #456).
 *
 * The rejected implementation drew a chart from PRNG output with nothing in the
 * UI to say so. These tests assert the user-visible halves of the fix:
 *  - when the live source is unavailable the page says so and draws no chart,
 *  - when synthetic demo data is loaded the page is unmistakably marked,
 *  - when a live OBSERVED-LIVENESS source is served, the page states what was
 *    measured and what `miss` means for it. That last one is not cosmetic: an
 *    operator must never read "the node did not answer this poll round" as a
 *    missed consensus attestation duty.
 */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import SlashingVisualizer from "../SlashingVisualizer";
import {
  SYNTHETIC_ATTESTATION_NOTICE,
  type AttestationSourceUnavailableResponse,
  type LiveAttestationHistoryResponse,
  type SyntheticAttestationHistoryResponse,
} from "@shared/types/slashing";

const ANCHOR = 1_700_000_000_000;

function unavailableBody(demoAvailable: boolean): AttestationSourceUnavailableResponse {
  return {
    error: "attestation_source_unavailable",
    synthetic: false,
    provenance: "live",
    message: "No live attestation history is available.",
    reason: "No live attestation feed is compiled into this build.",
    demo: {
      available: demoAvailable,
      path: "/api/nodes/attestation-history/demo",
      enabledBy: "SLASHING_DEMO_DATA=true",
    },
  };
}

function demoBody(): SyntheticAttestationHistoryResponse {
  return {
    synthetic: true,
    demo: true,
    provenance: "synthetic",
    generator: "mulberry32",
    notice: SYNTHETIC_ATTESTATION_NOTICE,
    seed: 42,
    window: "24h",
    anchorMs: ANCHOR,
    validators: [
      {
        validatorId: "demo-aurora",
        label: "Aurora (demo)",
        stake: 32000,
        synthetic: true,
        generator: "mulberry32",
        records: [
          { slot: 0, timestamp: ANCHOR - 3_600_000, status: "hit" },
          { slot: 1, timestamp: ANCHOR - 1_800_000, status: "miss" },
          { slot: 2, timestamp: ANCHOR, status: "miss" },
        ],
      },
    ],
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function liveBody(): LiveAttestationHistoryResponse {
  return {
    synthetic: false,
    demo: false,
    provenance: "live",
    source: "oxscada-observed-liveness",
    window: "24h",
    observation: {
      kind: "observed-liveness",
      sourceId: "oxscada-observed-liveness",
      summary:
        "Observed liveness of each configured oxscada node: whether it answered " +
        "each poll round, and whether the chain height it reported advanced.",
      method: {
        transport: "http-get",
        endpoint: "/status",
        fields: ["height", "uptime_ticks"],
        pollIntervalMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        maxRecordsPerQuery: 100_000,
      },
      statusSemantics: {
        hit: "The node answered this poll round and the height it reported advanced.",
        miss: "The node did not answer this poll round.",
        late: "The node answered but the height it reported did not advance.",
      },
      roundIdentifier: {
        field: "slot",
        meaning: "Monotonic ordinal of the poll round — not a consensus slot.",
      },
      stake: {
        available: false,
        note: "No stake source exists in this build, so stake is reported as 0.",
      },
      consensusAttestation: {
        available: false,
        note: "The oxscada /status surface exposes no per-slot duty outcome.",
      },
    },
    validators: [
      {
        validatorId: "10.0.0.11:9090",
        label: "10.0.0.11:9090 (observed liveness)",
        stake: 0,
        records: [
          { slot: 1, timestamp: ANCHOR - 120_000, status: "late", observedHeight: 900 },
          { slot: 2, timestamp: ANCHOR - 60_000, status: "miss", observedHeight: null },
          { slot: 3, timestamp: ANCHOR, status: "hit", observedHeight: 901 },
        ],
      },
    ],
  };
}

/** Route the page's two endpoints to canned responses. */
function stubFetch(demoAvailable: boolean): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/attestation-history/demo")) {
        return jsonResponse(demoBody(), 200);
      }
      return jsonResponse(unavailableBody(demoAvailable), 503);
    }),
  );
}

/** Serve the live endpoint an observed-liveness payload. */
function stubLiveFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(liveBody(), 200)));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SlashingVisualizer provenance", () => {
  it("reports the missing live source instead of rendering a timeline", async () => {
    stubFetch(false);
    render(<SlashingVisualizer />);

    await waitFor(() => expect(screen.getByTestId("no-live-source")).toBeTruthy());
    expect(screen.getByText(/No live attestation data source/)).toBeTruthy();
    // No validator card, and no synthetic banner (nothing synthetic is loaded).
    expect(screen.queryByTestId("synthetic-badge")).toBeNull();
    expect(screen.queryByTestId("synthetic-data-banner")).toBeNull();
    // Demo is disabled server-side, so no way to load fake data from here.
    expect(screen.queryByText(/Load synthetic demo data/)).toBeNull();
    expect(screen.getByText(/SLASHING_DEMO_DATA=true/)).toBeTruthy();
  });

  it("never loads synthetic data without an explicit operator action", async () => {
    stubFetch(true);
    render(<SlashingVisualizer />);

    await waitFor(() => expect(screen.getByTestId("no-live-source")).toBeTruthy());
    expect(screen.queryByTestId("synthetic-data-banner")).toBeNull();
    expect(screen.getByText(/Load synthetic demo data/)).toBeTruthy();
  });

  it("marks the page unmistakably once demo data is loaded", async () => {
    stubFetch(true);
    render(<SlashingVisualizer />);

    await waitFor(() => expect(screen.getByText(/Load synthetic demo data/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Load synthetic demo data/));

    const banner = await screen.findByTestId("synthetic-data-banner");
    expect(banner.textContent).toContain("SYNTHETIC DEMO DATA — NOT REAL ATTESTATION HISTORY");
    expect(banner.textContent).toContain("pseudo-random");
    expect(banner.getAttribute("role")).toBe("alert");

    // Heading, per-validator badge and the projection caption all carry it too.
    expect(screen.getByText(/— SYNTHETIC DEMO DATA/)).toBeTruthy();
    expect(screen.getByTestId("synthetic-badge").textContent).toBe("SYNTHETIC");
    expect(screen.getByText(/meaningless operationally/)).toBeTruthy();
    // The unavailable panel is gone, and the simulator actually ran.
    expect(screen.queryByTestId("no-live-source")).toBeNull();
    expect(screen.getByText(/Aurora \(demo\)/)).toBeTruthy();
  });
});

describe("SlashingVisualizer live observed-liveness semantics", () => {
  it("states what was measured and what each status means", async () => {
    stubLiveFetch();
    render(<SlashingVisualizer />);

    const panel = await screen.findByTestId("observation-descriptor");

    // Which source, and what class of thing it measured.
    expect(panel.textContent).toContain("oxscada-observed-liveness");
    expect(panel.textContent).toContain("observed-liveness");
    // How it was measured, and how often.
    expect(panel.textContent).toContain("/status");
    expect(panel.textContent).toContain("60s");
    // The status definitions verbatim from the server — this is the line that
    // stops a "miss" being read as a missed consensus duty.
    expect(panel.textContent).toContain("The node did not answer this poll round.");
    expect(panel.textContent).toContain("the height it reported did not advance");
    // And the plain statement that duty history is still unavailable.
    expect(
      screen.getByTestId("no-consensus-attestation").textContent,
    ).toContain("Consensus attestation duty history is not available");
  });

  it("counts poll rounds rather than consensus duties", async () => {
    stubLiveFetch();
    render(<SlashingVisualizer />);

    await screen.findByTestId("observation-descriptor");

    // "Duties" is consensus vocabulary. These records are poll observations, and
    // saying "Duties" one line below the descriptor panel would re-introduce the
    // exact confusion that panel exists to prevent.
    expect(screen.getByText(/Poll rounds: 3/)).toBeTruthy();
    expect(screen.queryByText(/Duties:/)).toBeNull();
  });

  it("renders the projection without a fabricated stake amount", async () => {
    stubLiveFetch();
    render(<SlashingVisualizer />);

    await screen.findByTestId("observation-descriptor");

    expect(screen.getByTestId("stake-not-observed").textContent).toBe("Stake: not observed");
    expect(screen.getByText(/absolute amount not computed/)).toBeTruthy();
    // The simulator still ran over the real records...
    expect(screen.getByText(/10\.0\.0\.11:9090 \(observed liveness\)/)).toBeTruthy();
    // ...and nothing is marked synthetic, because nothing here is.
    expect(screen.queryByTestId("synthetic-data-banner")).toBeNull();
    expect(screen.queryByTestId("synthetic-badge")).toBeNull();
    expect(screen.queryByTestId("no-live-source")).toBeNull();
  });
});
