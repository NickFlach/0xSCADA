/**
 * Decision Replay Component
 *
 * β.1.3 - Time-travel debugger UI
 *
 * Visualize and replay agent decisions with frozen inputs.
 * See: docs/wireframes/TIME_TRAVEL_DEBUGGER.md
 */

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type {
  DecisionReplayProps,
  AgentDecision,
  RealityArtifact,
  ContentHash,
  ReplayResult,
  CheckResult,
} from "./types";

// =============================================================================
// CONSTANTS
// =============================================================================

const ARTIFACT_ICONS: Record<string, string> = {
  trace: "📊",
  proof: "🔐",
  twin: "🏭",
  decision: "🤖",
  embedding: "🧠",
};

// =============================================================================
// HELPER COMPONENTS
// =============================================================================

interface InputArtifactRowProps {
  artifactId: ContentHash;
  artifact?: RealityArtifact;
  onView: () => void;
}

function InputArtifactRow({ artifactId, artifact, onView }: InputArtifactRowProps) {
  const icon = artifact ? ARTIFACT_ICONS[artifact.type] || "📄" : "📄";
  const name = artifact?.name || artifactId.slice(0, 20) + "...";

  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-accent transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <span>{icon}</span>
        <span className="font-mono text-xs truncate">{name}</span>
      </div>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onView}>
        View
      </Button>
    </div>
  );
}

interface CheckResultRowProps {
  check: CheckResult;
}

function CheckResultRow({ check }: CheckResultRowProps) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={check.passed ? "text-green-500" : "text-red-500"}>
        {check.passed ? "✓" : "✗"}
      </span>
      <span className="text-sm">{check.name}</span>
      {check.message && (
        <span className="text-xs text-muted-foreground">({check.message})</span>
      )}
    </div>
  );
}

interface ReasoningPanelProps {
  reasoning: AgentDecision["reasoning"];
}

function ReasoningPanel({ reasoning }: ReasoningPanelProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>Model: <strong className="text-foreground">{reasoning.model}</strong></span>
        <span>Tokens: <strong className="text-foreground">{reasoning.tokens}</strong></span>
        <span>Temp: <strong className="text-foreground">{reasoning.temperature}</strong></span>
      </div>
      <ScrollArea className="h-[200px] border rounded p-3 bg-muted/30">
        <div className="text-sm whitespace-pre-wrap font-mono leading-relaxed">
          {reasoning.chainOfThought}
        </div>
      </ScrollArea>
    </div>
  );
}

interface OutputPanelProps {
  output: AgentDecision["output"];
  verification: AgentDecision["verification"];
}

