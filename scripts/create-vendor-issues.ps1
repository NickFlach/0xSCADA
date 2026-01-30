# Create Vendor Learning Tract Issues for 0xSCADA
param(
    [switch]$DryRun
)

if ($DryRun) {
    Write-Host "Running in dry-run mode - no issues will be created"
} else {
    Write-Host "Creating actual vendor learning tract issues in GitHub..."
}

# Helper function to create issue
function Create-Issue {
    param(
        [string]$Title,
        [string]$Labels,
        [string]$Body
    )
    
    if ($DryRun) {
        Write-Host "[DRY-RUN] Would create issue: $Title"
        Write-Host "[DRY-RUN] Labels: $Labels"
        Write-Host "[DRY-RUN] Body preview: $($Body.Substring(0, [Math]::Min(100, $Body.Length)))..."
        Write-Host ""
    } else {
        $tempFile = New-TemporaryFile
        $Body | Out-File -FilePath $tempFile.FullName -Encoding UTF8
        
        try {
            gh issue create --title $Title --label $Labels --body-file $tempFile.FullName
            Write-Host "Created issue: $Title"
        } catch {
            Write-Error "Failed to create issue: $Title - $_"
        } finally {
            Remove-Item $tempFile.FullName -Force
        }
    }
}

Write-Host "Creating Vendor Learning Tract Issues..."
Write-Host "=========================================="

# TRACT 0 — Vendor Orientation (Required)
$issueBody = @"
## 🧭 TRACT 0 — Vendor Orientation (Required)

### Purpose
Ensure vendors understand 0xSCADA philosophy, constraints, and expectations.

### Scope
- [ ] Review repo structure
- [ ] Understand SCADA / OT constraints
- [ ] Review security & compliance posture

### Deliverables
- [ ] Vendor acknowledgement of architecture doc
- [ ] Confirmed dev environment setup
- [ ] Named technical POC

### Acceptance Criteria
- [ ] Vendor can explain data flow end-to-end
- [ ] Vendor can run core services locally

### References
- Architecture documentation: `/docs/architecture/`
- Development setup: `/docs/development/setup.md`
- Security posture: `/docs/security/overview.md`

### Vendor Definition of Done
- [x] Code merged
- [x] Tests passing
- [x] Docs written
- [x] Security reviewed
- [x] Handoff walkthrough completed
"@

Create-Issue -Title "[Vendor/Core] 0xSCADA Architecture & Contribution Onboarding" -Labels "vendor,orientation,P0" -Body $issueBody

# TRACT 1 — Edge & Gateway Integration (Meta Issue)
$issueBody = @"
## 🔌 TRACT 1 — Edge & Gateway Integration

### Goal
Enable secure, reliable edge deployments (factory floor, plant network).

### Milestones
- [ ] Edge runtime understanding
- [ ] Containerized deployment
- [ ] Protocol ingestion

