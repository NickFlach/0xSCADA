# IEC 62443 Assessment Mapping

0xSCADA implements an automated, evidence-based readiness assessment for the
IEC 62443 foundational requirements. It is an engineering aid for certification
work; it does not assert that a deployment is certified. Only an accredited
assessor can make that determination.

The versioned catalog lives in
`server/services/compliance/index.ts` (`COMPLIANCE_CATALOG_VERSION`). A control
passes only when every required evidence key is present and positive. A
negative observation is `fail`; absent evidence is `not-assessed`. Missing
evidence is never counted as a pass.

## Security-level calculation

Security levels are cumulative:

- SL 1 evaluates the seven foundational-requirement controls.
- SL 2 adds administrator/remote MFA and tested zone boundaries.
- SL 3 adds vulnerability gates and managed key/certificate rotation.
- SL 4 adds hardware-backed, non-exportable root keys.

`achievedSecurityLevel` is the highest level for which every control at that
level and every lower level passes. One failed or unassessed SL 1 control means
the automated result is SL 0, even if higher-level controls have evidence.

## Control and evidence mapping

| Toolkit control | FR | Level | Required evidence keys | Equivalent NIST CSF controls |
|---|---|---:|---|---|
| `IEC62443-FR1-IAC-1` | FR 1 Identification and authentication | 1 | `identity.uniqueUsers`, `identity.serviceAccountsInventoried` | `NIST-PR.AA-01` |
| `IEC62443-FR2-UC-1` | FR 2 Use control | 1 | `access.rbacEnabled`, `access.defaultDeny` | `NIST-PR.AA-05` |
| `IEC62443-FR3-SI-1` | FR 3 System integrity | 1 | `integrity.signedArtifacts`, `integrity.configurationAudit` | `NIST-PR.PS-06` |
| `IEC62443-FR4-DC-1` | FR 4 Data confidentiality | 1 | `crypto.tlsEnabled`, `crypto.atRestEncryption` | `NIST-PR.DS-01`, `NIST-PR.DS-02` |
| `IEC62443-FR5-RDF-1` | FR 5 Restricted data flow | 1 | `network.zoneInventory`, `network.defaultDenyPolicy` | `NIST-PR.IR-01` |
| `IEC62443-FR6-TRE-1` | FR 6 Timely response to events | 1 | `monitoring.securityEvents`, `response.onCallOwned` | `NIST-DE.CM-01`, `NIST-RS.MA-01` |
| `IEC62443-FR7-RA-1` | FR 7 Resource availability | 1 | `recovery.backupVerified`, `availability.capacityHeadroom` | `NIST-RC.RP-01` |
| `IEC62443-SL2-IAC-2` | FR 1 Identification and authentication | 2 | `identity.adminMfa`, `identity.remoteMfa` | `NIST-PR.AA-03` |
| `IEC62443-SL2-RDF-2` | FR 5 Restricted data flow | 2 | `network.policyTested` | `NIST-ID.RA-01` |
| `IEC62443-SL3-SI-2` | FR 3 System integrity | 3 | `integrity.dependencyScan`, `integrity.imageScan` | `NIST-ID.RA-01`, `NIST-PR.PS-06` |
| `IEC62443-SL3-DC-2` | FR 4 Data confidentiality | 3 | `crypto.rotationAutomated`, `crypto.revocationTested` | `NIST-PR.DS-01` |
| `IEC62443-SL4-SI-3` | FR 3 System integrity | 4 | `integrity.hardwareBackedKeys` | `NIST-PR.PS-06` |

Every scan returns the per-FR pass/applicable counts, its target and achieved
security levels, the evidence manifest, and actionable gaps.

## Example assessment

```ts
import {
  ComplianceScanner,
  ObjectEvidenceCollector,
} from '../../server/services/compliance';

const collector = new ObjectEvidenceCollector('iam-and-runtime', {
  'identity.uniqueUsers': true,
  'identity.serviceAccountsInventoried': true,
  'access.rbacEnabled': true,
  'access.defaultDeny': true,
});

const scanner = new ComplianceScanner({ collectors: [collector] });
const scan = await scanner.runScan({
  frameworks: ['IEC-62443'],
  targetSecurityLevel: 1,
});

console.log(scan.iec62443?.achievedSecurityLevel, scan.gaps);
```

See [Compliance assessment operations](assessment-guide.md) for evidence
provenance, API use, report generation, and review requirements.
