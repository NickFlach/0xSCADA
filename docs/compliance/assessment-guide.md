# Compliance Assessment Operations

## Purpose and boundaries

The toolkit automates evidence evaluation, IEC 62443 readiness levels, NIST CSF
mapping, gap analysis, and audit-report assembly. It does not turn a platform
feature into deployment evidence and does not replace an accredited assessor.
Evidence must describe the deployed environment being assessed.

## Evidence contract

Each artifact has:

```json
{
  "key": "access.defaultDeny",
  "value": true,
  "source": "cluster-policy-export/sha256:…",
  "collectedAt": "2026-07-28T12:00:00.000Z",
  "description": "Default-deny policies validated in all production namespaces"
}
```

- `key` is one of the control-catalog evidence keys.
- `value` must satisfy the key-specific contract returned as
  `evidenceRequirements` by `GET /api/governance/compliance/rules`. Boolean
  controls require the literal value `true`; a non-empty string such as
  `"disabled"` is never treated as a passing attestation. Owner keys require a
  non-negative identifier, `availability.capacityHeadroom` requires a positive
  number, and `network.zoneInventory` requires a non-empty string list.
- `source` identifies a reproducible export, query, or immutable artifact.
- `collectedAt` is ISO-8601. When duplicate keys exist, the newest observation
  wins.

Collectors implement `EvidenceCollector`. A collector failure fails the scan;
the toolkit does not silently continue with a partial source.

Production deployments can inject collectors through
`registerRoutes(..., { complianceCollectors: [...] })`. A concrete
`JsonFileEvidenceCollector` is included for evidence snapshots mounted by
deployment automation. Set `COMPLIANCE_EVIDENCE_FILE` to register that
collector automatically at boot. The document shape is:

```json
{
  "source": "cluster-policy-export/sha256:…",
  "collectedAt": "2026-07-28T12:00:00.000Z",
  "evidence": {
    "access.rbacEnabled": true,
    "network.zoneInventory": ["operations", "safety"]
  }
}
```

The file is re-read for every scan, is capped at 1 MiB by default, and invalid
JSON or unsupported values fail the scan.

## Run a scan

```http
POST /api/governance/compliance/scan
Content-Type: application/json

{
  "scope": "full",
  "frameworks": ["IEC-62443", "NIST-CSF"],
  "targetSecurityLevel": 2,
  "evidence": [
    {
      "key": "identity.adminMfa",
      "value": true,
      "source": "iam-policy-export/2026-07-28",
      "collectedAt": "2026-07-28T12:00:00.000Z"
    }
  ]
}
```

A `targeted` scan must supply `controlIds` (the legacy `rules` field is also
accepted). Server-managed recurring scans are enabled with
`COMPLIANCE_SCAN_INTERVAL_MS`; values below 60 seconds are ignored for safety.
Collectors and the recurring timer start while server routes are registered,
not after the first scan request. The API rejects `schedule: true` so it cannot
pretend an in-memory request was durably scheduled.

Interpretation:

- `compliant`: every applicable control passed;
- `non-compliant`: at least one control has negative evidence;
- `incomplete`: no negative evidence, but at least one artifact is missing.

## Review gaps

`GET /api/governance/compliance/findings/:scanId` returns failed and unassessed
controls separately, with missing keys, negative keys, severity, and
remediation. Critical gaps should become owned work items before an external
assessment. Do not rewrite `not-assessed` as `pass`.

## Generate and retain the audit artifact

```http
POST /api/governance/compliance/reports/scan-0123456789abcdef
Content-Type: application/json

{
  "organization": "Example Water Utility",
  "auditor": "Internal Controls",
  "scope": "Production gateways, API, historian, and integrity pipeline"
}
```

The report contains an executive summary, framework summaries, all gaps, an
evidence manifest, Markdown output, and a SHA-256 content digest. Retain:

1. the JSON report;
2. the evidence objects referenced in its manifest;
3. the catalog version;
4. the deployment/configuration commit;
5. reviewer sign-off and any accepted-risk record.

Verify the retained report digest before handing it to a certification body.
The digest provides change detection, not signer identity; apply the
organization's document-signing process when non-repudiation is required.
