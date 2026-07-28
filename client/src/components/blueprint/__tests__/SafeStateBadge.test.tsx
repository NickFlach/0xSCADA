import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SafeStateBadge, type SafeStateStatus } from "../SafeStateBadge";

function status(overrides: Partial<SafeStateStatus> = {}): SafeStateStatus {
  return {
    blueprintId: "bp-1",
    siteId: "site-1",
    runState: "SAFE_STATE",
    safeState: "force-zero",
    enteredAt: "2026-07-23T12:00:00.000Z",
    reason: "3 consecutive ticks exceeded budget of 10ms",
    consecutiveMisses: 3,
    anchorHash: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

describe("SafeStateBadge", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing while the blueprint is RUNNING", () => {
    const { container } = render(
      <SafeStateBadge status={status({ runState: "RUNNING" })} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("surfaces the applied safe state, reason and anchor when tripped", () => {
    render(<SafeStateBadge status={status()} />);

    expect(screen.getByRole("alert").getAttribute("data-run-state")).toBe("SAFE_STATE");
    expect(screen.getByText("SAFE STATE ACTIVE")).toBeTruthy();
    expect(screen.getByText("Outputs forced to zero")).toBeTruthy();
    expect(screen.getByText("3 consecutive ticks exceeded budget of 10ms")).toBeTruthy();
    expect(screen.getByText(/0123456789abcdef/)).toBeTruthy();
  });

  it("describes a safe recipe by name", () => {
    render(<SafeStateBadge status={status({ safeState: { recipe: "purge-and-vent" } })} />);
    expect(screen.getByText("Safe recipe: purge-and-vent")).toBeTruthy();
  });

  it("requires an explicit confirmation before resuming", () => {
    const onResume = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SafeStateBadge status={status()} onResume={onResume} />);

    fireEvent.click(screen.getByRole("button", { name: /resume blueprint/i }));

    expect(onResume).not.toHaveBeenCalled();
  });

  it("resumes only after the operator confirms", () => {
    const onResume = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SafeStateBadge status={status()} onResume={onResume} />);

    fireEvent.click(screen.getByRole("button", { name: /resume blueprint/i }));

    expect(onResume).toHaveBeenCalledWith("bp-1");
  });

  it("hides the resume control unless the blueprint is settled in SAFE_STATE", () => {
    render(
      <SafeStateBadge
        status={status({ runState: "RECOVERY_FAILED", recoveryErrors: ["halt failed"] })}
        onResume={vi.fn()}
      />,
    );

    expect(screen.getByText("SAFETY RECOVERY FAILED")).toBeTruthy();
    expect(screen.getByText("halt failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /resume blueprint/i })).toBeNull();
  });
});