### Child Issues
- [Containerized Edge Runtime Pattern](https://github.com/NickFlach/0xSCADA/issues/XX) - Docker/Podman runtime for edge nodes
- [OPC-UA Subscription & Polling Driver](https://github.com/NickFlach/0xSCADA/issues/XX) - OPC-UA driver implementation

### Vendor Definition of Done
- [x] Code merged
- [x] Tests passing
- [x] Docs written
- [x] Security reviewed
- [x] Handoff walkthrough completed
"@

Create-Issue -Title "[Edge] Vendor Learning Tract — Edge & Gateway Integration" -Labels "vendor,edge,gateway,P0" -Body $issueBody

# TRACT 1 - Containerized Edge Runtime Pattern
$issueBody = @"
## 📌 Issue: [Edge] Containerized Edge Runtime Pattern

### Scope
- [ ] Docker / Podman runtime for edge nodes
- [ ] Offline-first behavior
- [ ] Secure secret handling

### Deliverables
- [ ] Dockerfile(s)
- [ ] Deployment README
- [ ] Resource constraints documented

### Acceptance Criteria
- [ ] Runs on low-resource hardware
- [ ] Survives network loss
- [ ] Deterministic restart behavior

### References
- Edge deployment: `/docker/edge/`
- Gateway: `server/gateway/index.ts`
- Container patterns: `/docs/deployment/containerization.md`

### Vendor Definition of Done
- [x] Code merged
- [x] Tests passing
- [x] Docs written
- [x] Security reviewed
- [x] Handoff walkthrough completed
"@

Create-Issue -Title "[Edge] Containerized Edge Runtime Pattern" -Labels "vendor,edge,docker,deployment,P0" -Body $issueBody

# TRACT 1 - OPC-UA Subscription & Polling Driver
$issueBody = @"
## 📌 Issue: [Gateway] OPC-UA Subscription & Polling Driver

### Scope
- [ ] OPC-UA subscriptions
- [ ] Polling fallback
- [ ] Error handling & retries

### Deliverables
- [ ] Driver module
- [ ] Config schema
- [ ] Simulated test harness

### Acceptance Criteria
- [ ] Handles >1k tags
- [ ] No memory leaks
- [ ] Clean reconnect behavior

### References
- Gateway drivers: `server/gateway/index.ts`
- OPC UA protocol: existing OPC_UA driver
- Test patterns: `/tests/gateway/`

### Vendor Definition of Done
- [x] Code merged
- [x] Tests passing
- [x] Docs written
- [x] Security reviewed
- [x] Handoff walkthrough completed
"@

Create-Issue -Title "[Gateway] OPC-UA Subscription & Polling Driver" -Labels "vendor,gateway,opc-ua,P0" -Body $issueBody

# TRACT 2 — Observability & Diagnostics (Meta Issue)
$issueBody = @"
## 📊 TRACT 2 — Observability & Diagnostics

### Goal
Make system behavior measurable, diagnosable, and auditable.

### Child Issues
- [Prometheus Metrics Exporter](https://github.com/NickFlach/0xSCADA/issues/XX) - System metrics export
- [Grafana Dashboards for OT Operators](https://github.com/NickFlach/0xSCADA/issues/XX) - Operator-friendly visualization

### Vendor Definition of Done
- [x] Code merged
- [x] Tests passing
- [x] Docs written
- [x] Security reviewed
- [x] Handoff walkthrough completed
"@

Create-Issue -Title "[Observability] Vendor Learning Tract — Metrics & Visibility" -Labels "vendor,observability,metrics,P0" -Body $issueBody

# TRACT 2 - Prometheus Metrics Exporter
$issueBody = @"
## 📌 Issue: [Observability] Prometheus Metrics Exporter

### Scope
- [ ] Export system metrics
- [ ] Standard label taxonomy
- [ ] Low overhead

### Deliverables
- [ ] Metrics endpoint
- [ ] Metric definitions
- [ ] Example PromQL queries

### Acceptance Criteria
- [ ] <2% CPU overhead
- [ ] Metrics documented
- [ ] Stable label cardinality

### References
- Metrics patterns: `/docs/observability/metrics.md`
- Existing metrics: `server/metrics/`
- Prometheus integration: `/docker/prometheus/`

### Vendor Definition of Done
- [x] Code merged
- [x] Tests passing
- [x] Docs written
- [x] Security reviewed
- [x] Handoff walkthrough completed
"@

Create-Issue -Title "[Observability] Prometheus Metrics Exporter" -Labels "vendor,observability,prometheus,metrics,P0" -Body $issueBody

# TRACT 2 - Grafana Dashboards for OT Operators
$issueBody = @"
## 📌 Issue: [Observability] Grafana Dashboards for OT Operators

### Scope
- [ ] Operator-friendly dashboards
- [ ] Alarm-adjacent visibility
- [ ] Trend views

### Deliverables
- [ ] Grafana JSON dashboards
- [ ] Screenshots
- [ ] Operator README

### Acceptance Criteria
- [ ] Non-engineer readable
- [ ] Clear alarm precursors
- [ ] Time-range flexibility

### References
- Grafana setup: `/docker/grafana/`
- Dashboard patterns: `/docs/observability/dashboards.md`
- OT operator guidelines: `/docs/operators/`

### Vendor Definition of Done
- [x] Code merged
- [x] Tests passing
- [x] Docs written
- [x] Security reviewed
- [x] Handoff walkthrough completed
"@

Create-Issue -Title "[Observability] Grafana Dashboards for OT Operators" -Labels "vendor,observability,grafana,P0" -Body $issueBody

Write-Host ""
Write-Host "=========================================="
Write-Host "Vendor Learning Tract Issues creation complete!"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Review created issues in GitHub"
Write-Host "2. Create milestone: 'Vendor Learning Tracts'"
Write-Host "3. Create project board for tracking"
Write-Host "4. Assign issues to vendor teams"
