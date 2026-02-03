/**
 * Reality Snapshot Component
 *
 * β.1.3 - Time-travel debugger UI
 *
 * Display complete plant state at a specific commit.
 * See: docs/wireframes/TIME_TRAVEL_DEBUGGER.md
 */

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type {
  RealitySnapshotProps,
  RealitySnapshotData,
  TankState,
  PLCStateRecord,
  AlarmRecord,
  SafetyConstraint,
  PLCState,
} from "./types";

// =============================================================================
// CONSTANTS
// =============================================================================

const ALARM_COLORS: Record<string, string> = {
  normal: "bg-green-500",
  info: "bg-blue-500",
  low: "bg-yellow-500",
  high: "bg-yellow-500",
  "low-low": "bg-red-500 animate-pulse",
  "high-high": "bg-red-500 animate-pulse",
};

const PLC_STATE_COLORS: Record<PLCState, string> = {
  RUN: "bg-green-500",
  STOP: "bg-yellow-500",
  FAULT: "bg-red-500 animate-pulse",
  PROGRAM: "bg-blue-500",
  UNKNOWN: "bg-muted",
};

// =============================================================================
// HELPER COMPONENTS
// =============================================================================

interface TankMiniWidgetProps {
  tank: TankState;
}

function TankMiniWidget({ tank }: TankMiniWidgetProps) {
  const levelPercent = Math.min(100, Math.max(0, tank.level));
  const isAlarm = tank.alarmState !== "normal";

  return (
    <div
      className={cn(
        "flex flex-col items-center p-2 rounded-lg border bg-card",
        isAlarm && "border-red-500/50"
      )}
    >
      <span className="text-xs font-mono font-bold">{tank.id}</span>
      {/* Mini tank visualization */}
      <div className="relative w-10 h-16 border-2 border-muted rounded-b-lg mt-1 overflow-hidden">
        <div
          className={cn(
            "absolute bottom-0 left-0 right-0 transition-all duration-300",
            isAlarm ? "bg-red-500/50" : "bg-primary/30"
          )}
          style={{ height: `${levelPercent}%` }}
        />
        {/* Level markers */}
        <div className="absolute inset-0 flex flex-col justify-between py-1">
          <div className="h-px bg-muted-foreground/30 w-full" />
          <div className="h-px bg-muted-foreground/30 w-full" />
          <div className="h-px bg-muted-foreground/30 w-full" />
        </div>
      </div>
      <div className="flex items-center gap-1 mt-1">
        <span className="text-xs font-medium">{tank.level.toFixed(1)}%</span>
        {isAlarm && (
          <span
            className={cn("w-2 h-2 rounded-full", ALARM_COLORS[tank.alarmState])}
            title={tank.alarmState.toUpperCase()}
          />
        )}
      </div>
    </div>
  );
}

interface PLCStatusBadgeProps {
  plc: PLCStateRecord;
}

function PLCStatusBadge({ plc }: PLCStatusBadgeProps) {
  return (
    <div className="flex items-center gap-2 p-2 rounded border bg-card">
      <span
        className={cn("w-2 h-2 rounded-full", PLC_STATE_COLORS[plc.state])}
      />
      <span className="text-sm font-mono">{plc.id}</span>
      <Badge
        variant={plc.state === "FAULT" ? "destructive" : "secondary"}
        className="text-xs"
      >
        {plc.state}
      </Badge>
    </div>
  );
}

interface AlarmListItemProps {
  alarm: AlarmRecord;
}

function AlarmListItem({ alarm }: AlarmListItemProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between p-2 rounded border",
        ALARM_COLORS[alarm.severity] ? `${ALARM_COLORS[alarm.severity]}/20` : "bg-muted",
        alarm.severity.includes("high") || alarm.severity.includes("low")
          ? "border-yellow-500"
          : "border-muted"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn("w-2 h-2 rounded-full", ALARM_COLORS[alarm.severity])}
        />
        <span className="font-mono text-sm font-bold">{alarm.sourceId}</span>
        <Badge variant="outline" className="text-xs uppercase">
          {alarm.severity}
        </Badge>
      </div>
      <span className="text-xs text-muted-foreground truncate max-w-[200px]">
        {alarm.message}
      </span>
    </div>
  );
}

// =============================================================================
// SECTION COMPONENTS
// =============================================================================

