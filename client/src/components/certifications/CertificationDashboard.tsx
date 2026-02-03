/**
 * Certification Dashboard Component
 * 
 * VERITY Architecture - Phase δ.2: Certification Workflow
 * 
 * Main dashboard for managing operational certifications.
 * Combines request creation, listing, approval, and verification.
 */

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

import { CertificationRequestForm } from "./CertificationRequestForm";
import { CertificationRequestList } from "./CertificationRequestList";
import { CertificationApprovalPanel } from "./CertificationApprovalPanel";
import { CertificationVerifier } from "./CertificationVerifier";
import {
  CERTIFICATION_TYPE_INFO,
  type CertificationType,
  type CertificationRequestStatus,
  type CertificationRequest,
  type CertificationApproval,
  type MintedCertification,
  type VerificationResult,
  type CertificationStats,
} from "./types";

// =============================================================================
// TYPES
// =============================================================================

export interface CertificationDashboardProps {
  /** Current site ID */
  siteId: string;
  /** Available sites */
  sites?: Array<{ id: string; name: string }>;
  /** Available assets */
  assets?: Array<{ id: string; name: string }>;
  /** Current user ID */
  userId: string;
  /** Current user's role */
  userRole?: string;
  /** API callbacks */
  api: {
    createRequest: (data: Partial<CertificationRequest>) => Promise<CertificationRequest>;
    listRequests: (filters?: {
      siteId?: string;
      status?: CertificationRequestStatus;
      certType?: CertificationType;
    }) => Promise<CertificationRequest[]>;
    getRequest: (id: string) => Promise<CertificationRequest>;
    submitForApproval: (id: string) => Promise<CertificationRequest>;
    getApprovals: (requestId: string) => Promise<CertificationApproval[]>;
    approve: (requestId: string, data: {
      approverId: string;
      approverRole?: string;
      status: "APPROVED" | "REJECTED";
      comment?: string;
    }) => Promise<void>;
    getPendingApprovals: (approverId: string) => Promise<CertificationRequest[]>;
    verifyByTokenId: (tokenId: string) => Promise<VerificationResult>;
    verifyByArtifactHash: (hash: string) => Promise<VerificationResult>;
    getStats: (siteId?: string) => Promise<CertificationStats>;
    listExpiring: (days?: number) => Promise<MintedCertification[]>;
  };
  /** Additional class name */
  className?: string;
}

// =============================================================================
// STATS CARD COMPONENT
// =============================================================================

