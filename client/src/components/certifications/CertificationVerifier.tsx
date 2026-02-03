/**
 * Certification Verifier Component
 * 
 * VERITY Architecture - Phase δ.2: Certification Workflow
 * 
 * Component for verifying certification validity by token ID or artifact hash.
 */

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import {
  CERTIFICATION_TYPE_INFO,
  type VerificationResult,
} from "./types";

// =============================================================================
// TYPES
// =============================================================================

export interface CertificationVerifierProps {
  /** Callback to verify by token ID */
  onVerifyByTokenId: (tokenId: string) => Promise<VerificationResult>;
  /** Callback to verify by artifact hash */
  onVerifyByArtifactHash: (hash: string) => Promise<VerificationResult>;
  /** Additional class name */
  className?: string;
}

// =============================================================================
// HELPER COMPONENTS
// =============================================================================

function VerificationResultDisplay({ result }: { result: VerificationResult }) {
  const typeInfo = result.certType ? CERTIFICATION_TYPE_INFO[result.certType] : null;

  return (
    <div className="space-y-4 mt-4">
      <Alert variant={result.isValid ? "default" : "destructive"}>
        <AlertTitle className="flex items-center gap-2">
          {result.isValid ? (
            <>
              <span className="text-green-500">✓</span>
              Certification Valid
            </>
          ) : (
            <>
              <span className="text-red-500">✗</span>
              Certification Invalid
            </>
          )}
        </AlertTitle>
        <AlertDescription>{result.reason}</AlertDescription>
      </Alert>

      {result.tokenId && (
        <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
          <div>
            <Label className="text-sm text-muted-foreground">Token ID</Label>
            <p className="font-mono text-sm">{result.tokenId}</p>
          </div>
          {typeInfo && (
            <div>
              <Label className="text-sm text-muted-foreground">Type</Label>
              <p className="flex items-center gap-2">
                <span>{typeInfo.icon}</span>
                <span>{typeInfo.displayName}</span>
              </p>
            </div>
          )}
          {result.validFrom && (
            <div>
              <Label className="text-sm text-muted-foreground">Valid From</Label>
              <p className="font-mono text-sm">
                {new Date(result.validFrom).toLocaleDateString()}
              </p>
            </div>
          )}
          {result.validUntil && (
            <div>
              <Label className="text-sm text-muted-foreground">Valid Until</Label>
              <p className="font-mono text-sm">
                {new Date(result.validUntil).toLocaleDateString()}
              </p>
            </div>
          )}
          {result.remainingDays !== undefined && (
            <div className="col-span-2">
              <Label className="text-sm text-muted-foreground">Remaining Validity</Label>
              <p className={cn(
                "font-bold",
                result.remainingDays <= 30 ? "text-orange-500" : "text-green-500"
              )}>
                {result.remainingDays} days
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function CertificationVerifier({
  onVerifyByTokenId,
  onVerifyByArtifactHash,
  className,
}: CertificationVerifierProps) {
  const [tokenId, setTokenId] = React.useState("");
  const [artifactHash, setArtifactHash] = React.useState("");
  const [result, setResult] = React.useState<VerificationResult | null>(null);
  const [isVerifying, setIsVerifying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleVerifyByTokenId = async () => {
    if (!tokenId.trim()) {
      setError("Please enter a token ID");
      return;
    }

    setError(null);
    setResult(null);
    setIsVerifying(true);

    try {
      const verificationResult = await onVerifyByTokenId(tokenId.trim());
      setResult(verificationResult);
    } catch (err: any) {
      setError(err.message || "Verification failed");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleVerifyByArtifactHash = async () => {
    if (!artifactHash.trim()) {
      setError("Please enter an artifact hash");
      return;
    }

    if (!/^[a-f0-9]{64}$/i.test(artifactHash.trim())) {
      setError("Artifact hash must be a 64-character hex string (SHA-256)");
      return;
    }

    setError(null);
    setResult(null);
    setIsVerifying(true);

    try {
      const verificationResult = await onVerifyByArtifactHash(artifactHash.trim().toLowerCase());
      setResult(verificationResult);
    } catch (err: any) {
      setError(err.message || "Verification failed");
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <CardTitle>🔍 Verify Certification</CardTitle>
        <CardDescription>
          Check the validity of an operational certification by token ID or artifact hash
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="tokenId" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="tokenId">By Token ID</TabsTrigger>
            <TabsTrigger value="artifactHash">By Artifact Hash</TabsTrigger>
          </TabsList>

          <TabsContent value="tokenId" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tokenId">Token ID</Label>
              <div className="flex gap-2">
                <Input
                  id="tokenId"
                  value={tokenId}
                  onChange={(e) => setTokenId(e.target.value)}
                  placeholder="Enter NFT token ID"
                  className="flex-1"
                />
                <Button onClick={handleVerifyByTokenId} disabled={isVerifying}>
                  {isVerifying ? "Verifying..." : "Verify"}
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="artifactHash" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="artifactHash">Artifact Hash (SHA-256)</Label>
              <div className="flex gap-2">
                <Input
                  id="artifactHash"
                  value={artifactHash}
                  onChange={(e) => setArtifactHash(e.target.value)}
                  placeholder="Enter 64-character artifact hash"
                  className="flex-1 font-mono text-sm"
                />
                <Button onClick={handleVerifyByArtifactHash} disabled={isVerifying}>
                  {isVerifying ? "Verifying..." : "Verify"}
                </Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {error && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && <VerificationResultDisplay result={result} />}
      </CardContent>
    </Card>
  );
}
