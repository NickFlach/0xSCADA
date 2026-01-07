/**
 * Proposals Panel Component
 * 
 * Phase 4: Visualization + Operator UX
 * 
 * Features:
 * - View pending agent proposals
 * - Approve/reject with signature
 * - Risk level indicators
 * - Approval chain visualization
 */

import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { 
  Bot, 
  CheckCircle, 
  XCircle, 
  AlertTriangle,
  Clock,
  Shield,
  FileText,
  ChevronDown,
  ChevronUp,
  User,
} from "lucide-react";

// =============================================================================
// TYPES
// =============================================================================

export interface ProposalApproval {
  userId: string;
  userName: string;
  decision: "APPROVE" | "REJECT";
  comment?: string;
  signature: string;
  decidedAt: string;
}

export interface Proposal {
  id: string;
  agentId: string;
  agentName?: string;
  proposalType: string;
  title: string;
  description: string;
  action: Record<string, unknown>;
  reasoning: string;
  confidence: number;
  supportingEventIds?: string[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskFactors?: string[];
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "EXPIRED";
  requiredApprovals: number;
  approvals: ProposalApproval[];
  expiresAt?: string;
  createdAt: string;
}

export interface ProposalsPanelProps {
  proposals: Proposal[];
  currentUserId: string;
  currentUserName: string;
  onApprove: (proposalId: string, comment: string, signature: string) => Promise<void>;
  onReject: (proposalId: string, comment: string, signature: string) => Promise<void>;
  onViewDetails?: (proposal: Proposal) => void;
}

// =============================================================================
// RISK LEVEL BADGE
// =============================================================================

function RiskLevelBadge({ level }: { level: string }) {
  const variants: Record<string, string> = {
    LOW: "bg-green-500/20 text-green-500 border-green-500/50",
    MEDIUM: "bg-yellow-500/20 text-yellow-500 border-yellow-500/50",
    HIGH: "bg-orange-500/20 text-orange-500 border-orange-500/50",
    CRITICAL: "bg-red-500/20 text-red-500 border-red-500/50",
  };

  const icons: Record<string, React.ReactNode> = {
    LOW: <Shield className="w-3 h-3" />,
    MEDIUM: <AlertTriangle className="w-3 h-3" />,
    HIGH: <AlertTriangle className="w-3 h-3" />,
    CRITICAL: <XCircle className="w-3 h-3" />,
  };

  return (
    <Badge className={`flex items-center gap-1 ${variants[level] || ""}`}>
      {icons[level]}
      {level}
    </Badge>
  );
}

// =============================================================================
// STATUS BADGE
// =============================================================================

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    DRAFT: "bg-gray-500/20 text-gray-500",
    PENDING_APPROVAL: "bg-blue-500/20 text-blue-500",
    APPROVED: "bg-green-500/20 text-green-500",
    REJECTED: "bg-red-500/20 text-red-500",
    EXPIRED: "bg-gray-500/20 text-gray-400",
  };

  const labels: Record<string, string> = {
    DRAFT: "Draft",
    PENDING_APPROVAL: "Pending",
    APPROVED: "Approved",
    REJECTED: "Rejected",
    EXPIRED: "Expired",
  };

  return (
    <Badge className={variants[status] || ""}>
      {labels[status] || status}
    </Badge>
  );
}

// =============================================================================
// APPROVAL CHAIN
// =============================================================================

function ApprovalChain({ 
  approvals, 
  required 
}: { 
  approvals: ProposalApproval[]; 
  required: number;
}) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: required }).map((_, i) => {
        const approval = approvals[i];
        return (
          <div
            key={i}
            className={`
              w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold
              ${approval 
                ? approval.decision === "APPROVE" 
                  ? "bg-green-500/20 text-green-500 border border-green-500/50" 
                  : "bg-red-500/20 text-red-500 border border-red-500/50"
                : "bg-muted border border-muted-foreground/30 text-muted-foreground"
              }
            `}
            title={approval ? `${approval.userName}: ${approval.decision}` : `Approval ${i + 1} pending`}
          >
            {approval ? (
              approval.decision === "APPROVE" ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />
            ) : (
              i + 1
            )}
          </div>
        );
      })}
    </div>
  );
}

// =============================================================================
// PROPOSAL CARD
// =============================================================================

