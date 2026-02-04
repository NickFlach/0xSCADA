/**
 * Time-Travel Debugger Container Component
 *
 * β.1.3 - Time-travel debugger UI
 *
 * Main container that orchestrates all time-travel debugging components.
 * See: docs/wireframes/TIME_TRAVEL_DEBUGGER.md
 */

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { CommitTimeline, DEMO_COMMITS } from "./CommitTimeline";
import { RealitySnapshot, DEMO_SNAPSHOT } from "./RealitySnapshot";
import { ArtifactInspector, DEMO_ARTIFACTS } from "./ArtifactInspector";
import { DiffViewer, DEMO_DIFF } from "./DiffViewer";
import { DecisionReplay, DEMO_DECISION, DEMO_REPLAY_RESULT } from "./DecisionReplay";

import type {
  CommitHash,
  ContentHash,
  CommitInfo,
  RealitySnapshotData,
  RealityArtifact,
  RealityDiff,
  AgentDecision,
  ReplayResult,
  VerifyResult,
} from "./types";

// =============================================================================
// TYPES
// =============================================================================

type ViewMode = "snapshot" | "artifacts" | "diff" | "decision";

export interface TimeTravelDebuggerProps {
  /** Available commits to navigate */
  commits?: CommitInfo[];
  /** Callback to load snapshot for a commit */
  onLoadSnapshot?: (commit: CommitHash) => Promise<RealitySnapshotData>;
  /** Callback to load artifacts for a commit */
  onLoadArtifacts?: (commit: CommitHash) => Promise<RealityArtifact[]>;
  /** Callback to diff two commits */
  onDiffCommits?: (a: CommitHash, b: CommitHash) => Promise<RealityDiff>;
  /** Callback to load decisions for a commit */
  onLoadDecisions?: (commit: CommitHash) => Promise<AgentDecision[]>;
  /** Callback to replay a decision */
  onReplayDecision?: (decision: AgentDecision) => Promise<ReplayResult>;
  /** Callback to verify an artifact */
  onVerifyArtifact?: (artifactId: ContentHash) => Promise<VerifyResult>;
  /** Callback to view raw artifact */
  onViewRawArtifact?: (artifactId: ContentHash) => void;
  /** Callback to restore to a snapshot */
  onRestore?: (commit: CommitHash) => void;
  /** Callback to fork from a commit */
  onFork?: (commit: CommitHash) => void;
  /** Additional class name */
  className?: string;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function TimeTravelDebugger({
  commits = DEMO_COMMITS,
  onLoadSnapshot,
  onLoadArtifacts,
  onDiffCommits,
  onLoadDecisions,
  onReplayDecision,
  onVerifyArtifact,
  onViewRawArtifact,
  onRestore,
  onFork,
  className,
}: TimeTravelDebuggerProps) {
  // State
  const [selectedCommit, setSelectedCommit] = React.useState<CommitHash | undefined>(
    commits[0]?.hash
  );
  const [compareCommit, setCompareCommit] = React.useState<CommitHash | undefined>();
  const [viewMode, setViewMode] = React.useState<ViewMode>("snapshot");
  const [selectedArtifact, setSelectedArtifact] = React.useState<ContentHash | undefined>();
  const [currentDecisionIndex, setCurrentDecisionIndex] = React.useState(0);

  // Data states (in real app, these would be fetched)
  const [snapshot, setSnapshot] = React.useState<RealitySnapshotData>(DEMO_SNAPSHOT);
  const [artifacts, setArtifacts] = React.useState<RealityArtifact[]>(DEMO_ARTIFACTS);
  const [diff, setDiff] = React.useState<RealityDiff | undefined>(DEMO_DIFF);
  const [decisions, setDecisions] = React.useState<AgentDecision[]>([DEMO_DECISION]);
  const [replayResult, setReplayResult] = React.useState<ReplayResult | undefined>();
  const [isReplaying, setIsReplaying] = React.useState(false);

  // Handlers
  const handleSelectCommit = async (commit: CommitHash) => {
    setSelectedCommit(commit);
    setReplayResult(undefined);

    // In real implementation, load data from API
    if (onLoadSnapshot) {
      const data = await onLoadSnapshot(commit);
      setSnapshot(data);
    }
    if (onLoadArtifacts) {
      const arts = await onLoadArtifacts(commit);
      setArtifacts(arts);
    }
    if (onLoadDecisions) {
      const decs = await onLoadDecisions(commit);
      setDecisions(decs);
      setCurrentDecisionIndex(0);
    }
  };

  const handleCompareSelect = async (commit: CommitHash) => {
    if (!commit) {
      setCompareCommit(undefined);
      setDiff(undefined);
      return;
    }

    setCompareCommit(commit);
    setViewMode("diff");

    if (selectedCommit && onDiffCommits) {
      const diffResult = await onDiffCommits(selectedCommit, commit);
      setDiff(diffResult);
    }
  };

  const handleViewSnapshot = (commit: CommitHash) => {
    setViewMode("snapshot");
  };

  const handleReplayDecisions = (commit: CommitHash) => {
    setViewMode("decision");
  };

  const handleReplay = async () => {
    if (!decisions[currentDecisionIndex]) return DEMO_REPLAY_RESULT;

    setIsReplaying(true);
    try {
      if (onReplayDecision) {
        const result = await onReplayDecision(decisions[currentDecisionIndex]);
        setReplayResult(result);
        return result;
      }
      // Demo fallback
      await new Promise((r) => setTimeout(r, 1500));
      setReplayResult(DEMO_REPLAY_RESULT);
      return DEMO_REPLAY_RESULT;
    } finally {
      setIsReplaying(false);
    }
  };

  const handleVerifyArtifact = async (artifactId: ContentHash): Promise<VerifyResult> => {
    if (onVerifyArtifact) {
      return onVerifyArtifact(artifactId);
    }
    // Demo fallback
    await new Promise((r) => setTimeout(r, 800));
    return { valid: true, hash: artifactId };
  };

  const handleViewRawArtifact = (artifactId: ContentHash) => {
    if (onViewRawArtifact) {
      onViewRawArtifact(artifactId);
    } else {
      // Demo: just open in new tab or alert
      console.log("View raw artifact:", artifactId);
    }
  };

  const handleCopyCitation = (artifactId: ContentHash) => {
    const artifact = artifacts.find((a) => a.id === artifactId);
    const citation = artifact
      ? `Based on artifact ${artifact.name} (${artifactId.slice(0, 12)})`
      : `Based on artifact ${artifactId.slice(0, 12)}`;
    navigator.clipboard?.writeText(citation);
  };

  const handleSwapDiff = () => {
    if (selectedCommit && compareCommit) {
      const temp = selectedCommit;
      setSelectedCommit(compareCommit);
      setCompareCommit(temp);
    }
  };

  const handlePreviousDecision = () => {
    if (currentDecisionIndex > 0) {
      setCurrentDecisionIndex(currentDecisionIndex - 1);
      setReplayResult(undefined);
    }
  };

  const handleNextDecision = () => {
    if (currentDecisionIndex < decisions.length - 1) {
      setCurrentDecisionIndex(currentDecisionIndex + 1);
      setReplayResult(undefined);
    }
  };

  const currentDecision = decisions[currentDecisionIndex];

  return (
    <div className={cn("space-y-4", className)}>
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">🕐 Time-Travel Debugger</h1>
          <p className="text-sm text-muted-foreground">
            Navigate through history, reconstruct plant states, replay decisions
          </p>
        </div>
      </div>

      {/* Timeline */}
      <CommitTimeline
        commits={commits}
        selectedCommit={selectedCommit}
        compareCommit={compareCommit}
        onSelect={handleSelectCommit}
        onCompareSelect={handleCompareSelect}
        onViewSnapshot={handleViewSnapshot}
        onReplayDecisions={handleReplayDecisions}
      />

      {/* Main content area */}
      {selectedCommit && (
        <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
          <TabsList>
            <TabsTrigger value="snapshot">🌌 Snapshot</TabsTrigger>
            <TabsTrigger value="artifacts">🔍 Artifacts</TabsTrigger>
            <TabsTrigger value="diff" disabled={!compareCommit}>
              ⚖️ Diff {compareCommit && `(${compareCommit.slice(0, 7)})`}
            </TabsTrigger>
            <TabsTrigger value="decision" disabled={decisions.length === 0}>
              🔄 Decisions {decisions.length > 0 && `(${decisions.length})`}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="snapshot" className="mt-4">
            <RealitySnapshot
              commit={selectedCommit}
              snapshot={snapshot}
              onRestore={onRestore ? () => onRestore(selectedCommit) : undefined}
              onCompare={() => setViewMode("diff")}
              onFork={onFork ? () => onFork(selectedCommit) : undefined}
            />
          </TabsContent>

          <TabsContent value="artifacts" className="mt-4">
            <ArtifactInspector
              commit={selectedCommit}
              artifacts={artifacts}
              selectedArtifact={selectedArtifact}
              onSelect={setSelectedArtifact}
              onViewRaw={handleViewRawArtifact}
              onVerify={handleVerifyArtifact}
              onCopyCitation={handleCopyCitation}
            />
          </TabsContent>

          <TabsContent value="diff" className="mt-4">
            {diff && compareCommit && (
              <DiffViewer
                snapshotA={{ commit: selectedCommit, snapshot }}
                snapshotB={{ commit: compareCommit, snapshot: { ...snapshot, commit: compareCommit } }}
                diff={diff}
                onSwap={handleSwapDiff}
                onExport={() => console.log("Export diff report")}
              />
            )}
          </TabsContent>

          <TabsContent value="decision" className="mt-4">
            {currentDecision && (
              <DecisionReplay
                decision={currentDecision}
                artifacts={artifacts}
                onViewArtifact={(id) => {
                  setSelectedArtifact(id);
                  setViewMode("artifacts");
                }}
                onReplay={handleReplay}
                onPrevious={currentDecisionIndex > 0 ? handlePreviousDecision : undefined}
                onNext={currentDecisionIndex < decisions.length - 1 ? handleNextDecision : undefined}
                onCite={() => handleCopyCitation(currentDecision.id)}
                replayResult={replayResult}
                isReplaying={isReplaying}
              />
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

TimeTravelDebugger.displayName = "TimeTravelDebugger";

export default TimeTravelDebugger;
