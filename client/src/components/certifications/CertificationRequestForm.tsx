/**
 * Certification Request Form Component
 * 
 * VERITY Architecture - Phase δ.2: Certification Workflow
 * 
 * Form for creating new certification requests linked to LFS artifacts.
 */

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

import {
  CERTIFICATION_TYPES,
  CERTIFICATION_TYPE_INFO,
  type CertificationType,
  type CertificationRequest,
} from "./types";

// =============================================================================
// TYPES
// =============================================================================

export interface CertificationRequestFormProps {
  /** Site ID for the certification */
  siteId: string;
  /** Site options for selection */
  sites?: Array<{ id: string; name: string }>;
  /** Asset options for selection */
  assets?: Array<{ id: string; name: string }>;
  /** Current user ID (requestedBy) */
  userId: string;
  /** Request to supersede (for renewals) */
  supersedes?: string;
  /** Pre-fill values */
  initialValues?: Partial<{
    certType: CertificationType;
    title: string;
    description: string;
    artifactHash: string;
    artifactUri: string;
    validFrom: string;
    validUntil: string;
    assetId: string;
    requiredApprovals: number;
  }>;
  /** Callback on form submission */
  onSubmit: (request: Partial<CertificationRequest>) => Promise<void>;
  /** Callback on cancel */
  onCancel?: () => void;
  /** Additional class name */
  className?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function CertificationRequestForm({
  siteId,
  sites,
  assets,
  userId,
  supersedes,
  initialValues,
  onSubmit,
  onCancel,
  className,
}: CertificationRequestFormProps) {
  // Form state
  const [certType, setCertType] = React.useState<CertificationType | "">(
    initialValues?.certType || ""
  );
  const [title, setTitle] = React.useState(initialValues?.title || "");
  const [description, setDescription] = React.useState(initialValues?.description || "");
  const [artifactHash, setArtifactHash] = React.useState(initialValues?.artifactHash || "");
  const [artifactUri, setArtifactUri] = React.useState(initialValues?.artifactUri || "");
  const [validFrom, setValidFrom] = React.useState(
    initialValues?.validFrom || new Date().toISOString().slice(0, 16)
  );
  const [validUntil, setValidUntil] = React.useState(initialValues?.validUntil || "");
  const [selectedSiteId, setSelectedSiteId] = React.useState(siteId);
  const [assetId, setAssetId] = React.useState(initialValues?.assetId || "");
  const [requiredApprovals, setRequiredApprovals] = React.useState(
    initialValues?.requiredApprovals || 1
  );
  
  // UI state
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const selectedTypeInfo = certType ? CERTIFICATION_TYPE_INFO[certType] : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!certType) {
      setError("Please select a certification type");
      return;
    }

    if (!title.trim()) {
      setError("Title is required");
      return;
    }

    if (!artifactHash.trim()) {
      setError("Artifact hash is required");
      return;
    }

    if (!/^[a-f0-9]{64}$/i.test(artifactHash)) {
      setError("Artifact hash must be a 64-character hex string (SHA-256)");
      return;
    }

    setIsSubmitting(true);

    try {
      await onSubmit({
        certType,
        title: title.trim(),
        description: description.trim() || undefined,
        artifactHash: artifactHash.toLowerCase(),
        artifactUri: artifactUri.trim() || undefined,
        validFrom: validFrom || undefined,
        validUntil: validUntil || undefined,
        siteId: selectedSiteId,
        assetId: assetId || undefined,
        requiredApprovals,
        supersedes,
        requestedBy: userId,
      } as any);
    } catch (err: any) {
      setError(err.message || "Failed to create certification request");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <CardTitle>
          {supersedes ? "🔄 Renew Certification" : "📜 New Certification Request"}
        </CardTitle>
        <CardDescription>
          Create a certification request linked to an LFS artifact for multi-signature approval.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Certification Type */}
          <div className="space-y-2">
            <Label htmlFor="certType">Certification Type *</Label>
            <Select
              value={certType}
              onValueChange={(value) => setCertType(value as CertificationType)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select certification type" />
              </SelectTrigger>
              <SelectContent>
                {CERTIFICATION_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    <span className="flex items-center gap-2">
                      <span>{CERTIFICATION_TYPE_INFO[type].icon}</span>
                      <span>{CERTIFICATION_TYPE_INFO[type].displayName}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedTypeInfo && (
              <p className="text-sm text-muted-foreground">
                {selectedTypeInfo.description}
              </p>
            )}
          </div>

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">Title *</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Pump P-101 Commissioning Certificate"
              required
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detailed description of the certification..."
              rows={3}
            />
          </div>

          {/* Artifact Hash */}
          <div className="space-y-2">
            <Label htmlFor="artifactHash">Artifact Hash (SHA-256) *</Label>
            <Input
              id="artifactHash"
              value={artifactHash}
              onChange={(e) => setArtifactHash(e.target.value)}
              placeholder="e.g., a7f3e2b1c4d5..."
              className="font-mono text-sm"
              required
            />
            <p className="text-sm text-muted-foreground">
              LFS content hash of the evidence bundle (64 hex characters)
            </p>
          </div>

          {/* Artifact URI */}
          <div className="space-y-2">
            <Label htmlFor="artifactUri">Artifact URI (Optional)</Label>
            <Input
              id="artifactUri"
              value={artifactUri}
              onChange={(e) => setArtifactUri(e.target.value)}
              placeholder="ipfs://... or https://..."
            />
          </div>

          {/* Site Selection */}
          {sites && sites.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="site">Site *</Label>
              <Select value={selectedSiteId} onValueChange={setSelectedSiteId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select site" />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Asset Selection */}
          {assets && assets.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="asset">Asset (Optional)</Label>
              <Select value={assetId} onValueChange={setAssetId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select asset" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {assets.map((asset) => (
                    <SelectItem key={asset.id} value={asset.id}>
                      {asset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Validity Period */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="validFrom">Valid From</Label>
              <Input
                id="validFrom"
                type="datetime-local"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="validUntil">Valid Until</Label>
              <Input
                id="validUntil"
                type="datetime-local"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Leave empty for no expiry
              </p>
            </div>
          </div>

          {/* Required Approvals */}
          <div className="space-y-2">
            <Label htmlFor="requiredApprovals">Required Approvals</Label>
            <Input
              id="requiredApprovals"
              type="number"
              min={1}
              max={10}
              value={requiredApprovals}
              onChange={(e) => setRequiredApprovals(parseInt(e.target.value) || 1)}
            />
            <p className="text-sm text-muted-foreground">
              Number of approvals needed before minting (multi-sig)
            </p>
          </div>

          {/* Supersedes Notice */}
          {supersedes && (
            <Alert>
              <AlertDescription>
                This certification will supersede and replace the existing certification.
                The original will be marked as superseded upon minting.
              </AlertDescription>
            </Alert>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating..." : "Create Request"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