function ProposalCard({
  proposal,
  currentUserId,
  currentUserName,
  onApprove,
  onReject,
  onViewDetails,
}: {
  proposal: Proposal;
  currentUserId: string;
  currentUserName: string;
  onApprove: (proposalId: string, comment: string, signature: string) => Promise<void>;
  onReject: (proposalId: string, comment: string, signature: string) => Promise<void>;
  onViewDetails?: (proposal: Proposal) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [showRejectDialog, setShowRejectDialog] = useState(false);

  const isPending = proposal.status === "PENDING_APPROVAL";
  const hasUserApproved = proposal.approvals.some(a => a.userId === currentUserId);
  const canApprove = isPending && !hasUserApproved;

  const handleApprove = async () => {
    setIsSubmitting(true);
    try {
      const signature = `sig_${currentUserId}_${Date.now()}`;
      await onApprove(proposal.id, comment, signature);
      setShowApproveDialog(false);
      setComment("");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    setIsSubmitting(true);
    try {
      const signature = `sig_${currentUserId}_${Date.now()}`;
      await onReject(proposal.id, comment, signature);
      setShowRejectDialog(false);
      setComment("");
    } finally {
      setIsSubmitting(false);
    }
  };

  const timeRemaining = proposal.expiresAt 
    ? Math.max(0, new Date(proposal.expiresAt).getTime() - Date.now())
    : null;

  return (
    <Card className={`border-primary/30 ${proposal.riskLevel === "CRITICAL" ? "border-red-500/50" : ""}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" />
            <div>
              <CardTitle className="text-base">{proposal.title}</CardTitle>
              <CardDescription className="text-xs">
                {proposal.agentName || proposal.agentId} • {proposal.proposalType}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <RiskLevelBadge level={proposal.riskLevel} />
            <StatusBadge status={proposal.status} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{proposal.description}</p>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <FileText className="w-3 h-3" />
              Confidence: {proposal.confidence}%
            </span>
            {timeRemaining !== null && timeRemaining > 0 && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Expires in {Math.floor(timeRemaining / 3600000)}h
              </span>
            )}
          </div>
          <ApprovalChain approvals={proposal.approvals} required={proposal.requiredApprovals} />
        </div>

        {expanded && (
          <div className="space-y-3 pt-3 border-t border-muted">
            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">Reasoning</h4>
              <p className="text-sm">{proposal.reasoning}</p>
            </div>

            {proposal.riskFactors && proposal.riskFactors.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">Risk Factors</h4>
                <ul className="text-sm list-disc list-inside">
                  {proposal.riskFactors.map((factor, i) => (
                    <li key={i}>{factor}</li>
                  ))}
                </ul>
              </div>
            )}

            {proposal.approvals.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">Approvals</h4>
                <div className="space-y-1">
                  {proposal.approvals.map((approval, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <User className="w-3 h-3" />
                      <span className="font-medium">{approval.userName}</span>
                      <Badge className={approval.decision === "APPROVE" ? "bg-green-500/20 text-green-500" : "bg-red-500/20 text-red-500"}>
                        {approval.decision}
                      </Badge>
                      {approval.comment && <span className="text-muted-foreground">"{approval.comment}"</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">Action</h4>
              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
                {JSON.stringify(proposal.action, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="flex justify-between pt-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp className="w-4 h-4 mr-1" /> : <ChevronDown className="w-4 h-4 mr-1" />}
          {expanded ? "Less" : "More"}
        </Button>

        {canApprove && (
          <div className="flex gap-2">
            <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-red-500 border-red-500/50">
                  <XCircle className="w-4 h-4 mr-1" />
                  Reject
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Reject Proposal</DialogTitle>
                  <DialogDescription>
                    Provide a reason for rejecting this proposal. This action cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <Textarea
                  placeholder="Reason for rejection..."
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowRejectDialog(false)}>Cancel</Button>
                  <Button variant="destructive" onClick={handleReject} disabled={isSubmitting}>
                    {isSubmitting ? "Rejecting..." : "Reject"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-green-600 hover:bg-green-700">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Approve
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Approve Proposal</DialogTitle>
                  <DialogDescription>
                    Add an optional comment and sign this approval.
                  </DialogDescription>
                </DialogHeader>
                <Textarea
                  placeholder="Optional comment..."
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowApproveDialog(false)}>Cancel</Button>
                  <Button onClick={handleApprove} disabled={isSubmitting} className="bg-green-600 hover:bg-green-700">
                    {isSubmitting ? "Approving..." : "Sign & Approve"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </CardFooter>
    </Card>
  );
}

// =============================================================================
// PROPOSALS PANEL
// =============================================================================

export function ProposalsPanel({
  proposals,
  currentUserId,
  currentUserName,
  onApprove,
  onReject,
  onViewDetails,
}: ProposalsPanelProps) {
  const pendingProposals = proposals.filter(p => p.status === "PENDING_APPROVAL");
  const otherProposals = proposals.filter(p => p.status !== "PENDING_APPROVAL");

  return (
    <div className="space-y-6">
      {pendingProposals.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Pending Approval
            <Badge variant="outline">{pendingProposals.length}</Badge>
          </h2>
          <div className="space-y-4">
            {pendingProposals.map(proposal => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                currentUserId={currentUserId}
                currentUserName={currentUserName}
                onApprove={onApprove}
                onReject={onReject}
                onViewDetails={onViewDetails}
              />
            ))}
          </div>
        </div>
      )}

      {otherProposals.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <FileText className="w-5 h-5 text-muted-foreground" />
            History
          </h2>
          <div className="space-y-4">
            {otherProposals.slice(0, 5).map(proposal => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                currentUserId={currentUserId}
                currentUserName={currentUserName}
                onApprove={onApprove}
                onReject={onReject}
                onViewDetails={onViewDetails}
              />
            ))}
          </div>
        </div>
      )}

      {proposals.length === 0 && (
        <Card className="border-primary/30">
          <CardContent className="py-8 text-center text-muted-foreground">
            <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No proposals yet</p>
            <p className="text-xs">Agent proposals will appear here for review</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default ProposalsPanel;
