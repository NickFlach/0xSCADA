/**
 * Tag Status Card Component
 * 
 * Track A1.1 - Frontend Engineering
 * 
 * A reusable component that displays an industrial tag's name,
 * value, unit, and status indicator.
 */

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// =============================================================================
// TYPES
// =============================================================================

export type TagStatus = "normal" | "warning" | "critical";

export interface TagData {
  /** Unique identifier or name for the tag */
  name: string;
  /** Current value of the tag (numeric, string, or boolean) */
  value: number | string | boolean;
  /** Engineering unit (e.g., "°C", "PSI", "kW") */
  unit?: string;
  /** Status indicator: normal (green), warning (yellow), critical (red) */
  status: TagStatus;
}

export interface TagStatusCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Tag data to display */
  tag: TagData;
  /** Optional click handler */
  onClick?: () => void;
}

// =============================================================================
// STATUS INDICATOR
// =============================================================================

function StatusIndicator({ status }: { status: TagStatus }) {
  const statusStyles: Record<TagStatus, string> = {
    normal: "bg-green-500",
    warning: "bg-yellow-500",
    critical: "bg-red-500",
  };

  return (
    <span
      className={cn(
        "inline-block w-3 h-3 rounded-full",
        statusStyles[status]
      )}
      aria-label={`Status: ${status}`}
    />
  );
}

// =============================================================================
// TAG STATUS CARD
// =============================================================================

const TagStatusCard = React.forwardRef<HTMLDivElement, TagStatusCardProps>(
  ({ tag, onClick, className, ...props }, ref) => {
    const formatValue = (value: number | string | boolean): string => {
      if (typeof value === "number") {
        return value.toFixed(2);
      }
      if (typeof value === "boolean") {
        return value ? "ON" : "OFF";
      }
      return String(value);
    };

    const statusBorderStyles: Record<TagStatus, string> = {
      normal: "border-green-500/30 hover:border-green-500/50",
      warning: "border-yellow-500/30 hover:border-yellow-500/50",
      critical: "border-red-500/30 hover:border-red-500/50",
    };

    return (
      <Card
        ref={ref}
        className={cn(
          "transition-colors cursor-pointer",
          statusBorderStyles[tag.status],
          className
        )}
        onClick={onClick}
        {...props}
      >
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="font-mono truncate">{tag.name}</span>
            <StatusIndicator status={tag.status} />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-mono font-bold text-primary">
              {formatValue(tag.value)}
            </span>
            {tag.unit && (
              <span className="text-sm text-muted-foreground">{tag.unit}</span>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
);

TagStatusCard.displayName = "TagStatusCard";

export { TagStatusCard };
export default TagStatusCard;
