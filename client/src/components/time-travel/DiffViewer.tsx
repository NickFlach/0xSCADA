/**
 * Diff Viewer Component
 *
 * β.1.3 - Time-travel debugger UI
 *
 * Compare two reality snapshots side-by-side.
 * See: docs/wireframes/TIME_TRAVEL_DEBUGGER.md
 */

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type {
  DiffViewerProps,
  RealityDiff,
  TankDiff,
  ChangeType,
  ValueChange,
  PLCState,
  AlarmRecord,
} from "./types";

// =============================================================================
// CONSTANTS
// =============================================================================

const CHANGE_INDICATORS: Record<ChangeType, { icon: string; color: string }> = {
  added: { icon: "▲", color: "text-green-500" },
  removed: { icon: "▼", color: "text-red-500" },
  changed: { icon: "◆", color: "text-yellow-500" },
  unchanged: { icon: "─", color: "text-muted-foreground" },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatDelta(delta: number | string | undefined): string {
  if (delta === undefined) return "";
  if (typeof delta === "string") return delta;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

function getChangeType(before: number | undefined, after: number | undefined): ChangeType {
  if (before === undefined && after !== undefined) return "added";
  if (before !== undefined && after === undefined) return "removed";
  if (before === after) return "unchanged";
  return "changed";
}

// =============================================================================
// HELPER COMPONENTS
// =============================================================================

interface DiffRowProps {
  label: string;
  before: React.ReactNode;
  after: React.ReactNode;
  changeType: ChangeType;
  delta?: string;
}

function DiffRow({ label, before, after, changeType, delta }: DiffRowProps) {
  const { icon, color } = CHANGE_INDICATORS[changeType];

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-4 py-2 border-b last:border-0">
      {/* Before */}
      <div className="text-sm">
        <span className="text-muted-foreground">{label}: </span>
        <span className={changeType === "removed" ? "line-through text-muted-foreground" : ""}>
          {before}
        </span>
      </div>

      {/* Change indicator */}
      <div className={cn("flex items-center gap-1 text-sm font-medium", color)}>
        <span>{icon}</span>
        {delta && <span className="text-xs">{delta}</span>}
      </div>

      {/* After */}
      <div className="text-sm">
        <span className="text-muted-foreground">{label}: </span>
        <span className={changeType === "added" ? "font-medium text-green-500" : ""}>
          {after}
        </span>
      </div>
    </div>
  );
}

interface TankDiffRowProps {
  diff: TankDiff;
}

function TankDiffRow({ diff }: TankDiffRowProps) {
  const levelChange = diff.level;
  const alarmChange = diff.alarmState;

  const levelDelta =
    typeof levelChange.delta === "number"
      ? formatDelta(levelChange.delta)
      : undefined;

  const beforeAlarm = alarmChange.before !== "normal" ? alarmChange.before : null;
  const afterAlarm = alarmChange.after !== "normal" ? alarmChange.after : null;

  const isImproved =
    (levelChange.type === "changed" && typeof levelChange.delta === "number" && levelChange.delta < 0 && levelChange.before! > 80) ||
    (alarmChange.type === "changed" && alarmChange.before !== "normal" && alarmChange.after === "normal");

  const isWorsened =
    (alarmChange.type === "changed" && alarmChange.before === "normal" && alarmChange.after !== "normal") ||
    (levelChange.type === "changed" && typeof levelChange.delta === "number" && levelChange.delta > 0 && levelChange.after! > 80);

  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_auto_1fr] gap-4 py-2 px-2 rounded",
        isImproved && "bg-green-500/10",
        isWorsened && "bg-red-500/10"
      )}
    >
      {/* Before */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold">{diff.id}</span>
          {beforeAlarm && (
            <Badge variant="destructive" className="text-xs uppercase">
              {beforeAlarm}
            </Badge>
          )}
        </div>
        <div className="text-sm">{levelChange.before?.toFixed(1)}%</div>
      </div>

      {/* Change */}
      <div className="flex flex-col items-center justify-center">
        <span className={cn("font-mono text-sm", CHANGE_INDICATORS[levelChange.type].color)}>
          {levelDelta || CHANGE_INDICATORS[levelChange.type].icon}
        </span>
        {isImproved && <span className="text-xs text-green-500">✓</span>}
        {isWorsened && <span className="text-xs text-red-500">⚠</span>}
      </div>

      {/* After */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold">{diff.id}</span>
          {afterAlarm && (
            <Badge variant="destructive" className="text-xs uppercase">
              {afterAlarm}
            </Badge>
          )}
          {!afterAlarm && beforeAlarm && (
            <Badge variant="secondary" className="text-xs">
              ✓ Cleared
            </Badge>
          )}
        </div>
        <div className="text-sm">{levelChange.after?.toFixed(1)}%</div>
      </div>
    </div>
  );
}

