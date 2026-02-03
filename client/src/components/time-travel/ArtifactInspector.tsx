/**
 * Artifact Inspector Component
 *
 * β.1.3 - Time-travel debugger UI
 *
 * Browse and examine individual artifacts at a commit.
 * See: docs/wireframes/TIME_TRAVEL_DEBUGGER.md
 */

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type {
  ArtifactInspectorProps,
  RealityArtifact,
  ArtifactType,
  ContentHash,
  VerifyResult,
} from "./types";

// =============================================================================
// CONSTANTS
// =============================================================================

const ARTIFACT_ICONS: Record<ArtifactType, string> = {
  trace: "📊",
  proof: "🔐",
  twin: "🏭",
  decision: "🤖",
  embedding: "🧠",
};

const ARTIFACT_COLORS: Record<ArtifactType, string> = {
  trace: "bg-blue-500/10 border-blue-500/30",
  proof: "bg-purple-500/10 border-purple-500/30",
  twin: "bg-green-500/10 border-green-500/30",
  decision: "bg-orange-500/10 border-orange-500/30",
  embedding: "bg-pink-500/10 border-pink-500/30",
};

const ORIGIN_LABELS: Record<string, string> = {
  linux: "🐧 Linux Fork",
  ethereum: "⛓️ Ethereum Fork",
  "agentic-qe": "🤖 Agentic-QE Fork",
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function groupArtifactsByType(artifacts: RealityArtifact[]): Map<ArtifactType, RealityArtifact[]> {
  const grouped = new Map<ArtifactType, RealityArtifact[]>();
  for (const artifact of artifacts) {
    const existing = grouped.get(artifact.type) || [];
    existing.push(artifact);
    grouped.set(artifact.type, existing);
  }
  return grouped;
}

// =============================================================================
// HELPER COMPONENTS
// =============================================================================

interface ArtifactTreeItemProps {
  artifact: RealityArtifact;
  isSelected: boolean;
  onClick: () => void;
}

function ArtifactTreeItem({ artifact, isSelected, onClick }: ArtifactTreeItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-2 py-1.5 rounded text-sm transition-colors",
        "hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring",
        isSelected && "bg-accent"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">📄</span>
        <span className="truncate font-mono text-xs">{artifact.name}</span>
      </div>
    </button>
  );
}

interface ArtifactFolderProps {
  type: ArtifactType;
  artifacts: RealityArtifact[];
  selectedId?: ContentHash;
  onSelect: (id: ContentHash) => void;
}