function OutputPanel({ output, verification }: OutputPanelProps) {
  return (
    <div className="space-y-4">
      {/* Decision */}
      <div className="p-4 rounded-lg border-2 border-primary bg-primary/5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wider">Decision</div>
            <div className="text-xl font-bold font-mono">{output.decision}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground uppercase tracking-wider">Confidence</div>
            <div className="text-2xl font-bold">{output.confidence}%</div>
          </div>
        </div>
        {output.target && (
          <div className="mt-2 text-sm text-muted-foreground">
            Target: <span className="font-mono">{output.target}</span>
          </div>
        )}
      </div>

      {/* Verification */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Verification</h4>
        <div className="space-y-1 border rounded p-3">
          {verification.automatedChecks.map((check, i) => (
            <CheckResultRow key={i} check={check} />
          ))}
          {verification.humanApproved !== undefined && (
            <div className="flex items-center gap-2 py-1">
              <span className={verification.humanApproved ? "text-green-500" : "text-red-500"}>
                {verification.humanApproved ? "✓" : "✗"}
              </span>
              <span className="text-sm">
                Human Approval
                {verification.humanApprover && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({verification.humanApprover})
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Safety Score:</span>
          <Progress value={verification.safetyScore} className="flex-1 h-2" />
          <span className="text-sm font-medium">{verification.safetyScore}/100</span>
        </div>
      </div>
    </div>
  );
}

interface ReplayResultPanelProps {
  result: ReplayResult;
}

function ReplayResultPanel({ result }: ReplayResultPanelProps) {
  return (
    <div
      className={cn(
        "p-4 rounded-lg border-2",
        result.match
          ? "border-green-500 bg-green-500/10"
          : "border-yellow-500 bg-yellow-500/10"
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xl">{result.match ? "✓" : "⚠️"}</span>
        <h4 className="font-medium">
          {result.match ? "Decision Replayed Identically" : "Decision Diverged"}
        </h4>
      </div>
      {result.match ? (
        <p className="text-sm text-muted-foreground">
          The agent reached the same decision when replayed with frozen inputs.
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          <p>
            <strong>Divergence point:</strong> {result.divergencePoint}
          </p>
          <p className="text-muted-foreground">{result.divergenceReason}</p>
          <div className="grid grid-cols-2 gap-4 mt-3">
            <div className="p-2 rounded bg-muted">
              <div className="text-xs text-muted-foreground">Original</div>
              <div className="font-mono">{result.originalDecision.output.decision}</div>
            </div>
            <div className="p-2 rounded bg-muted">
              <div className="text-xs text-muted-foreground">Replayed</div>
              <div className="font-mono">{result.replayedDecision.output.decision}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const DecisionReplay = React.forwardRef<HTMLDivElement, DecisionReplayProps>(
  (
    {
      decision,
      artifacts,
      onViewArtifact,
      onReplay,
      onPrevious,
      onNext,
      onCite,
      replayResult,
      isReplaying = false,
      className,
    },
    ref
  ) => {
    const [showReplayResult, setShowReplayResult] = React.useState(false);

    // Find artifacts by ID
    const getArtifact = (id: ContentHash) => artifacts.find((a) => a.id === id);

    const handleReplay = async () => {
      setShowReplayResult(true);
      await onReplay();
    };

    return (
      <Card ref={ref} className={cn("", className)}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              🔄 Decision Replay
              {isReplaying && (
                <Badge variant="secondary" className="animate-pulse">
                  Replaying...
                </Badge>
              )}
            </span>
            <code className="text-xs font-mono text-muted-foreground">
              {decision.id.slice(0, 12)}
            </code>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Header info */}
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="outline">🤖 {decision.agent}</Badge>
              <span className="text-muted-foreground">
                {new Date(decision.timestamp).toLocaleString()}
              </span>
            </div>
            <code className="text-xs font-mono text-muted-foreground">
              @ {decision.commit.slice(0, 7)}
            </code>
          </div>

          <Separator />

          {/* Three-column layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* INPUTS */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                📥 Inputs
                <Badge variant="secondary" className="text-xs">frozen</Badge>
              </h4>
              <div className="border rounded p-2 space-y-1">
                <div className="text-xs text-muted-foreground px-2 pb-1">Artifacts:</div>
                {decision.inputs.artifacts.map((artifactId) => (
                  <InputArtifactRow
                    key={artifactId}
                    artifactId={artifactId}
                    artifact={getArtifact(artifactId)}
                    onView={() => onViewArtifact(artifactId)}
                  />
                ))}
              </div>
              <div className="border rounded p-3">
                <div className="text-xs text-muted-foreground mb-1">Context:</div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs truncate">
                    {decision.inputs.context.slice(0, 20)}...
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => onViewArtifact(decision.inputs.context)}
                  >
                    View
                  </Button>
                </div>
              </div>
            </div>

            {/* REASONING */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium">🧠 Reasoning</h4>
              <ReasoningPanel reasoning={decision.reasoning} />
            </div>

            {/* OUTPUT */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium">📤 Output</h4>
              <OutputPanel
                output={decision.output}
                verification={decision.verification}
              />
            </div>
          </div>

          {/* Replay result */}
          {showReplayResult && replayResult && (
            <>
              <Separator />
              <ReplayResultPanel result={replayResult} />
            </>
          )}

          <Separator />

          {/* Actions */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              {onPrevious && (
                <Button size="sm" variant="outline" onClick={onPrevious}>
                  ◀ Previous
                </Button>
              )}
              {onNext && (
                <Button size="sm" variant="outline" onClick={onNext}>
                  Next ▶
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleReplay}
                disabled={isReplaying}
              >
                {isReplaying ? "⏳ Replaying..." : "↻ Replay with Current Code"}
              </Button>
              <Button size="sm" variant="outline" onClick={onCite}>
                📋 Cite
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }
);

DecisionReplay.displayName = "DecisionReplay";

// =============================================================================
// DEMO DATA
// =============================================================================

export const DEMO_DECISION: AgentDecision = {
  id: "sha256:d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
  timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  agent: "claude-3.5-sonnet",
  commit: "a7f3e2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4",
  inputs: {
    artifacts: [
      "sha256:a7f3e2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0",
      "sha256:b2c4d1f0e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0",
      "sha256:c9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6",
    ],
    context: "sha256:context123456789abcdef",
    constraints: "sha256:safety-envelope-v2-hash",
  },
  reasoning: {
    chainOfThought: `Given the ftrace data showing pump pressure at 142 PSI and TK-103 level at 98.4% (above HI-HI threshold of 95%), I need to reduce inflow to prevent overflow.

Options considered:
1. Close inlet valve V-103 → Stops inflow immediately
2. Increase outlet pump → May stress downstream systems
3. Alert operator only → Risk of overflow while waiting

Safety envelope check:
- V-103 closure is within operational bounds
- No downstream dependencies that would be affected
- Estimated time to safe level: 12 minutes

Confidence assessment:
- Input data freshness: 2 seconds old ✓
- Twin state matches recent sensor readings ✓
- No conflicting operator commands ✓

Proceeding with option #1: Close V-103 inlet valve.`,
    model: "claude-3.5-sonnet",
    temperature: 0.3,
    tokens: 847,
  },
  output: {
    decision: "CLOSE_VALVE",
    target: "V-103 (Inlet valve for TK-103)",
    action: "valve.close",
    confidence: 94,
  },
  verification: {
    humanApproved: true,
    humanApprover: "Nick Flach",
    humanApprovedAt: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
    automatedChecks: [
      { name: "Safety envelope check", passed: true },
      { name: "Constraint validation", passed: true },
      { name: "Action rate limit", passed: true },
      { name: "Downstream impact assessment", passed: true },
    ],
    safetyScore: 98,
  },
};

export const DEMO_REPLAY_RESULT: ReplayResult = {
  originalDecision: DEMO_DECISION,
  replayedDecision: DEMO_DECISION,
  match: true,
};

export const DEMO_REPLAY_RESULT_DIVERGED: ReplayResult = {
  originalDecision: DEMO_DECISION,
  replayedDecision: {
    ...DEMO_DECISION,
    output: {
      ...DEMO_DECISION.output,
      decision: "ALERT_OPERATOR",
      confidence: 78,
    },
  },
  match: false,
  divergencePoint: "Action selection",
  divergenceReason:
    "Updated safety constraints in current code require operator confirmation for critical valve operations. The replayed agent chose to alert instead of acting autonomously.",
};

export { DecisionReplay };
export default DecisionReplay;
