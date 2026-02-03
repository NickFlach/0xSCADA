/**
 * Certification Approval Panel Component
 * 
 * VERITY Architecture - Phase δ.2: Certification Workflow
 * 
 * Panel for reviewing and approving/rejecting certification requests.
 */

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

import {
  CERTIFICATION_TYPE_INFO,
  STATUS_COLORS,
  type CertificationRequest,
  type CertificationApproval,
} from "./types";

// =============================================================================
// TYPES
// =============================================================================

export interface CertificationApprovalPanelProps {
  /** The certification request to approve */
  request: CertificationRequest;
  /** Existing approvals for this request */
  approvals: CertificationApproval[];
  /** Current user ID */
  userId: string;
  /** Current user's role */
  userRole?: string;
  /** Callback when approved */
  onApprove: (comment?: string) => Promise<void>;
  /** Callback when rejected */
  onReject: (comment: string) => Promise<void>;
  /** Callback to view artifact */
  onViewArtifact?: (hash: string) => void;
  /** Additional class name */
  className?: string;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatDate(dateString: string | undefined): string {
  if (!dateString) return "N/A";
  return new Date(dateString).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getApprovalStatusBadge(status: string) {
  const colors: Record<string, string> = {
    PENDING: "bg-yellow-100 text-yellow-800",
    APPROVED: "bg-green-100 text-green-800",
    REJECTED: "bg-red-100 text-red-800",
  };
  return <Badge className={colors[status] || "bg-gray-100"}>{status}</Badge>;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function CertificationApprovalPanel({
  request,
  approvals,
  userId,
  userRole,
  onApprove,
  onReject,
  onViewArtifact,
  className,
}: CertificationApprovalPanelProps) {
  const [comment, setComment] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const typeInfo = CERTIFICATION_TYPE_INFO[request.certType];
  const hasAlreadyVoted = approvals.some((a) => a.approverId === userId);
  const canVote = request.status === "PENDING_APPROVAL" && !hasAlreadyVoted;

  const handleApprove = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      await onApprove(comment || undefined);
    } catch (err: any) {
      setError(err.message || "Failed to approve");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!comment.trim()) {
      setError("Please provide a reason for rejection");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await onReject(comment);
    } catch (err: any) {
      setError(err.message || "Failed to reject");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <span>{typeInfo.icon}</span>
              <span>{request.title}</span>
            </CardTitle>
            <CardDescription className="mt-1">
              {typeInfo.displayName} • Requested by {request.requestedBy}
            </CardDescription>
          </div>
          <Badge className={STATUS_COLORS[request.status] === "yellow" ? "bg-yellow-100 text-yellow-800" : ""}>
            {request.status.replace(/_/g, " ")}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Request Details */}
        <div className="space-y-4">
          <div>
            <Label className="text-sm text-muted-foreground">Description</Label>
            <p className="mt-1">
              {request.description || <span className="text-muted-foreground italic">No description</span>}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm text-muted-foreground">Valid From</Label>
              <p className="mt-1 font-mono text-sm">{formatDate(request.validFrom)}</p>
            </div>
            <div>
              <Label className="text-sm text-muted-foreground">Valid Until</Label>
              <p className="mt-1 font-mono text-sm">
                {request.validUntil ? formatDate(request.validUntil) : "No expiry"}
              </p>
            </div>
          </div>

          <div>
            <Label className="text-sm text-muted-foreground">Artifact Hash</Label>
            <div className="mt-1 flex items-center gap-2">
              <code className="bg-muted px-2 py-1 rounded text-xs font-mono break-all">
                {request.artifactHash}
              </code>
              {onViewArtifact && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onViewArtifact(request.artifactHash)}
                >
                  View
                </Button>
              )}
            </div>
          </div>

          {request.artifactUri && (
            <div>
              <Label className="text-sm text-muted-foreground">Artifact URI</Label>
              <p className="mt-1 font-mono text-sm break-all">{request.artifactUri}</p>
            </div>
          )}
        </div>

        <Separator />

        {/* Approval Progress */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <Label className="text-sm font-medium">Approval Progress</Label>
            <span className={cn(
              "font-mono text-sm",
              request.currentApprovals >= request.requiredApprovals && "text-green-600 font-bold"
            )}>
              {request.currentApprovals}/{request.requiredApprovals} approvals
            </span>
          </div>

          {approvals.length > 0 ? (
            <div className="space-y-2">
              {approvals.map((approval) => (
                <div
                  key={approval.id}
                  className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                >
                  <div>
                    <div className="font-medium text-sm">
                      {approval.approverId}
                      {approval.approverRole && (
                        <span className="text-muted-foreground ml-2">
                          ({approval.approverRole})
                        </span>
                      )}
                    </div>
                    {approval.comment && (
                      <p className="text-sm text-muted-foreground mt-1">
                        "{approval.comment}"
                      </p>
                    )}
                    {approval.decidedAt && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatDate(approval.decidedAt)}
                      </p>
                    )}
                  </div>
                  {getApprovalStatusBadge(approval.status)}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No approvals yet</p>
          )}
        </div>

        {/* Voting Section */}
        {canVote && (
          <>
            <Separator />
            <div className="space-y-4">
              <Label className="text-sm font-medium">Your Decision</Label>
              
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div>
                <Label htmlFor="comment" className="text-sm text-muted-foreground">
                  Comment (required for rejection)
                </Label>
                <Textarea
                  id="comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Optional comment for approval, required for rejection..."
                  rows={3}
                  className="mt-1"
                />
              </div>
            </div>
          </>
        )}

        {hasAlreadyVoted && (
          <Alert>
            <AlertTitle>Already Voted</AlertTitle>
            <AlertDescription>
              You have already provided your approval decision for this request.
            </AlertDescription>
          </Alert>
        )}

        {request.status !== "PENDING_APPROVAL" && (
          <Alert>
            <AlertTitle>Not Awaiting Approval</AlertTitle>
            <AlertDescription>
              This request is in {request.status.replace(/_/g, " ").toLowerCase()} status
              and cannot be approved at this time.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>

      {canVote && (
        <CardFooter className="flex justify-end gap-2 bg-muted/30">
          <Button
            variant="destructive"
            onClick={handleReject}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Submitting..." : "Reject"}
          </Button>
          <Button
            onClick={handleApprove}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Submitting..." : "Approve"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