function StatsCard({ stats, expiring }: { stats: CertificationStats | null; expiring: MintedCertification[] }) {
  if (!stats) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Total Requests</CardDescription>
          <CardTitle className="text-2xl">{stats.total}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Active Certifications</CardDescription>
          <CardTitle className="text-2xl text-green-600">{stats.activeCount}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Expiring Soon (30d)</CardDescription>
          <CardTitle className="text-2xl text-orange-500">{stats.expiringSoonCount}</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Pending Approval</CardDescription>
          <CardTitle className="text-2xl text-yellow-600">
            {stats.byStatus.PENDING_APPROVAL || 0}
          </CardTitle>
        </CardHeader>
      </Card>

      {expiring.length > 0 && (
        <Card className="col-span-full">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              ⚠️ Certifications Expiring Soon
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {expiring.slice(0, 5).map((cert) => (
                <Badge key={cert.id} variant="outline" className="bg-orange-50">
                  {CERTIFICATION_TYPE_INFO[cert.certType].icon} {cert.tokenId} - 
                  Expires {new Date(cert.validUntil!).toLocaleDateString()}
                </Badge>
              ))}
              {expiring.length > 5 && (
                <Badge variant="outline">+{expiring.length - 5} more</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function CertificationDashboard({
  siteId,
  sites,
  assets,
  userId,
  userRole,
  api,
  className,
}: CertificationDashboardProps) {
  // State
  const [activeTab, setActiveTab] = React.useState("requests");
  const [requests, setRequests] = React.useState<CertificationRequest[]>([]);
  const [pendingApprovals, setPendingApprovals] = React.useState<CertificationRequest[]>([]);
  const [selectedRequest, setSelectedRequest] = React.useState<CertificationRequest | null>(null);
  const [selectedApprovals, setSelectedApprovals] = React.useState<CertificationApproval[]>([]);
  const [stats, setStats] = React.useState<CertificationStats | null>(null);
  const [expiring, setExpiring] = React.useState<MintedCertification[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = React.useState(false);

  // Load data
  const loadData = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [requestsData, pendingData, statsData, expiringData] = await Promise.all([
        api.listRequests({ siteId }),
        api.getPendingApprovals(userId),
        api.getStats(siteId),
        api.listExpiring(30),
      ]);
      setRequests(requestsData);
      setPendingApprovals(pendingData);
      setStats(statsData);
      setExpiring(expiringData);
    } catch (err: any) {
      setError(err.message || "Failed to load data");
    } finally {
      setIsLoading(false);
    }
  }, [api, siteId, userId]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  // Load approvals when request is selected
  React.useEffect(() => {
    if (selectedRequest) {
      api.getApprovals(selectedRequest.id).then(setSelectedApprovals).catch(console.error);
    } else {
      setSelectedApprovals([]);
    }
  }, [selectedRequest, api]);

  // Handlers
  const handleCreateRequest = async (data: Partial<CertificationRequest>) => {
    const request = await api.createRequest({ ...data, siteId });
    setShowCreateForm(false);
    await loadData();
    return request;
  };

  const handleSubmitForApproval = async (requestId: string) => {
    await api.submitForApproval(requestId);
    await loadData();
  };

  const handleSelectRequest = (request: CertificationRequest) => {
    setSelectedRequest(request);
    setActiveTab("details");
  };

  const handleApprove = async (comment?: string) => {
    if (!selectedRequest) return;
    await api.approve(selectedRequest.id, {
      approverId: userId,
      approverRole: userRole,
      status: "APPROVED",
      comment,
    });
    await loadData();
    setSelectedRequest(await api.getRequest(selectedRequest.id));
  };

  const handleReject = async (comment: string) => {
    if (!selectedRequest) return;
    await api.approve(selectedRequest.id, {
      approverId: userId,
      approverRole: userRole,
      status: "REJECTED",
      comment,
    });
    await loadData();
    setSelectedRequest(await api.getRequest(selectedRequest.id));
  };

  return (
    <div className={cn("w-full space-y-6", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">📜 Certification Management</h1>
          <p className="text-muted-foreground">
            Manage operational certifications for your industrial assets
          </p>
        </div>
        <Button onClick={() => setShowCreateForm(true)}>
          + New Certification
        </Button>
      </div>

      {/* Stats */}
      <StatsCard stats={stats} expiring={expiring} />

      {/* Error */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Main Content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="requests">
            All Requests ({requests.length})
          </TabsTrigger>
          <TabsTrigger value="pending">
            Pending Approval
            {pendingApprovals.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {pendingApprovals.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="details" disabled={!selectedRequest}>
            Request Details
          </TabsTrigger>
          <TabsTrigger value="verify">Verify</TabsTrigger>
        </TabsList>

        <TabsContent value="requests">
          <CertificationRequestList
            requests={requests}
            isLoading={isLoading}
            onSelect={handleSelectRequest}
            onSubmitForApproval={handleSubmitForApproval}
            onViewDetails={(id) => {
              const req = requests.find((r) => r.id === id);
              if (req) handleSelectRequest(req);
            }}
          />
        </TabsContent>

        <TabsContent value="pending">
          {pendingApprovals.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground">
                  No certification requests pending your approval
                </p>
              </CardContent>
            </Card>
          ) : (
            <CertificationRequestList
              requests={pendingApprovals}
              onSelect={handleSelectRequest}
            />
          )}
        </TabsContent>

        <TabsContent value="details">
          {selectedRequest ? (
            <CertificationApprovalPanel
              request={selectedRequest}
              approvals={selectedApprovals}
              userId={userId}
              userRole={userRole}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ) : (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground">
                  Select a request to view details
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="verify">
          <CertificationVerifier
            onVerifyByTokenId={api.verifyByTokenId}
            onVerifyByArtifactHash={api.verifyByArtifactHash}
          />
        </TabsContent>
      </Tabs>

      {/* Create Form Modal/Sheet */}
      {showCreateForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <CertificationRequestForm
              siteId={siteId}
              sites={sites}
              assets={assets}
              userId={userId}
              onSubmit={handleCreateRequest}
              onCancel={() => setShowCreateForm(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