interface SectionProps {
  title: string;
  icon: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function Section({ title, icon, badge, defaultOpen = true, children }: SectionProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between p-2 h-auto font-normal"
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <span>{icon}</span>
            {title}
            {badge && (
              <Badge variant="secondary" className="text-xs">
                {badge}
              </Badge>
            )}
          </span>
          <span className="text-muted-foreground">
            {isOpen ? "▼" : "▶"}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const RealitySnapshot = React.forwardRef<HTMLDivElement, RealitySnapshotProps>(
  (
    {
      commit,
      snapshot,
      onRestore,
      onCompare,
      onFork,
      isComparing = false,
      className,
    },
    ref
  ) => {
    const activeAlarms = snapshot.alarms.filter((a) => !a.acknowledged);
    const faultedPLCs = snapshot.plcStates.filter((p) => p.state === "FAULT");
    const violatedConstraints = snapshot.safetyConstraints.filter((c) => c.violated);

    const hasIssues = activeAlarms.length > 0 || faultedPLCs.length > 0 || violatedConstraints.length > 0;

    return (
      <Card
        ref={ref}
        className={cn(
          hasIssues && "border-red-500/50",
          isComparing && "ring-2 ring-secondary",
          className
        )}
      >
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              🌌 Reality Snapshot
              {hasIssues && (
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              )}
            </span>
            <code className="text-xs font-mono text-muted-foreground">
              {commit.slice(0, 7)} @ {new Date(snapshot.timestamp).toLocaleString()}
            </code>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Twin State - Tanks */}
          <Section
            title="Twin State"
            icon="🏭"
            badge={`${snapshot.tanks.length} tanks`}
          >
            <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
              {snapshot.tanks.map((tank) => (
                <TankMiniWidget key={tank.id} tank={tank} />
              ))}
            </div>
          </Section>

          {/* PLC States */}
          <Section
            title="PLC States"
            icon="⚡"
            badge={faultedPLCs.length > 0 ? `${faultedPLCs.length} faulted` : undefined}
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {snapshot.plcStates.map((plc) => (
                <PLCStatusBadge key={plc.id} plc={plc} />
              ))}
            </div>
          </Section>

          {/* Alarms */}
          <Section
            title="Alarms"
            icon="🚨"
            badge={activeAlarms.length > 0 ? `${activeAlarms.length} active` : "0 active"}
            defaultOpen={activeAlarms.length > 0}
          >
            {activeAlarms.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No active alarms at this snapshot
              </p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {activeAlarms.map((alarm) => (
                  <AlarmListItem key={alarm.id} alarm={alarm} />
                ))}
              </div>
            )}
          </Section>

          {/* Safety Constraints */}
          {violatedConstraints.length > 0 && (
            <Section
              title="Safety Violations"
              icon="⚠️"
              badge={`${violatedConstraints.length} violated`}
            >
              <div className="space-y-2">
                {violatedConstraints.map((constraint) => (
                  <div
                    key={constraint.id}
                    className="flex items-center gap-2 p-2 rounded border border-red-500 bg-red-500/10"
                  >
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-sm font-medium">{constraint.name}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2 border-t flex-wrap">
            {onRestore && (
              <Button size="sm" onClick={onRestore}>
                ⟲ Restore to This State
              </Button>
            )}
            {onCompare && (
              <Button size="sm" variant="outline" onClick={onCompare}>
                ⊕ Compare
              </Button>
            )}
            {onFork && (
              <Button size="sm" variant="outline" onClick={onFork}>
                ⑂ Fork Branch
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
);

RealitySnapshot.displayName = "RealitySnapshot";

// =============================================================================
// DEMO DATA
// =============================================================================

export const DEMO_SNAPSHOT: RealitySnapshotData = {
  commit: "a7f3e2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4",
  timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  tanks: [
    { id: "TK-101", name: "Feed Tank A", level: 75.2, alarmState: "normal" },
    { id: "TK-102", name: "Feed Tank B", level: 23.1, alarmState: "low" },
    { id: "TK-103", name: "Product Tank", level: 98.4, alarmState: "high-high" },
    { id: "TK-104", name: "Storage Tank", level: 45.0, alarmState: "normal" },
    { id: "TK-105", name: "Buffer Tank", level: 60.5, alarmState: "normal" },
    { id: "TK-106", name: "Waste Tank", level: 12.3, alarmState: "low-low" },
  ],
  plcStates: [
    { id: "PLC-001", name: "Main Controller", state: "RUN", lastUpdate: new Date().toISOString() },
    { id: "PLC-002", name: "Pump Controller", state: "RUN", lastUpdate: new Date().toISOString() },
    { id: "PLC-003", name: "Valve Controller", state: "FAULT", lastUpdate: new Date().toISOString() },
  ],
  alarms: [
    {
      id: "ALM-001",
      sourceId: "TK-103",
      severity: "high-high",
      message: "Level exceeded 95% threshold",
      timestamp: new Date().toISOString(),
      acknowledged: false,
    },
    {
      id: "ALM-002",
      sourceId: "TK-102",
      severity: "low",
      message: "Level below 25% threshold",
      timestamp: new Date().toISOString(),
      acknowledged: false,
    },
    {
      id: "ALM-003",
      sourceId: "TK-106",
      severity: "low-low",
      message: "Level critically low",
      timestamp: new Date().toISOString(),
      acknowledged: false,
    },
  ],
  safetyConstraints: [
    { id: "SC-001", name: "Max Tank Pressure", active: true, violated: false },
    { id: "SC-002", name: "Min Flow Rate", active: true, violated: false },
    { id: "SC-003", name: "Emergency Shutdown Envelope", active: true, violated: false },
  ],
  artifacts: ["sha256:a7f3e2...", "sha256:b2c4d1...", "sha256:c9e8f7..."],
};

export { RealitySnapshot };
export default RealitySnapshot;
