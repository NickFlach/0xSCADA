/**
 * Live Tags Panel Component
 * 
 * Phase 4: Visualization + Operator UX
 * 
 * Features:
 * - Real-time tag value display
 * - Quality indicators
 * - Alarm state highlighting
 * - Trend sparklines
 */

import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Activity, 
  AlertTriangle, 
  CheckCircle, 
  XCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
} from "lucide-react";

// =============================================================================
// TYPES
// =============================================================================

export interface TagValue {
  tag: string;
  value: number | string | boolean;
  unit?: string;
  quality: "GOOD" | "BAD" | "UNCERTAIN";
  timestamp: Date;
  assetId?: string;
  assetName?: string;
  alarmState?: "NORMAL" | "HIGH" | "HIHI" | "LOW" | "LOLO";
  trend?: "UP" | "DOWN" | "STABLE";
  history?: number[];
}

export interface LiveTagsPanelProps {
  tags: TagValue[];
  onTagClick?: (tag: TagValue) => void;
  refreshInterval?: number;
  showSparklines?: boolean;
  compact?: boolean;
}

// =============================================================================
// SPARKLINE COMPONENT
// =============================================================================

function Sparkline({ data, width = 60, height = 20 }: { data: number[]; width?: number; height?: number }) {
  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = height - ((value - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width={width} height={height} className="inline-block ml-2">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-primary"
      />
    </svg>
  );
}

// =============================================================================
// QUALITY INDICATOR
// =============================================================================

function QualityIndicator({ quality }: { quality: "GOOD" | "BAD" | "UNCERTAIN" }) {
  switch (quality) {
    case "GOOD":
      return <CheckCircle className="w-3 h-3 text-green-500" />;
    case "BAD":
      return <XCircle className="w-3 h-3 text-red-500" />;
    case "UNCERTAIN":
      return <AlertTriangle className="w-3 h-3 text-yellow-500" />;
  }
}

// =============================================================================
// TREND INDICATOR
// =============================================================================

function TrendIndicator({ trend }: { trend?: "UP" | "DOWN" | "STABLE" }) {
  switch (trend) {
    case "UP":
      return <TrendingUp className="w-3 h-3 text-green-500" />;
    case "DOWN":
      return <TrendingDown className="w-3 h-3 text-red-500" />;
    default:
      return <Minus className="w-3 h-3 text-muted-foreground" />;
  }
}

// =============================================================================
// ALARM STATE BADGE
// =============================================================================

function AlarmStateBadge({ state }: { state?: string }) {
  if (!state || state === "NORMAL") return null;

  const variants: Record<string, string> = {
    HIGH: "bg-orange-500/20 text-orange-500 border-orange-500/50",
    HIHI: "bg-red-500/20 text-red-500 border-red-500/50",
    LOW: "bg-blue-500/20 text-blue-500 border-blue-500/50",
    LOLO: "bg-purple-500/20 text-purple-500 border-purple-500/50",
  };

  return (
    <Badge className={`text-xs ${variants[state] || ""}`}>
      {state}
    </Badge>
  );
}

// =============================================================================
// TAG ROW COMPONENT
// =============================================================================

function TagRow({ 
  tag, 
  onClick, 
  showSparkline,
  compact,
}: { 
  tag: TagValue; 
  onClick?: () => void;
  showSparkline?: boolean;
  compact?: boolean;
}) {
  const formatValue = (value: number | string | boolean): string => {
    if (typeof value === "number") {
      return value.toFixed(2);
    }
    if (typeof value === "boolean") {
      return value ? "ON" : "OFF";
    }
    return String(value);
  };

  const isAlarm = tag.alarmState && tag.alarmState !== "NORMAL";

  return (
    <div
      className={`
        flex items-center justify-between p-2 rounded-md cursor-pointer
        transition-colors hover:bg-muted/50
        ${isAlarm ? "bg-red-500/10 border border-red-500/30" : ""}
        ${compact ? "py-1" : "py-2"}
      `}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <QualityIndicator quality={tag.quality} />
        <div className="flex flex-col min-w-0">
          <span className="font-mono text-sm truncate">{tag.tag}</span>
          {!compact && tag.assetName && (
            <span className="text-xs text-muted-foreground truncate">{tag.assetName}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {showSparkline && tag.history && (
          <Sparkline data={tag.history} />
        )}
        
        <TrendIndicator trend={tag.trend} />
        
        <div className="text-right min-w-[80px]">
          <span className="font-mono font-bold text-sm">
            {formatValue(tag.value)}
          </span>
          {tag.unit && (
            <span className="text-xs text-muted-foreground ml-1">{tag.unit}</span>
          )}
        </div>

        <AlarmStateBadge state={tag.alarmState} />
      </div>
    </div>
  );
}

// =============================================================================
// LIVE TAGS PANEL
// =============================================================================

export function LiveTagsPanel({
  tags,
  onTagClick,
  refreshInterval = 1000,
  showSparklines = true,
  compact = false,
}: LiveTagsPanelProps) {
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setLastUpdate(new Date());
      setIsRefreshing(true);
      setTimeout(() => setIsRefreshing(false), 200);
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [refreshInterval]);

  // Group tags by asset
  const tagsByAsset = tags.reduce((acc, tag) => {
    const assetKey = tag.assetName || tag.assetId || "Unassigned";
    if (!acc[assetKey]) acc[assetKey] = [];
    acc[assetKey].push(tag);
    return acc;
  }, {} as Record<string, TagValue[]>);

  // Count alarms
  const alarmCount = tags.filter(t => t.alarmState && t.alarmState !== "NORMAL").length;
  const badQualityCount = tags.filter(t => t.quality !== "GOOD").length;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Activity className="w-5 h-5 text-primary" />
            Live Tags
            <Badge variant="outline" className="ml-2">
              {tags.length}
            </Badge>
          </CardTitle>
          
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {alarmCount > 0 && (
              <span className="flex items-center gap-1 text-red-500">
                <AlertTriangle className="w-3 h-3" />
                {alarmCount} Alarm{alarmCount !== 1 ? "s" : ""}
              </span>
            )}
            {badQualityCount > 0 && (
              <span className="flex items-center gap-1 text-yellow-500">
                <XCircle className="w-3 h-3" />
                {badQualityCount} Bad
              </span>
            )}
            <span className="flex items-center gap-1">
              <RefreshCw className={`w-3 h-3 ${isRefreshing ? "animate-spin" : ""}`} />
              {lastUpdate.toLocaleTimeString()}
            </span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {Object.entries(tagsByAsset).map(([assetName, assetTags]) => (
          <div key={assetName}>
            {Object.keys(tagsByAsset).length > 1 && (
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {assetName}
              </div>
            )}
            <div className="space-y-1">
              {assetTags.map((tag) => (
                <TagRow
                  key={tag.tag}
                  tag={tag}
                  onClick={() => onTagClick?.(tag)}
                  showSparkline={showSparklines}
                  compact={compact}
                />
              ))}
            </div>
          </div>
        ))}

        {tags.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No live tags available</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default LiveTagsPanel;
