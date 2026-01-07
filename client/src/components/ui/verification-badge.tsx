/**
 * Verification Badge Component
 * 
 * PRD Section 8.1: Verification status indicators (✔ anchored / ⏳ pending)
 * PRD Section 8.3: Click any event → show hash, Merkle proof, Ethereum tx
 */

import { useState } from "react";
import { CheckCircle, Clock, AlertTriangle, XCircle, ExternalLink, Copy, Check } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// =============================================================================
// TYPES
// =============================================================================

export type AnchorStatus = "PENDING" | "BATCHED" | "ANCHORED" | "FAILED";

export interface VerificationDetails {
  eventHash: string;
  signature: string;
  anchorStatus: AnchorStatus;
  batchId?: string;
  merkleRoot?: string;
  merkleProof?: string[];
  merkleIndex?: number;
  txHash?: string;
  blockNumber?: number;
  anchoredAt?: string;
}

// =============================================================================
// VERIFICATION BADGE
// =============================================================================

interface VerificationBadgeProps {
  status: AnchorStatus;
  details?: VerificationDetails;
  compact?: boolean;
}

export function VerificationBadge({ status, details, compact = false }: VerificationBadgeProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const statusConfig = {
    PENDING: {
      icon: Clock,
      label: "Pending",
      color: "text-yellow-500",
      bgColor: "bg-yellow-500/10",
      borderColor: "border-yellow-500/30",
    },
    BATCHED: {
      icon: Clock,
      label: "Batched",
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
      borderColor: "border-blue-500/30",
    },
    ANCHORED: {
      icon: CheckCircle,
      label: "Anchored",
      color: "text-primary",
      bgColor: "bg-primary/10",
      borderColor: "border-primary/30",
    },
    FAILED: {
      icon: XCircle,
      label: "Failed",
      color: "text-destructive",
      bgColor: "bg-destructive/10",
      borderColor: "border-destructive/30",
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  // Compact badge (just icon + status)
  if (compact || !details) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase font-bold border ${config.bgColor} ${config.color} ${config.borderColor} cursor-help`}
          >
            <Icon className="w-3 h-3" />
            {config.label}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>Anchor Status: {config.label}</p>
          {details?.txHash && (
            <p className="text-xs text-muted-foreground">
              Tx: {details.txHash.slice(0, 10)}...
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  // Full badge with dialog
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase font-bold border ${config.bgColor} ${config.color} ${config.borderColor} hover:opacity-80 transition-opacity cursor-pointer`}
        >
          <Icon className="w-3 h-3" />
          {config.label}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl bg-background border-white/10">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={`w-5 h-5 ${config.color}`} />
            Verification Details
          </DialogTitle>
          <DialogDescription>
            Cryptographic proof of event integrity and blockchain anchoring
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {/* Event Hash */}
          <div className="space-y-1">
            <label className="text-xs font-bold uppercase text-muted-foreground">
              Event Hash (SHA-256)
            </label>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-black/40 p-2 rounded font-mono break-all">
                {details.eventHash}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(details.eventHash, "hash")}
              >
                {copied === "hash" ? (
                  <Check className="w-4 h-4 text-primary" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Signature */}
          <div className="space-y-1">
            <label className="text-xs font-bold uppercase text-muted-foreground">
              Origin Signature
            </label>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-black/40 p-2 rounded font-mono break-all">
                {details.signature}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(details.signature, "sig")}
              >
                {copied === "sig" ? (
                  <Check className="w-4 h-4 text-primary" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Anchor Status */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase text-muted-foreground">
                Anchor Status
              </label>
              <div className={`text-sm font-bold ${config.color}`}>
                {config.label}
              </div>
            </div>
            {details.anchoredAt && (
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase text-muted-foreground">
                  Anchored At
                </label>
                <div className="text-sm">
                  {new Date(details.anchoredAt).toLocaleString()}
                </div>
              </div>
            )}
          </div>

          {/* Merkle Proof (if anchored) */}
          {status === "ANCHORED" && details.merkleRoot && (
            <>
              <div className="border-t border-white/10 pt-4">
                <h4 className="text-sm font-bold uppercase mb-3">
                  Merkle Proof
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs font-bold uppercase text-muted-foreground">
                      Batch ID
                    </label>
                    <code className="text-xs bg-black/40 p-2 rounded font-mono block">
                      {details.batchId}
                    </code>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold uppercase text-muted-foreground">
                      Merkle Index
                    </label>
                    <code className="text-xs bg-black/40 p-2 rounded font-mono block">
                      {details.merkleIndex}
                    </code>
                  </div>
                </div>
                <div className="space-y-1 mt-3">
                  <label className="text-xs font-bold uppercase text-muted-foreground">
                    Merkle Root
                  </label>
                  <code className="text-xs bg-black/40 p-2 rounded font-mono block break-all">
                    {details.merkleRoot}
                  </code>
                </div>
                {details.merkleProof && details.merkleProof.length > 0 && (
                  <div className="space-y-1 mt-3">
                    <label className="text-xs font-bold uppercase text-muted-foreground">
                      Proof Path ({details.merkleProof.length} nodes)
                    </label>
                    <div className="bg-black/40 p-2 rounded max-h-32 overflow-y-auto">
                      {details.merkleProof.map((hash, i) => (
                        <code key={i} className="text-xs font-mono block text-muted-foreground">
                          [{i}] {hash}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Ethereum Transaction (if anchored) */}
          {status === "ANCHORED" && details.txHash && (
            <div className="border-t border-white/10 pt-4">
              <h4 className="text-sm font-bold uppercase mb-3">
                Ethereum L1 Anchor
              </h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase text-muted-foreground">
                    Transaction Hash
                  </label>
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-black/40 p-2 rounded font-mono flex-1 truncate">
                      {details.txHash}
                    </code>
                    <a
                      href={`https://etherscan.io/tx/${details.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary/80"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </div>
                {details.blockNumber && (
                  <div className="space-y-1">
                    <label className="text-xs font-bold uppercase text-muted-foreground">
                      Block Number
                    </label>
                    <code className="text-xs bg-black/40 p-2 rounded font-mono block">
                      {details.blockNumber.toLocaleString()}
                    </code>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Verify Button */}
          {status === "ANCHORED" && (
            <div className="border-t border-white/10 pt-4">
              <Button className="w-full" variant="outline">
                <CheckCircle className="w-4 h-4 mr-2" />
                Verify On-Chain Integrity
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// ANCHOR STATUS INDICATOR (Simpler version)
// =============================================================================

interface AnchorStatusIndicatorProps {
  status: AnchorStatus;
  txHash?: string;
}

export function AnchorStatusIndicator({ status, txHash }: AnchorStatusIndicatorProps) {
  const statusConfig = {
    PENDING: { icon: Clock, color: "text-yellow-500", label: "Pending" },
    BATCHED: { icon: Clock, color: "text-blue-500", label: "Batched" },
    ANCHORED: { icon: CheckCircle, color: "text-primary", label: "Anchored" },
    FAILED: { icon: AlertTriangle, color: "text-destructive", label: "Failed" },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-flex items-center gap-1 ${config.color}`}>
          <Icon className="w-4 h-4" />
          {txHash && (
            <span className="text-xs font-mono">
              {txHash.slice(0, 6)}...
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{config.label}</p>
        {txHash && <p className="text-xs text-muted-foreground">Tx: {txHash}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
