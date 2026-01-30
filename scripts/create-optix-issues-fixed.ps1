# Create GitHub Issues for Optix Learning & Development Tract
# Usage: ./scripts/create-optix-issues.ps1 [-DryRun]
#
# Prerequisites:
# - gh CLI authenticated: gh auth login
# - Repository access: gh repo view

param(
    [switch]$DryRun
)

if ($DryRun) {
    Write-Host "Running in dry-run mode - no issues will be created"
} else {
    Write-Host "Creating actual issues in GitHub..."
}

# Check gh CLI
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Error "Error: GitHub CLI (gh) not found. Install from https://cli.github.com/"
    exit 1
}

# Verify authentication
try {
    $null = gh auth status
} catch {
    Write-Error "Error: Not authenticated. Run: gh auth login"
    exit 1
}

Write-Host "Creating Optix Learning & Development Tract Issues..."
Write-Host "======================================================="

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

# Path 1: Foundation (P0)
$issueBody = @"
## Overview
Integrate patterns from [NetLogic_CheatSheet](https://github.com/FactoryTalk-Optix/NetLogic_CheatSheet) (74 stars) into 0xSCADA's Rockwell adapter.

## Repository Purpose
Collection of C# snippets ready for copy-paste, covering runtime and design-time NetLogic operations.

## 0xSCADA Integration Goals
- [ ] Extract reusable C# patterns for Ubiquity SDK extension
- [ ] Identify runtime patterns for event generation
- [ ] Document design-time patterns for code generation
- [ ] Create TypeScript equivalents where applicable

## Acceptance Criteria
- NetLogic patterns documented in `/docs/optix/netlogic-patterns.md`
- At least 5 patterns integrated into existing Rockwell adapter
- Integration tests per CLAUDE.md integrity rules (real DB, no mocks)

## References
- Ubiquity SDK integration: `server/services/ubiquity/`
- Rockwell adapter: `server/routes/rockwell-adapter.ts`
"@

Create-Issue -Title "[Optix/Foundation] Implement NetLogic CheatSheet patterns for 0xSCADA" -Labels "optix,foundation,netlogic,P0" -Body $issueBody

# Path 1: Runtime NetLogic
$issueBody = @"
## Overview
Study [Training_NetLogicRuntime](https://github.com/FactoryTalk-Optix/Training_NetLogicRuntime) (6 stars) for runtime patterns.

## Repository Purpose
Runtime NetLogic are C# snippets that can be executed while the runtime is running.

## 0xSCADA Integration Goals
- [ ] Document runtime NetLogic patterns
- [ ] Identify event generation patterns
- [ ] Create TypeScript equivalents for Node.js
- [ ] Map to 0xSCADA event model

## Acceptance Criteria
- Runtime patterns documented
- At least 3 patterns converted to TypeScript
- Event generation patterns identified
- Documentation in `/docs/optix/runtime-patterns.md`

## References
- Events: `server/events/index.ts`
- Ubiquity client: `server/services/ubiquity/`
"@

Create-Issue -Title "[Optix/Foundation] Study Runtime NetLogic training for event generation" -Labels "optix,foundation,netlogic,runtime,P0" -Body $issueBody

# Path 1: Design-Time NetLogic
$issueBody = @"
## Overview
Study [Training_NetLogicDesignTime](https://github.com/FactoryTalk-Optix/Training_NetLogicDesignTime) (8 stars) for design-time patterns.

## Repository Purpose
DesignTime NetLogic are bits of C# code used to speed up project development through automation.

## 0xSCADA Integration Goals
- [ ] Document design-time automation patterns
- [ ] Identify code generation patterns
- [ ] Plan AI-assisted code generation integration
- [ ] Create tooling for Optix project automation

## Acceptance Criteria
- Design-time patterns documented
- Code generation workflow defined
- AI integration points identified
- Documentation in `/docs/optix/designtime-patterns.md`

## References
- Code generation events: `EventType.CODE_GENERATION`
- Deployment intents: `EventType.DEPLOYMENT_INTENT`
"@

Create-Issue -Title "[Optix/Foundation] Study Design-Time NetLogic for code generation tooling" -Labels "optix,foundation,netlogic,designtime,P0" -Body $issueBody

# Path 2: OPC UA (P0)
$issueBody = @"
## Overview
Integrate [Optix_Sample_ArbitraryOpcUaRead](https://github.com/FactoryTalk-Optix/Optix_Sample_ArbitraryOpcUaRead) patterns into 0xSCADA's OPC UA gateway driver.

## Repository Purpose
Demonstrates arbitrary read operations from OPC UA servers in FactoryTalk Optix.

## 0xSCADA Integration Goals
- [ ] Extend `ProtocolDriver` interface with OPC UA read patterns
- [ ] Add flexible node addressing to OPC_UA protocol driver
- [ ] Implement browse operations for tag discovery
- [ ] Create telemetry events from OPC UA reads

## Acceptance Criteria
- OPC UA driver supports arbitrary node reads
- Integration test with real OPC UA server (node-opcua test server)
- Events generated per `server/events/index.ts` patterns

## References
- Gateway: `server/gateway/index.ts` (OPC_UA protocol)
- Event types: `EventType.TELEMETRY`
"@

Create-Issue -Title "[Optix/OPC-UA] Implement arbitrary OPC UA read for gateway driver" -Labels "optix,opc-ua,gateway,P0" -Body $issueBody

# Path 2: OPC UA Alarms & Events
$issueBody = @"
## Overview
Integrate [BoilerDemo_Client](https://github.com/FactoryTalk-Optix/BoilerDemo_Client) OPC UA Alarm & Events patterns.

## Repository Purpose
BoilerDemo Client using OPC UA to monitor alarms via the OPC/UA Alarm and Events protocol.

## 0xSCADA Integration Goals
- [ ] Implement OPC UA A&E subscription in gateway driver
- [ ] Map OPC UA alarm events to 0xSCADA alarm model
- [ ] Support alarm acknowledgment over OPC UA
- [ ] Create signed alarm events with blockchain anchoring

## Acceptance Criteria
- OPC UA driver subscribes to A&E events
- Alarms stored in `events` table with proper signatures
- Acknowledgments create `EventType.ACKNOWLEDGEMENT` events
- Integration test with OPC UA server alarm simulation

## References
- Alarm events: `createAlarmEvent()` in `server/events/index.ts`
- Schema: `events` table in `shared/schema.ts`
"@

Create-Issue -Title "[Optix/OPC-UA] Implement OPC UA Alarms & Events subscription" -Labels "optix,opc-ua,alarms,P0" -Body $issueBody

# Path 3: MQTT & IoT (P0)
$issueBody = @"
## Overview
Integrate [Optix_Sample_AzureIoTOperations](https://github.com/FactoryTalk-Optix/Optix_Sample_AzureIoTOperations) (9 stars) for Azure IoT connectivity.

## Repository Purpose
Sample communication between FactoryTalk Optix and Microsoft Azure IoT Operations.

## 0xSCADA Integration Goals
- [ ] Add AZURE_IOT protocol type to gateway
- [ ] Implement Azure IoT Hub client in Node.js
- [ ] Create telemetry pipeline from Optix to Azure to 0xSCADA
- [ ] Support Digital Twin sync with Azure Digital Twins

## Acceptance Criteria
- `AZURE_IOT` protocol driver operational
- Telemetry events flow from Azure IoT Hub
- Integration with existing Ubiquity SDK layer
- Test with Azure IoT Hub emulator or real instance

## References
- Protocol drivers: `server/gateway/index.ts`
- Ubiquity integration: `server/services/ubiquity/`
"@

Create-Issue -Title "[Optix/IoT] Integrate Azure IoT Operations for cloud telemetry" -Labels "optix,azure,iot,mqtt,P0" -Body $issueBody

# Path 4: Database (P0)
$issueBody = @"
## Overview
Study [postgres_example](https://github.com/FactoryTalk-Optix/postgres_example) (3 stars) for PostgreSQL integration patterns.

## Repository Purpose
Postgres connection widget example with SSH tunnel option for secure database access.

## 0xSCADA Integration Goals
- [ ] Document Optix PostgreSQL connection patterns
- [ ] Implement SSH tunnel support for edge-to-cloud DB sync
- [ ] Create data replication patterns for distributed 0xSCADA
- [ ] Add connection pooling for high-throughput scenarios

## Acceptance Criteria
- SSH tunnel connection option in Drizzle config
- Documentation in `/docs/optix/database-patterns.md`
- Edge-to-cloud sync prototype working
- Integration test with real PostgreSQL

## References
- Database config: `server/db.ts`
- Schema: `shared/schema.ts`
"@

Create-Issue -Title "[Optix/Database] Implement PostgreSQL connection patterns" -Labels "optix,database,postgres,P0" -Body $issueBody

# Path 5: REST APIs (P0)
$issueBody = @"
## Overview
Integrate [REST_WEB_WS_Server](https://github.com/FactoryTalk-Optix/REST_WEB_WS_Server) (3 stars) patterns.

## Repository Purpose
Sample of hosting a REST, WEB, and WebSocket Server in Optix.

## 0xSCADA Integration Goals
- [ ] Document Optix REST server patterns
- [ ] Implement WebSocket streaming for real-time events
- [ ] Add SSE endpoint for event subscriptions
- [ ] Create unified API pattern for edge devices

## Acceptance Criteria
- WebSocket endpoint at `/ws/events`
- SSE endpoint at `/api/events/stream`
- Documentation in `/docs/optix/api-patterns.md`
- Integration test for streaming endpoints

## References
- Express routes: `server/routes.ts`
- Event subscription: `EventService.onEvent()`
"@

Create-Issue -Title "[Optix/REST] Implement REST/WebSocket server patterns" -Labels "optix,rest,websocket,api,P0" -Body $issueBody

# Path 6: Alarms (P0)
$issueBody = @"
## Overview
Integrate [Optix_Sample_CustomAlarmsManagement](https://github.com/FactoryTalk-Optix/Optix_Sample_CustomAlarmsManagement) patterns.

## Repository Purpose
Custom alarms management engine using a database for alarm configuration and state.

## 0xSCADA Integration Goals
- [ ] Study database-backed alarm configuration
- [ ] Implement alarm templates in schema
- [ ] Add runtime alarm generation from templates
- [ ] Create alarm-to-event transformation

## Acceptance Criteria
- Alarm templates table in schema
- Runtime alarm instantiation working
- Events created with proper signatures
- Integration test with real database

## References
- Alarm events: `createAlarmEvent()` in `server/events/index.ts`
- Schema: `shared/schema.ts`
"@

Create-Issue -Title "[Optix/Alarms] Implement custom alarm management engine" -Labels "optix,alarms,events,P0" -Body $issueBody

# Path 7: Recipes (P0)
$issueBody = @"
## Overview
Integrate [Optix_Sample_RecipesWithAudit](https://github.com/FactoryTalk-Optix/Optix_Sample_RecipesWithAudit) for regulated industries.

## Repository Purpose
Sample recipes auditing for CFR21-like use cases in pharmaceutical and regulated manufacturing.

## 0xSCADA Integration Goals
- [ ] Add recipe table to schema with version control
- [ ] Implement recipe change events with signatures
- [ ] Create audit report generation
- [ ] Support electronic signatures per 21 CFR Part 11

## Acceptance Criteria
- Recipe schema with audit fields
- Recipe change events blockchain-anchored
- CFR21-compliant audit report generator
- Integration test with recipe lifecycle

## References
- Event signing: `signEvent()` in `server/crypto/`
- Blockchain anchoring: `server/merkle/`
"@

Create-Issue -Title "[Optix/Recipes] Implement CFR21-compliant recipe auditing" -Labels "optix,recipes,cfr21,compliance,P0" -Body $issueBody

# Path 8: Security (P0)
$issueBody = @"
## Overview
Integrate [Optix_Sample_TwoFactorsAuthentication](https://github.com/FactoryTalk-Optix/Optix_Sample_TwoFactorsAuthentication) patterns.

## Repository Purpose
Demonstrates how to implement two-factors authentication (OTP, MFA) in FactoryTalk Optix.

## 0xSCADA Integration Goals
- [ ] Add TOTP-based 2FA to user authentication
- [ ] Implement backup codes for recovery
- [ ] Create 2FA enrollment workflow
- [ ] Add hardware key support (WebAuthn)

## Acceptance Criteria
- 2FA toggle in user settings
- TOTP verification on login
- Backup codes generated and stored encrypted
- Integration test with OTP verification

## References
- User schema: `users` table
- Authentication: `server/auth/`
"@

Create-Issue -Title "[Optix/Security] Implement two-factor authentication" -Labels "optix,security,2fa,authentication,P0" -Body $issueBody

# Path 9: Observability (P0)
$issueBody = @"
## Overview
Integrate [Optix_Sample_PrometheusMetricsExporter](https://github.com/FactoryTalk-Optix/Optix_Sample_PrometheusMetricsExporter) patterns.

## Repository Purpose
Demonstrates how to create a Prometheus endpoint to expose custom metrics from Optix.

## 0xSCADA Integration Goals
- [ ] Add `/metrics` endpoint with Prometheus format
- [ ] Export event throughput metrics
- [ ] Export batch anchoring metrics
- [ ] Create Grafana dashboard templates

## Acceptance Criteria
- Prometheus metrics endpoint at `/metrics`
- Key metrics: events/sec, batch latency, anchor status
- Grafana dashboard in `/docker/grafana/`
- Integration test for metrics endpoint

## References
- Express app: `server/index.ts`
- Event batching: `server/merkle/`
"@

Create-Issue -Title "[Optix/Observability] Implement Prometheus metrics exporter" -Labels "optix,observability,prometheus,metrics,P0" -Body $issueBody

# Path 10: Edge (P0)
$issueBody = @"
## Overview
Integrate [Optix_Docker_FTOptixUpdateServer](https://github.com/FactoryTalk-Optix/Optix_Docker_FTOptixUpdateServer) (22 stars) patterns.

## Repository Purpose
Describes how to create an FT Optix Docker container where users can deploy their FT Optix applications.

## 0xSCADA Integration Goals
- [ ] Study Optix containerization patterns
- [ ] Create unified edge container with 0xSCADA + Optix
- [ ] Implement OTA update mechanism
- [ ] Add container health monitoring

## Acceptance Criteria
- Edge container Dockerfile in `/docker/edge/`
- OTA update service design documented
- Health check endpoints implemented
- Container deployment tested

## References
- Docker compose: `docker-compose.yml`
- Ubiquity bridge: `ubiquity-bridge/Dockerfile`
"@

Create-Issue -Title "[Optix/Edge] Integrate Docker container deployment patterns" -Labels "optix,docker,edge,deployment,P0" -Body $issueBody

# Path 10: Edge Hardware
$issueBody = @"
## Overview
Study [OptixEdge_WizardApp](https://github.com/FactoryTalk-Optix/OptixEdge_WizardApp) (7 stars) for hardware edge patterns.

## Repository Purpose
Source code of the default application running on the AB OptixEdge module.

## 0xSCADA Integration Goals
- [ ] Understand OptixEdge hardware capabilities
- [ ] Document edge module integration patterns
- [ ] Plan Ubiquity SDK deployment to OptixEdge
- [ ] Create edge-to-cloud sync architecture

## Acceptance Criteria
- Edge hardware documentation in `/docs/optix/edge-hardware.md`
- Integration architecture diagram
- Ubiquity SDK edge deployment plan
- Hardware requirements documented

## References
- Ubiquity SDK: `ubiquity-bridge/`
- Gateway: `server/gateway/index.ts`
"@

Create-Issue -Title "[Optix/Edge] Study OptixEdge module source for edge integration" -Labels "optix,edge,hardware,module,P0" -Body $issueBody

Write-Host ""
Write-Host "======================================================="
Write-Host "Issue creation complete!"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Review created issues in GitHub"
Write-Host "2. Add milestone: 'Optix Learning Tract'"
Write-Host "3. Create project board for tracking"
Write-Host "4. Assign issues to team members"