function ArtifactFolder({ type, artifacts, selectedId, onSelect }: ArtifactFolderProps) {
  const [isOpen, setIsOpen] = React.useState(true);

  return (
    <div className="space-y-1">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full text-left px-2 py-1 rounded text-sm font-medium hover:bg-accent transition-colors flex items-center gap-2"
      >
        <span className="text-muted-foreground">{isOpen ? "📂" : "📁"}</span>
        <span>{type}/</span>
        <Badge variant="secondary" className="text-xs ml-auto">
          {artifacts.length}
        </Badge>
      </button>
      {isOpen && (
        <div className="pl-4 space-y-0.5">
          {artifacts.map((artifact) => (
            <ArtifactTreeItem
              key={artifact.id}
              artifact={artifact}
              isSelected={artifact.id === selectedId}
              onClick={() => onSelect(artifact.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ArtifactDetailsProps {
  artifact: RealityArtifact;
  onViewRaw: () => void;
  onVerify: () => void;
  onCopyCitation: () => void;
  verifyResult?: VerifyResult;
  isVerifying?: boolean;
}

function ArtifactDetails({
  artifact,
  onViewRaw,
  onVerify,
  onCopyCitation,
  verifyResult,
  isVerifying,
}: ArtifactDetailsProps) {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{ARTIFACT_ICONS[artifact.type]}</span>
          <div>
            <h3 className="font-mono text-sm font-bold">{artifact.name}</h3>
            <p className="text-xs text-muted-foreground capitalize">{artifact.type}</p>
          </div>
        </div>
      </div>

      <Separator />

      {/* Metadata */}
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-[100px_1fr] gap-2">
          <span className="text-muted-foreground">Type:</span>
          <Badge
            variant="outline"
            className={cn("w-fit capitalize", ARTIFACT_COLORS[artifact.type])}
          >
            {artifact.type}
          </Badge>
        </div>

        <div className="grid grid-cols-[100px_1fr] gap-2">
          <span className="text-muted-foreground">Size:</span>
          <span>{formatFileSize(artifact.size)}</span>
        </div>

        <div className="grid grid-cols-[100px_1fr] gap-2">
          <span className="text-muted-foreground">Hash:</span>
          <code className="text-xs font-mono break-all">{artifact.id}</code>
        </div>

        <div className="grid grid-cols-[100px_1fr] gap-2">
          <span className="text-muted-foreground">Captured:</span>
          <span>{new Date(artifact.timestamp).toLocaleString()}</span>
        </div>

        <div className="grid grid-cols-[100px_1fr] gap-2">
          <span className="text-muted-foreground">Origin:</span>
          <span>{ORIGIN_LABELS[artifact.origin.system] || artifact.origin.system}</span>
        </div>

        {artifact.origin.device && (
          <div className="grid grid-cols-[100px_1fr] gap-2">
            <span className="text-muted-foreground">Device:</span>
            <span className="font-mono text-xs">{artifact.origin.device}</span>
          </div>
        )}

        {artifact.origin.agent && (
          <div className="grid grid-cols-[100px_1fr] gap-2">
            <span className="text-muted-foreground">Agent:</span>
            <span className="font-mono text-xs">{artifact.origin.agent}</span>
          </div>
        )}
      </div>

      {/* Dependencies */}
      {artifact.dependencies.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Dependencies</h4>
            <div className="space-y-1">
              {artifact.dependencies.map((dep, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-xs font-mono p-1.5 rounded bg-muted"
                >
                  <span className="text-muted-foreground">•</span>
                  <span className="truncate">{dep}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Signature */}
      <Separator />
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Signature</h4>
        {artifact.signature ? (
          <div className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                "w-2 h-2 rounded-full",
                artifact.signature.valid ? "bg-green-500" : "bg-red-500"
              )}
            />
            <span>
              {artifact.signature.valid ? "✓ Valid" : "✗ Invalid"} ({artifact.signature.signer})
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No signature</p>
        )}

        {verifyResult && (
          <div
            className={cn(
              "p-2 rounded border text-sm",
              verifyResult.valid ? "bg-green-500/10 border-green-500" : "bg-red-500/10 border-red-500"
            )}
          >
            {verifyResult.valid ? "✓ Integrity verified" : "✗ Verification failed"}
            {verifyResult.errors?.map((err, i) => (
              <p key={i} className="text-xs text-muted-foreground mt-1">
                {err}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Summary */}
      {artifact.summary && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Summary</h4>
            <p className="text-sm text-muted-foreground">{artifact.summary}</p>
          </div>
        </>
      )}

      {/* Actions */}
      <Separator />
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={onViewRaw}>
          👁 View Raw
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onVerify}
          disabled={isVerifying}
        >
          {isVerifying ? "⏳ Verifying..." : "✓ Verify Integrity"}
        </Button>
        <Button size="sm" variant="outline" onClick={onCopyCitation}>
          📋 Copy Citation
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const ArtifactInspector = React.forwardRef<HTMLDivElement, ArtifactInspectorProps>(
  (
    {
      commit,
      artifacts,
      selectedArtifact,
      onSelect,
      onViewRaw,
      onVerify,
      onCopyCitation,
      className,
    },
    ref
  ) => {
    const [verifyResult, setVerifyResult] = React.useState<VerifyResult | undefined>();
    const [isVerifying, setIsVerifying] = React.useState(false);

    const groupedArtifacts = React.useMemo(
      () => groupArtifactsByType(artifacts),
      [artifacts]
    );

    const selectedArtifactData = artifacts.find((a) => a.id === selectedArtifact);

    const totalSize = artifacts.reduce((sum, a) => sum + a.size, 0);

    const handleVerify = async () => {
      if (!selectedArtifact) return;
      setIsVerifying(true);
      try {
        const result = await onVerify(selectedArtifact);
        setVerifyResult(result);
      } finally {
        setIsVerifying(false);
      }
    };

    // Clear verify result when selection changes
    React.useEffect(() => {
      setVerifyResult(undefined);
    }, [selectedArtifact]);

    return (
      <Card ref={ref} className={cn("", className)}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">🔍 Artifact Inspector</span>
            <code className="text-xs font-mono text-muted-foreground">
              {commit.slice(0, 7)}
            </code>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-4">
            {/* Artifact Tree */}
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground px-2">
                📁 ARTIFACT TREE
              </div>
              <ScrollArea className="h-[300px] lg:h-[400px] border rounded p-2">
                <div className="space-y-2">
                  {Array.from(groupedArtifacts.entries()).map(([type, arts]) => (
                    <ArtifactFolder
                      key={type}
                      type={type}
                      artifacts={arts}
                      selectedId={selectedArtifact}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              </ScrollArea>
              <div className="text-xs text-muted-foreground px-2">
                {artifacts.length} artifacts • {formatFileSize(totalSize)}
              </div>
            </div>

            {/* Artifact Details */}
            <div className="border rounded p-4">
              {selectedArtifactData ? (
                <ArtifactDetails
                  artifact={selectedArtifactData}
                  onViewRaw={() => onViewRaw(selectedArtifact!)}
                  onVerify={handleVerify}
                  onCopyCitation={() => onCopyCitation(selectedArtifact!)}
                  verifyResult={verifyResult}
                  isVerifying={isVerifying}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  Select an artifact to view details
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }
);

ArtifactInspector.displayName = "ArtifactInspector";

// =============================================================================
// DEMO DATA
// =============================================================================

export const DEMO_ARTIFACTS: RealityArtifact[] = [
  {
    id: "sha256:a7f3e2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0",
    type: "trace",
    name: "ftrace-pump-001.bin",
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    origin: { system: "linux", device: "pump-controller-01" },
    dependencies: ["sha256:b2c4d1f0e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4"],
    signature: { algorithm: "ed25519", signer: "Nick Flach", signature: "abc123...", timestamp: new Date().toISOString(), valid: true },
    summary: "Kernel ftrace capture showing pump pressure spike event",
    size: 2457600,
    contentPath: ".artifacts/traces/ftrace-pump-001.bin",
  },
  {
    id: "sha256:b2c4d1f0e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0",
    type: "twin",
    name: "twin-snapshot-main.json",
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    origin: { system: "agentic-qe" },
    dependencies: [],
    signature: { algorithm: "ed25519", signer: "System", signature: "def456...", timestamp: new Date().toISOString(), valid: true },
    summary: "Full plant state checkpoint before valve adjustment",
    size: 524288,
    contentPath: ".artifacts/twins/twin-snapshot-main.json",
  },
  {
    id: "sha256:c9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6",
    type: "proof",
    name: "zk-attestation-v103.proof",
    timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    origin: { system: "ethereum" },
    dependencies: ["sha256:a7f3e2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0"],
    signature: { algorithm: "ecdsa", signer: "0x1234...5678", signature: "ghi789...", timestamp: new Date().toISOString(), valid: true },
    summary: "ZK proof attesting to valve state at time of decision",
    size: 32768,
    contentPath: ".artifacts/proofs/zk-attestation-v103.proof",
  },
  {
    id: "sha256:d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
    type: "decision",
    name: "decision-valve-close.json",
    timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    origin: { system: "agentic-qe", agent: "claude-3.5-sonnet" },
    dependencies: [
      "sha256:a7f3e2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0",
      "sha256:b2c4d1f0e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0",
    ],
    signature: { algorithm: "ed25519", signer: "Nick Flach", signature: "jkl012...", timestamp: new Date().toISOString(), valid: true },
    summary: "Agent decision to close V-103 inlet valve due to high tank level",
    size: 8192,
    contentPath: ".artifacts/decisions/decision-valve-close.json",
  },
];

export { ArtifactInspector };
export default ArtifactInspector;