interface PLCDiffRowProps {
  id: string;
  name: string;
  change: ValueChange<PLCState>;
}

function PLCDiffRow({ id, name, change }: PLCDiffRowProps) {
  const recovered = change.before === "FAULT" && change.after === "RUN";
  const faulted = change.before !== "FAULT" && change.after === "FAULT";

  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_auto_1fr] gap-4 py-2 px-2 rounded",
        recovered && "bg-green-500/10",
        faulted && "bg-red-500/10"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm">{id}</span>
        <Badge
          variant={change.before === "FAULT" ? "destructive" : "secondary"}
          className="text-xs"
        >
          {change.before}
        </Badge>
      </div>
      <div className="flex items-center">
        <span className={cn("text-sm", CHANGE_INDICATORS[change.type].color)}>
          →
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm">{id}</span>
        <Badge
          variant={change.after === "FAULT" ? "destructive" : "secondary"}
          className="text-xs"
        >
          {change.after}
        </Badge>
        {recovered && <span className="text-xs text-green-500">✓</span>}
        {faulted && <span className="text-xs text-red-500">🔴</span>}
      </div>
    </div>
  );
}

interface SummaryBadgeProps {
  label: string;
  value: number;
  type: "positive" | "negative" | "neutral";
}

function SummaryBadge({ label, value, type }: SummaryBadgeProps) {
  if (value === 0) return null;

  const colors = {
    positive: "bg-green-500/10 text-green-600 border-green-500/30",
    negative: "bg-red-500/10 text-red-600 border-red-500/30",
    neutral: "bg-muted text-muted-foreground",
  };

  return (
    <Badge variant="outline" className={cn("text-xs", colors[type])}>
      {label}: {type === "positive" ? "▼" : type === "negative" ? "▲" : ""} {value}
    </Badge>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const DiffViewer = React.forwardRef<HTMLDivElement, DiffViewerProps>(
  ({ snapshotA, snapshotB, diff, onSwap, onExport, className }, ref) => {
    const changedTanks = diff.tanks.filter((t) => t.level.type !== "unchanged" || t.alarmState.type !== "unchanged");
    const changedPLCs = diff.plcChanges.filter((p) => p.stateChange.type !== "unchanged");

    return (
      <Card ref={ref} className={cn("", className)}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">⚖️ Reality Diff</span>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono">
                {snapshotA.commit.slice(0, 7)} ↔ {snapshotB.commit.slice(0, 7)}
              </code>
              {onSwap && (
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={onSwap}>
                  🔀
                </Button>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_auto_1fr] gap-4 text-sm font-medium">
            <div className="flex items-center gap-2">
              <span>📉 BEFORE</span>
              <code className="text-xs font-mono text-muted-foreground">
                {snapshotA.commit.slice(0, 7)}
              </code>
            </div>
            <div className="w-16" />
            <div className="flex items-center gap-2">
              <span>📈 AFTER</span>
              <code className="text-xs font-mono text-muted-foreground">
                {snapshotB.commit.slice(0, 7)}
              </code>
            </div>
          </div>

          <Separator />

          {/* Tank differences */}
          {changedTanks.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium flex items-center gap-2">
                🏭 Tanks
                <Badge variant="secondary" className="text-xs">
                  {changedTanks.length} changed
                </Badge>
              </h4>
              <div className="space-y-1 border rounded p-2">
                {changedTanks.map((tank) => (
                  <TankDiffRow key={tank.id} diff={tank} />
                ))}
              </div>
            </div>
          )}

          {/* Alarm differences */}
          {(diff.alarmsAdded.length > 0 || diff.alarmsRemoved.length > 0) && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium flex items-center gap-2">
                🚨 Alarms
                {diff.alarmsRemoved.length > 0 && (
                  <Badge className="text-xs bg-green-500">
                    -{diff.alarmsRemoved.length} cleared
                  </Badge>
                )}
                {diff.alarmsAdded.length > 0 && (
                  <Badge variant="destructive" className="text-xs">
                    +{diff.alarmsAdded.length} raised
                  </Badge>
                )}
              </h4>
              <div className="grid grid-cols-2 gap-4">
                {/* Cleared alarms */}
                {diff.alarmsRemoved.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">Cleared:</div>
                    {diff.alarmsRemoved.map((alarm) => (
                      <div
                        key={alarm.id}
                        className="flex items-center gap-2 text-xs p-1.5 rounded bg-green-500/10 line-through text-muted-foreground"
                      >
                        <span className="font-mono">{alarm.sourceId}</span>
                        <span className="uppercase">{alarm.severity}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* New alarms */}
                {diff.alarmsAdded.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">Raised:</div>
                    {diff.alarmsAdded.map((alarm) => (
                      <div
                        key={alarm.id}
                        className="flex items-center gap-2 text-xs p-1.5 rounded bg-red-500/10"
                      >
                        <span className="font-mono">{alarm.sourceId}</span>
                        <Badge variant="destructive" className="text-xs uppercase">
                          {alarm.severity}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* PLC differences */}
          {changedPLCs.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium flex items-center gap-2">
                ⚡ PLC Status
                <Badge variant="secondary" className="text-xs">
                  {changedPLCs.length} changed
                </Badge>
              </h4>
              <div className="space-y-1 border rounded p-2">
                {changedPLCs.map((plc) => (
                  <PLCDiffRow
                    key={plc.id}
                    id={plc.id}
                    name={plc.name}
                    change={plc.stateChange}
                  />
                ))}
              </div>
            </div>
          )}

          <Separator />

          {/* Summary */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Summary</h4>
            <div className="flex items-center gap-2 flex-wrap">
              <SummaryBadge
                label="Tanks changed"
                value={diff.summary.tanksChanged}
                type="neutral"
              />
              <SummaryBadge
                label="Alarms cleared"
                value={diff.summary.alarmsCleared}
                type="positive"
              />
              <SummaryBadge
                label="Alarms raised"
                value={diff.summary.alarmsRaised}
                type="negative"
              />
              <SummaryBadge
                label="PLCs recovered"
                value={diff.summary.plcRecovered}
                type="positive"
              />
              <SummaryBadge
                label="PLCs faulted"
                value={diff.summary.plcFaulted}
                type="negative"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2">
            {onExport && (
              <Button size="sm" variant="outline" onClick={onExport}>
                ⤓ Export Report
              </Button>
            )}
            {onSwap && (
              <Button size="sm" variant="outline" onClick={onSwap}>
                🔀 Swap A/B
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
);

DiffViewer.displayName = "DiffViewer";

// =============================================================================
// DEMO DATA
// =============================================================================

export const DEMO_DIFF: RealityDiff = {
  commitA: "a7f3e2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4",
  commitB: "b2c4d1f0e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4",
  tanks: [
    {
      id: "TK-101",
      name: "Feed Tank A",
      level: { type: "changed", before: 75.2, after: 82.1, delta: 6.9 },
      alarmState: { type: "unchanged", before: "normal", after: "normal" },
    },
    {
      id: "TK-102",
      name: "Feed Tank B",
      level: { type: "changed", before: 23.1, after: 45.0, delta: 21.9 },
      alarmState: { type: "changed", before: "low", after: "normal" },
    },
    {
      id: "TK-103",
      name: "Product Tank",
      level: { type: "changed", before: 98.4, after: 72.3, delta: -26.1 },
      alarmState: { type: "changed", before: "high-high", after: "normal" },
    },
    {
      id: "TK-104",
      name: "Storage Tank",
      level: { type: "unchanged", before: 45.0, after: 45.0 },
      alarmState: { type: "unchanged", before: "normal", after: "normal" },
    },
  ],
  alarmsAdded: [],
  alarmsRemoved: [
    {
      id: "ALM-001",
      sourceId: "TK-103",
      severity: "high-high",
      message: "Level exceeded 95%",
      timestamp: new Date().toISOString(),
      acknowledged: false,
    },
    {
      id: "ALM-002",
      sourceId: "TK-102",
      severity: "low",
      message: "Level below 25%",
      timestamp: new Date().toISOString(),
      acknowledged: false,
    },
  ],
  plcChanges: [
    {
      id: "PLC-003",
      name: "Valve Controller",
      stateChange: { type: "changed", before: "FAULT", after: "RUN" },
    },
  ],
  artifactsAdded: ["sha256:new123..."],
  artifactsRemoved: [],
  summary: {
    tanksChanged: 3,
    alarmsCleared: 2,
    alarmsRaised: 0,
    plcRecovered: 1,
    plcFaulted: 0,
  },
};

export { DiffViewer };
export default DiffViewer;
