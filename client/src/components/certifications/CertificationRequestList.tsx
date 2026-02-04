/**
 * Certification Request List Component
 * 
 * VERITY Architecture - Phase δ.2: Certification Workflow
 * 
 * Displays a list of certification requests with filtering and status indicators.
 */

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import {
  CERTIFICATION_TYPES,
  CERTIFICATION_REQUEST_STATUSES,
  CERTIFICATION_TYPE_INFO,
  STATUS_COLORS,
  type CertificationType,
  type CertificationRequestStatus,
  type CertificationRequest,
} from "./types";

// =============================================================================
// TYPES
// =============================================================================

export interface CertificationRequestListProps {
  /** List of certification requests */
  requests: CertificationRequest[];
  /** Loading state */
  isLoading?: boolean;
  /** Callback when a request is selected */
  onSelect?: (request: CertificationRequest) => void;
  /** Callback to submit a request for approval */
  onSubmitForApproval?: (requestId: string) => void;
  /** Callback to view request details */
  onViewDetails?: (requestId: string) => void;
  /** Filter change callback */
  onFilterChange?: (filters: {
    certType?: CertificationType;
    status?: CertificationRequestStatus;
  }) => void;
  /** Additional class name */
  className?: string;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatDate(dateString: string | undefined): string {
  if (!dateString) return "N/A";
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getStatusBadge(status: CertificationRequestStatus) {
  const colorMap: Record<string, string> = {
    gray: "bg-gray-100 text-gray-800",
    yellow: "bg-yellow-100 text-yellow-800",
    blue: "bg-blue-100 text-blue-800",
    red: "bg-red-100 text-red-800",
    green: "bg-green-100 text-green-800",
    orange: "bg-orange-100 text-orange-800",
    purple: "bg-purple-100 text-purple-800",
  };

  const color = STATUS_COLORS[status] || "gray";
  return (
    <Badge className={colorMap[color]}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function CertificationRequestList({
  requests,
  isLoading = false,
  onSelect,
  onSubmitForApproval,
  onViewDetails,
  onFilterChange,
  className,
}: CertificationRequestListProps) {
  const [typeFilter, setTypeFilter] = React.useState<string>("all");
  const [statusFilter, setStatusFilter] = React.useState<string>("all");

  const handleTypeFilterChange = (value: string) => {
    setTypeFilter(value);
    onFilterChange?.({
      certType: value === "all" ? undefined : (value as CertificationType),
      status: statusFilter === "all" ? undefined : (statusFilter as CertificationRequestStatus),
    });
  };

  const handleStatusFilterChange = (value: string) => {
    setStatusFilter(value);
    onFilterChange?.({
      certType: typeFilter === "all" ? undefined : (typeFilter as CertificationType),
      status: value === "all" ? undefined : (value as CertificationRequestStatus),
    });
  };

  // Apply local filters if no onFilterChange provided
  const filteredRequests = React.useMemo(() => {
    if (onFilterChange) return requests;
    
    return requests.filter((req) => {
      if (typeFilter !== "all" && req.certType !== typeFilter) return false;
      if (statusFilter !== "all" && req.status !== statusFilter) return false;
      return true;
    });
  }, [requests, typeFilter, statusFilter, onFilterChange]);

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>📋 Certification Requests</CardTitle>
            <CardDescription>
              View and manage certification requests in the workflow
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Select value={typeFilter} onValueChange={handleTypeFilterChange}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {CERTIFICATION_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {CERTIFICATION_TYPE_INFO[type].icon} {CERTIFICATION_TYPE_INFO[type].displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={handleStatusFilterChange}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {CERTIFICATION_REQUEST_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading requests...</div>
          </div>
        ) : filteredRequests.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">No certification requests found</div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Approvals</TableHead>
                <TableHead>Valid Until</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRequests.map((request) => (
                <TableRow
                  key={request.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => onSelect?.(request)}
                >
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span>{CERTIFICATION_TYPE_INFO[request.certType].icon}</span>
                      <span className="text-sm">
                        {CERTIFICATION_TYPE_INFO[request.certType].displayName}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-[300px] truncate font-medium">
                      {request.title}
                    </div>
                    {request.supersedes && (
                      <div className="text-xs text-muted-foreground">
                        Supersedes previous cert
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{getStatusBadge(request.status)}</TableCell>
                  <TableCell>
                    <span className={cn(
                      "font-mono text-sm",
                      request.currentApprovals >= request.requiredApprovals && "text-green-600"
                    )}>
                      {request.currentApprovals}/{request.requiredApprovals}
                    </span>
                  </TableCell>
                  <TableCell>
                    {request.validUntil ? (
                      formatDate(request.validUntil)
                    ) : (
                      <span className="text-muted-foreground">No expiry</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(request.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                      {request.status === "DRAFT" && onSubmitForApproval && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onSubmitForApproval(request.id)}
                        >
                          Submit
                        </Button>
                      )}
                      {onViewDetails && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onViewDetails(request.id)}
                        >
                          View
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
