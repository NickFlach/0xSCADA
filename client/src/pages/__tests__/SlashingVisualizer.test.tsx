/**
 * UI provenance tests for the Slashing & Liveness Visualizer (issue #456).
 *
 * The rejected implementation drew a chart from PRNG output with nothing in the
 * UI to say so. These tests assert the two user-visible halves of the fix:
 *  - when the live source is unavailable the page says so and draws no chart,
 *  - when synthetic demo data is loaded the page is unmistakably marked.
 */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import SlashingVisualizer from "../SlashingVisualizer";
import {
  SYNTHETIC_ATTESTATION_NOTICE,
  type AttestationSourceUnavailableResponse,
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
