/**
 * Tank Widget Component
 *
 * VS-1.4 - Vertical Slice: Tank Level HMI Widget
 *
 * Visual representation of a storage tank with level indicator,
 * temperature display, and alarm status.
 */

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// =============================================================================
// TYPES
// =============================================================================

export type AlarmState = "normal" | "low" | "high" | "low-low" | "high-high";

export interface TankData {
  /** Tank identifier (e.g., "TK-101") */
  id: string;
  /** Tank description */
  name?: string;
  /** Current level percentage (0-100) */
  level: number;
  /** Current temperature */
  temperature?: number;
  /** Temperature unit */
  temperatureUnit?: string;
  /** Level alarm state */
  alarmState: AlarmState;
  /** Setpoints for display */
  setpoints?: {
    lowLow?: number;
    low?: number;
    high?: number;
    highHigh?: number;
  };
}

export interface TankWidgetProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Tank data to display */
  tank: TankData;
  /** Show setpoint lines on tank */
  showSetpoints?: boolean;
  /** Compact mode (smaller display) */
  compact?: boolean;
  /** Click handler */
  onClick?: () => void;
}

// =============================================================================
// ALARM COLORS
// =============================================================================

const alarmColors: Record<AlarmState, { bg: string; border: string; text: string }> = {
  normal: {
    bg: "bg-green-500",
    border: "border-green-500/30 hover:border-green-500/50",
    text: "text-green-500",
  },
  low: {
    bg: "bg-yellow-500",
    border: "border-yellow-500/30 hover:border-yellow-500/50",
    text: "text-yellow-500",
  },
  high: {
    bg: "bg-yellow-500",
    border: "border-yellow-500/30 hover:border-yellow-500/50",
    text: "text-yellow-500",
  },
  "low-low": {
    bg: "bg-red-500",
    border: "border-red-500/30 hover:border-red-500/50",
    text: "text-red-500",
  },
  "high-high": {
    bg: "bg-red-500",
    border: "border-red-500/30 hover:border-red-500/50",
    text: "text-red-500",
  },
};

// =============================================================================
// TANK VISUALIZATION
// =============================================================================

interface TankVisualizationProps {
  level: number;
  alarmState: AlarmState;
  setpoints?: TankData["setpoints"];
  showSetpoints?: boolean;
  compact?: boolean;
}

function TankVisualization({
  level,
  alarmState,
  setpoints,
  showSetpoints,
  compact,
}: TankVisualizationProps) {
  const height = compact ? 80 : 120;
  const width = compact ? 50 : 70;
  const fillHeight = (level / 100) * (height - 10);
  const colors = alarmColors[alarmState];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="mx-auto"
    >
      {/* Tank outline */}
      <rect
        x={5}
        y={5}
        width={width - 10}
        height={height - 10}
        rx={4}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="text-muted-foreground/50"
      />

      {/* Liquid fill */}
      <rect
        x={7}
        y={height - 7 - fillHeight}
        width={width - 14}
        height={fillHeight}
        rx={2}
        className={cn(colors.bg, "opacity-80")}
      />

      {/* Setpoint lines */}
      {showSetpoints && setpoints && (
        <>
          {setpoints.highHigh && (
            <line
              x1={3}
              y1={height - 5 - (setpoints.highHigh / 100) * (height - 10)}
              x2={width - 3}
              y2={height - 5 - (setpoints.highHigh / 100) * (height - 10)}
              stroke="#ef4444"
              strokeWidth={1}
              strokeDasharray="4,2"
            />
          )}
          {setpoints.high && (
            <line
              x1={3}
              y1={height - 5 - (setpoints.high / 100) * (height - 10)}
              x2={width - 3}
              y2={height - 5 - (setpoints.high / 100) * (height - 10)}
              stroke="#eab308"
              strokeWidth={1}
              strokeDasharray="4,2"
            />
          )}
          {setpoints.low && (
            <line
              x1={3}
              y1={height - 5 - (setpoints.low / 100) * (height - 10)}
              x2={width - 3}
              y2={height - 5 - (setpoints.low / 100) * (height - 10)}
              stroke="#eab308"
              strokeWidth={1}
              strokeDasharray="4,2"
            />
          )}
          {setpoints.lowLow && (
            <line
              x1={3}
              y1={height - 5 - (setpoints.lowLow / 100) * (height - 10)}
              x2={width - 3}
              y2={height - 5 - (setpoints.lowLow / 100) * (height - 10)}
              stroke="#ef4444"
              strokeWidth={1}
              strokeDasharray="4,2"
            />
          )}
        </>
      )}
    </svg>
  );
}

// =============================================================================
// ALARM INDICATOR
// =============================================================================

function AlarmIndicator({ state }: { state: AlarmState }) {
  if (state === "normal") return null;

  const labels: Record<AlarmState, string> = {
    normal: "",
    low: "LOW",
    high: "HIGH",
    "low-low": "LO-LO",
    "high-high": "HI-HI",
  };

  const colors = alarmColors[state];

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-bold animate-pulse",
        colors.bg,
        "text-white"
      )}
    >
      {labels[state]}
    </span>
  );
}

// =============================================================================
// TANK WIDGET
// =============================================================================

const TankWidget = React.forwardRef<HTMLDivElement, TankWidgetProps>(
  ({ tank, showSetpoints = true, compact = false, onClick, className, ...props }, ref) => {
    const colors = alarmColors[tank.alarmState];

    return (
      <Card
        ref={ref}
        className={cn(
          "transition-colors cursor-pointer",
          colors.border,
          compact ? "p-2" : "",
          className
        )}
        onClick={onClick}
        {...props}
      >
        <CardHeader className={cn("pb-2", compact && "p-2")}>
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="font-mono truncate">{tank.id}</span>
            <AlarmIndicator state={tank.alarmState} />
          </CardTitle>
          {tank.name && !compact && (
            <p className="text-xs text-muted-foreground truncate">{tank.name}</p>
          )}
        </CardHeader>

        <CardContent className={cn(compact && "p-2 pt-0")}>
          <div className="flex items-center gap-4">
            {/* Tank visualization */}
            <TankVisualization
              level={tank.level}
              alarmState={tank.alarmState}
              setpoints={tank.setpoints}
              showSetpoints={showSetpoints}
              compact={compact}
            />

            {/* Values */}
            <div className="flex flex-col gap-1">
              {/* Level */}
              <div>
                <span className="text-xs text-muted-foreground">Level</span>
                <div className="flex items-baseline gap-1">
                  <span className={cn("text-2xl font-mono font-bold", colors.text)}>
                    {tank.level.toFixed(1)}
                  </span>
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </div>

              {/* Temperature */}
              {tank.temperature !== undefined && (
                <div>
                  <span className="text-xs text-muted-foreground">Temp</span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-lg font-mono font-semibold text-primary">
                      {tank.temperature.toFixed(1)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {tank.temperatureUnit || "°C"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }
);

TankWidget.displayName = "TankWidget";

export { TankWidget };
export default TankWidget;
