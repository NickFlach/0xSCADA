# NIST Cybersecurity Framework 2.0 Mapping

The compliance toolkit maps evidence across all six NIST CSF 2.0 functions.
The mapping is a maintained engineering interpretation, not a certification or
legal opinion. Catalog version and individual mapped IEC 62443 controls are
included in every scan.

## Automated control set

| Function | Toolkit control | Assessment intent | Required evidence |
|---|---|---|---|
| Govern | `NIST-GV.OC-01` | OT cybersecurity ownership and approved policy | `governance.securityOwner`, `governance.securityPolicyApproved` |
| Identify | `NIST-ID.AM-01` | Current asset inventory with ownership | `assets.inventoryCurrent` |
| Identify | `NIST-ID.RA-01` | Dependency and image vulnerability discovery | `integrity.dependencyScan`, `integrity.imageScan` |
| Protect | `NIST-PR.AA-01` | Identity lifecycle management | `identity.uniqueUsers`, `identity.serviceAccountsInventoried` |
| Protect | `NIST-PR.AA-03` | Strong privileged and remote authentication | `identity.adminMfa`, `identity.remoteMfa` |
| Protect | `NIST-PR.AA-05` | Least privilege and deny by default | `access.rbacEnabled`, `access.defaultDeny` |
| Protect | `NIST-PR.DS-01` | Protected data at rest | `crypto.atRestEncryption` |
| Protect | `NIST-PR.DS-02` | Protected data in transit | `crypto.tlsEnabled` |
| Protect | `NIST-PR.PS-06` | Software and configuration integrity | `integrity.signedArtifacts`, `integrity.configurationAudit` |
| Protect | `NIST-PR.IR-01` | Network zones and allowlisted conduits | `network.zoneInventory`, `network.defaultDenyPolicy` |
| Detect | `NIST-DE.CM-01` | Continuous security-event monitoring | `monitoring.securityEvents` |
| Respond | `NIST-RS.MA-01` | Owned and exercised response process | `response.onCallOwned`, `response.exerciseCompleted` |
| Recover | `NIST-RC.RP-01` | Verified backups and recovery exercises | `recovery.backupVerified`, `recovery.exerciseCompleted` |

## Scoring

Each function reports:

- `passed`: controls whose complete evidence set is positive;
- `assessed`: controls with either positive or negative evidence;
- `total`: all applicable controls in the function;
- `score`: passed controls divided by total controls.

Unassessed controls remain in the denominator. This prevents an incomplete
evidence export from inflating the score.

## Example scan

```ts
import { ComplianceScanner } from '../../server/services/compliance';

const scanner = new ComplianceScanner();
const result = await scanner.runScan('NIST-CSF', evidence);

for (const summary of result.nistCsf!.functions) {
  console.log(summary.function, summary.score);
}
```

The HTTP equivalent is `POST /api/governance/compliance/scan`; use
`frameworks: ["NIST-CSF"]` and an `evidence` array. Generate a signed-content
audit artifact with `POST /api/governance/compliance/reports/:scanId`.

See [Compliance assessment operations](assessment-guide.md) for the complete
request and evidence-handling procedure.
