/**
 * Commit Timeline Component
 *
 * β.1.3 - Time-travel debugger UI
 *
 * Navigate through git history with artifact-aware markers.
 * See: docs/wireframes/TIME_TRAVEL_DEBUGGER.md
 */

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CommitTimelineProps, CommitInfo, CommitStatus } from "./types";

// =============================================================================
// CONSTANTS
// =============================================================================

const STATUS_COLORS: Record<CommitStatus, string> = {
  normal: "bg-muted hover:bg-muted/80",
  warning: "bg-yellow-500 hover:bg-yellow-600",
  error: "bg-red-500 hover:bg-red-600 animate-pulse",
  success: "bg-green-500 hover:bg-green-600",
};

const ARTIFACT_TYPE_ICONS: Record<string, string> = {
  trace: "📊",
  proof: "🔐",
  twin: "🏭",
  decision: "🤖",
  embedding: "🧠",
};

// =============================================================================
// HELPER COMPONENTS
// =============================================================================

interface CommitNodeProps {
  commit: CommitInfo;
  isSelected: boolean;
  isCompare: boolean;
  onClick: () => void;
  onRightClick: (e: React.MouseEvent) => void;
}

function CommitNode({
  commit,
  isSelected,
  isCompare,
  onClick,
  onRightClick,
}: CommitNodeProps) {
  const hasArtifacts = commit.artifactCount > 0;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClick}
            onContextMenu={onRightClick}
            className={cn(
              "relative w-4 h-4 rounded-full transition-all flex-shrink-0",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
              hasArtifacts ? STATUS_COLORS[commit.status] : "bg-muted/50",
              isSelected && "ring-2 ring-primary ring-offset-2 scale-125",
              isCompare && "ring-2 ring-secondary ring-offset-2"
            )}
            aria-label={`Commit ${commit.shortHash}: ${commit.message}`}
          >
            {isSelected && (
              <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-primary-foreground">
                ◉
              </span>
            )}
            {isCompare && !isSelected && (
              <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold">
                ◎
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono">{commit.shortHash}</code>
              {commit.tags?.map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
            <p className="text-sm font-medium">{commit.message}</p>
            <p className="text-xs text-muted-foreground">
              {commit.author} • {formatRelativeTime(commit.timestamp)}
            </p>
            {hasArtifacts && (
              <div className="flex items-center gap-1 pt-1">
                {commit.artifactTypes.map((type) => (
                  <span key={type} title={type}>
                    {ARTIFACT_TYPE_ICONS[type] || "📄"}
                  </span>
                ))}
                <span className="text-xs text-muted-foreground">
                  {commit.artifactCount} artifact{commit.artifactCount !== 1 ? "s" : ""}
                </span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// =============================================================================
// SELECTED COMMIT INFO
// =============================================================================

interface SelectedCommitInfoProps {
  commit: CommitInfo;
  onViewSnapshot: () => void;
  onCompare: () => void;
  onReplay: () => void;
}

function SelectedCommitInfo({
  commit,
  onViewSnapshot,
  onCompare,
  onReplay,
}: SelectedCommitInfoProps) {
  return (
    <div className="space-y-3 pt-4 border-t">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-sm font-mono font-bold">{commit.shortHash}</code>
            {commit.tags?.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
            {commit.branch && (
              <Badge variant="outline" className="text-xs">
                {commit.branch}
              </Badge>
            )}
          </div>
          <p className="text-sm font-medium truncate">{commit.message}</p>
          <p className="text-xs text-muted-foreground">
            {commit.author} • {formatRelativeTime(commit.timestamp)}
          </p>
        </div>
      </div>

      {commit.artifactCount > 0 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Artifacts:</span>
          <div className="flex items-center gap-1">
            {commit.artifactTypes.map((type) => (
              <Badge key={type} variant="outline" className="text-xs gap-1">
                {ARTIFACT_TYPE_ICONS[type]} {type}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={onViewSnapshot}>
          ◉ View Snapshot
        </Button>
        <Button size="sm" variant="outline" onClick={onCompare}>
          ⊕ Compare With...
        </Button>
        {commit.artifactTypes.includes("decision") && (
          <Button size="sm" variant="outline" onClick={onReplay}>
            ↻ Replay Decisions
          </Button>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const CommitTimeline = React.forwardRef<HTMLDivElement, CommitTimelineProps>(
  (
    {
      commits,
      selectedCommit,
      compareCommit,
      onSelect,
      onCompareSelect,
      onViewSnapshot,
      onReplayDecisions,
      className,
    },
    ref
  ) => {
    const selectedInfo = commits.find((c) => c.hash === selectedCommit);

    const handleContextMenu = (commit: CommitInfo) => (e: React.MouseEvent) => {
      e.preventDefault();
      if (commit.hash !== selectedCommit) {
        onCompareSelect(commit.hash);
      }
    };

    return (
      <Card ref={ref} className={cn("", className)}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              🕐 Commit Timeline
            </span>
            <span className="text-xs text-muted-foreground font-normal">
              {commits.length} commits • Right-click to compare
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Timeline visualization */}
          <ScrollArea className="w-full">
            <div className="flex items-center gap-1 py-2 px-1 min-w-max">
              <span className="text-muted-foreground text-sm">◀</span>
              <div className="flex items-center">
                {commits.map((commit, index) => (
                  <React.Fragment key={commit.hash}>
                    <CommitNode
                      commit={commit}
                      isSelected={commit.hash === selectedCommit}
                      isCompare={commit.hash === compareCommit}
                      onClick={() => onSelect(commit.hash)}
                      onRightClick={handleContextMenu(commit)}
                    />
                    {index < commits.length - 1 && (
                      <div className="w-3 h-0.5 bg-border" />
                    )}
                  </React.Fragment>
                ))}
              </div>
              <span className="text-muted-foreground text-sm">▶</span>
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>

          {/* Selected commit details */}
          {selectedInfo && (
            <SelectedCommitInfo
              commit={selectedInfo}
              onViewSnapshot={() => onViewSnapshot(selectedInfo.hash)}
              onCompare={() => {
                /* Would open compare selector */
              }}
              onReplay={() => onReplayDecisions(selectedInfo.hash)}
            />
          )}

          {/* Compare indicator */}
          {compareCommit && selectedCommit && compareCommit !== selectedCommit && (
            <div className="flex items-center gap-2 p-2 rounded bg-secondary/50 text-sm">
              <span>Comparing:</span>
              <code className="font-mono">{selectedCommit.slice(0, 7)}</code>
              <span>↔</span>
              <code className="font-mono">{compareCommit.slice(0, 7)}</code>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2"
                onClick={() => onCompareSelect("")}
              >
                Clear
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }
);

CommitTimeline.displayName = "CommitTimeline";

// =============================================================================
// DEMO DATA
// =============================================================================

export const DEMO_COMMITS: CommitInfo[] = [
  {
    hash: "a7f3e2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4",
    shortHash: "a7f3e2b",
    message: "Fix valve calibration for TK-103",
    author: "Nick Flach",
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    artifactCount: 4,
    artifactTypes: ["trace", "proof", "decision"],
    status: "success",
    tags: ["v2.5.1"],
    branch: "main",
  },
  {
    hash: "b2c4d1f0e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4",
    shortHash: "b2c4d1f",
    message: "Add safety envelope for high-pressure scenario",
    author: "Nick Flach",
    timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    artifactCount: 2,
    artifactTypes: ["twin", "proof"],
    status: "normal",
  },
  {
    hash: "c9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0",
    shortHash: "c9e8f7a",
    message: "Agent decision: close V-103 inlet",
    author: "Claude Agent",
    timestamp: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    artifactCount: 3,
    artifactTypes: ["decision", "trace"],
    status: "warning",
  },
  {
    hash: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9",
    shortHash: "d0e1f2a",
    message: "PLC-003 fault detected",
    author: "System",
    timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    artifactCount: 1,
    artifactTypes: ["trace"],
    status: "error",
  },
  {
    hash: "e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
    shortHash: "e1f2a3b",
    message: "Initial twin checkpoint",
    author: "Nick Flach",
    timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    artifactCount: 1,
    artifactTypes: ["twin"],
    status: "normal",
    tags: ["v2.5.0"],
  },
];

export { CommitTimeline };
export default CommitTimeline;
