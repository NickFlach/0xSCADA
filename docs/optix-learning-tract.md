# FactoryTalk Optix Learning & Development Tract

## Vision Alignment

This learning tract maps FactoryTalk Optix repositories to 0xSCADA's industrial control fabric vision:
- **Immutable Audit Trail** - Blockchain-anchored events from Optix devices
- **Multi-Vendor Interoperability** - Protocol drivers including Ubiquity Cloud
- **Digital Twin (AAS)** - Asset Administration Shell with Optix device sync
- **AI-Assisted Operations** - Agent-based code generation and deployment

---

## Learning Paths

### Path 1: Foundation (Prerequisites)
Core NetLogic and Optix fundamentals required before specialized tracks.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [NetLogic_CheatSheet](https://github.com/FactoryTalk-Optix/NetLogic_CheatSheet) | 74 | C# snippets for runtime/design-time | Foundation for all Optix development |
| P0 | [Training_NetLogicRuntime](https://github.com/FactoryTalk-Optix/Training_NetLogicRuntime) | 6 | Runtime C# execution | Event generation, data collection |
| P0 | [Training_NetLogicDesignTime](https://github.com/FactoryTalk-Optix/Training_NetLogicDesignTime) | 8 | Design-time automation | Code generation tooling |
| P1 | [FeaturesDemo2](https://github.com/FactoryTalk-Optix/FeaturesDemo2) | 18 | Comprehensive capabilities | Reference implementation patterns |
| P1 | [ToolboX](https://github.com/FactoryTalk-Optix/ToolboX) | 3 | Utility classes | Reusable NetLogic components |

---

### Path 2: OPC UA & Industrial Protocols
Critical for 0xSCADA's protocol gateway layer.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [Optix_Sample_ArbitraryOpcUaRead](https://github.com/FactoryTalk-Optix/Optix_Sample_ArbitraryOpcUaRead) | 1 | OPC UA client reads | Gateway protocol driver |
| P0 | [BoilerDemo_Client](https://github.com/FactoryTalk-Optix/BoilerDemo_Client) | 1 | OPC UA Alarms & Events | Alarm event subscription |
| P1 | [FeaturesDemo2_M2M_Client](https://github.com/FactoryTalk-Optix/FeaturesDemo2_M2M_Client) | 1 | OPC UA screen/tag/alarm sync | Multi-site data sync |
| P1 | [OpcServer_with_CustomId](https://github.com/FactoryTalk-Optix/OpcServer_with_CustomId) | 1 | OPC UA server publishing | Expose 0xSCADA as OPC UA server |
| P2 | [ModbusServerTCP](https://github.com/FactoryTalk-Optix/ModbusServerTCP) | 3 | Modbus TCP server | Legacy device integration |
| P2 | [ModbusTCPToRAEthernetIp](https://github.com/FactoryTalk-Optix/ModbusTCPToRAEthernetIp) | 3 | Protocol conversion | Multi-protocol gateway |

---

### Path 3: MQTT & IoT Integration
Extends the Ubiquity SDK work for broader IoT connectivity.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [Optix_Sample_AzureIoTOperations](https://github.com/FactoryTalk-Optix/Optix_Sample_AzureIoTOperations) | 9 | Azure IoT Operations | Cloud telemetry pipeline |
| P0 | [Optix_Sample_MqttCustomPayload](https://github.com/FactoryTalk-Optix/Optix_Sample_MqttCustomPayload) | 1 | Custom MQTT payloads | Event message format |
| P1 | [MQTT_DataAggregator](https://github.com/FactoryTalk-Optix/MQTT_DataAggregator) | 1 | MQTT data aggregation | Central data collector |
| P1 | [MQTT_Field](https://github.com/FactoryTalk-Optix/MQTT_Field) | 1 | Field device MQTT | Edge data publishing |
| P1 | [StoreAndForward_Server](https://github.com/FactoryTalk-Optix/StoreAndForward_Server) | 0 | Store-and-forward server | Offline resilience |
| P1 | [StoreAndForward_Client](https://github.com/FactoryTalk-Optix/StoreAndForward_Client) | 0 | Store-and-forward client | Edge buffering |

---

### Path 4: Database & Data Persistence
Critical for historian integration and audit trail.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [Optix_Sample_NetLogicDatabaseInteraction](https://github.com/FactoryTalk-Optix/Optix_Sample_NetLogicDatabaseInteraction) | 1 | NetLogic SQL queries | Event storage patterns |
| P0 | [postgres_example](https://github.com/FactoryTalk-Optix/postgres_example) | 3 | PostgreSQL with SSH | Production DB connection |
| P0 | [Optix_Sample_StoredProceduresNetLogic](https://github.com/FactoryTalk-Optix/Optix_Sample_StoredProceduresNetLogic) | 3 | Stored procedures | Complex data operations |
| P1 | [Optix_Sample_InfluxDB](https://github.com/FactoryTalk-Optix/Optix_Sample_InfluxDB) | 1 | InfluxDB integration | Time-series historian |
| P1 | [Optix_Sample_EmbeddedDatabaseBackupAndRestore](https://github.com/FactoryTalk-Optix/Optix_Sample_EmbeddedDatabaseBackupAndRestore) | 1 | DB backup/restore | Edge resilience |
| P1 | [Optix_Sample_ODBCStoreAndForward](https://github.com/FactoryTalk-Optix/Optix_Sample_ODBCStoreAndForward) | 1 | MySQL store & forward | Offline data sync |
| P2 | [QueriesExamples](https://github.com/FactoryTalk-Optix/QueriesExamples) | 2 | SQL query patterns | Data analysis |

---

### Path 5: REST APIs & Web Services
Extends 0xSCADA's API layer to Optix devices.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [REST_WEB_WS_Server](https://github.com/FactoryTalk-Optix/REST_WEB_WS_Server) | 3 | REST/WebSocket server | Edge API endpoints |
| P1 | [Optix_Sample_RestApiWith3DViewer](https://github.com/FactoryTalk-Optix/Optix_Sample_RestApiWith3DViewer) | 0 | REST API consumption | External service integration |
| P1 | [ChatGPT_RestAPI](https://github.com/FactoryTalk-Optix/ChatGPT_RestAPI) | 3 | AI via REST | Agent integration pattern |
| P1 | [Optix_Sample_DownloadFileToWebClient](https://github.com/FactoryTalk-Optix/Optix_Sample_DownloadFileToWebClient) | 2 | Web file server | Report/log download |

---

### Path 6: Alarms & Events (Critical for Audit Trail)
Core to 0xSCADA's immutable event log.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [Optix_Sample_CustomAlarmsManagement](https://github.com/FactoryTalk-Optix/Optix_Sample_CustomAlarmsManagement) | 0 | Custom alarm engine | Event model alignment |
| P0 | [Optix_Sample_AlarmEventsObserver](https://github.com/FactoryTalk-Optix/Optix_Sample_AlarmEventsObserver) | 0 | Alarm event subscription | Real-time event capture |
| P0 | [Optix_Sample_AcknowledgeAndConfirmMultipleAlarms](https://github.com/FactoryTalk-Optix/Optix_Sample_AcknowledgeAndConfirmMultipleAlarms) | 2 | Alarm acknowledgment | Acknowledgement events |
| P1 | [Optix_Sample_AlarmsToFrigateRecording](https://github.com/FactoryTalk-Optix/Optix_Sample_AlarmsToFrigateRecording) | 0 | Alarm correlation | Video/event correlation |
| P1 | [Optix_Sample_ParetoAlarmChart](https://github.com/FactoryTalk-Optix/Optix_Sample_ParetoAlarmChart) | 1 | Alarm analytics | Alarm insights dashboard |
| P2 | [Training_AlarmsWithArea](https://github.com/FactoryTalk-Optix/Training_AlarmsWithArea) | 0 | Area-based alarms | Hierarchical alarm routing |
| P2 | [Training_AlarmsBasic](https://github.com/FactoryTalk-Optix/Training_AlarmsBasic) | 0 | Alarm fundamentals | Foundation concepts |

---

### Path 7: Recipes & Production (CFR21/GxP Compliance)
Recipe management with audit trail for regulated industries.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [Optix_Sample_RecipesWithAudit](https://github.com/FactoryTalk-Optix/Optix_Sample_RecipesWithAudit) | 1 | CFR21-like auditing | Compliance event trail |
| P1 | [Training_Recipes](https://github.com/FactoryTalk-Optix/Training_Recipes) | 0 | Recipe fundamentals | Recipe schema design |
| P1 | [nested_recipes_example](https://github.com/FactoryTalk-Optix/nested_recipes_example) | 0 | Complex recipes | Hierarchical recipes |
| P1 | [Optix_Sample_MultipleRecipesSameControls](https://github.com/FactoryTalk-Optix/Optix_Sample_MultipleRecipesSameControls) | 1 | Multi-recipe UI | Flexible recipe management |

---

### Path 8: Authentication & Security
Role-based access control aligned with 0xSCADA user model.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [Optix_Sample_TwoFactorsAuthentication](https://github.com/FactoryTalk-Optix/Optix_Sample_TwoFactorsAuthentication) | 0 | MFA/2FA implementation | Security hardening |
| P0 | [Optix_Sample_AdvancedUsersManagement](https://github.com/FactoryTalk-Optix/Optix_Sample_AdvancedUsersManagement) | 1 | Advanced user mgmt | RBAC alignment |
| P1 | [Optix_Sample_UsersLevelsManagement](https://github.com/FactoryTalk-Optix/Optix_Sample_UsersLevelsManagement) | 1 | Access levels | Privilege escalation control |
| P1 | [Optix_Sample_AssignRolesToGroupsAtRuntime](https://github.com/FactoryTalk-Optix/Optix_Sample_AssignRolesToGroupsAtRuntime) | 0 | Runtime role assignment | Dynamic permissions |
| P1 | [Login_By_RFID](https://github.com/FactoryTalk-Optix/Login_By_RFID) | 1 | RFID authentication | Physical access integration |
| P2 | [Training_Users](https://github.com/FactoryTalk-Optix/Training_Users) | 0 | User/group fundamentals | Foundation concepts |

---

### Path 9: Monitoring & Observability
Metrics export for 0xSCADA's observability stack.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [Optix_Sample_PrometheusMetricsExporter](https://github.com/FactoryTalk-Optix/Optix_Sample_PrometheusMetricsExporter) | 0 | Prometheus metrics | Grafana dashboards |
| P1 | [Training_Trends](https://github.com/FactoryTalk-Optix/Training_Trends) | 0 | Trend visualization | Historical data display |
| P1 | [Training_Loggers](https://github.com/FactoryTalk-Optix/Training_Loggers) | 0 | Data logging | Variable sampling |
| P1 | [Optix_Sample_DataAggregatorDashboard](https://github.com/FactoryTalk-Optix/Optix_Sample_DataAggregatorDashboard) | 2 | Data aggregation | Multi-site dashboards |

---

### Path 10: Edge & Containerization
Docker deployment for 0xSCADA edge architecture.

| Priority | Repository | Stars | Purpose | 0xSCADA Integration |
|----------|-----------|-------|---------|---------------------|
| P0 | [Optix_Docker_FTOptixUpdateServer](https://github.com/FactoryTalk-Optix/Optix_Docker_FTOptixUpdateServer) | 22 | Docker containers | Containerized deployment |
| P0 | [OptixEdge_WizardApp](https://github.com/FactoryTalk-Optix/OptixEdge_WizardApp) | 7 | Edge module source | Edge device integration |
| P1 | [Optix_Sample_WebPresentationEngineSessions](https://github.com/FactoryTalk-Optix/Optix_Sample_WebPresentationEngineSessions) | 2 | Web presentation | Browser-based HMI |

---

## Implementation Priority Matrix

### Phase 1: Core Integration (Weeks 1-4)
1. **NetLogic Foundation** - CheatSheet + Runtime/DesignTime training
2. **OPC UA Gateway** - ArbitraryOpcUaRead + BoilerDemo_Client
3. **Database Layer** - PostgreSQL + StoredProcedures patterns
4. **Alarm Events** - CustomAlarmsManagement + AlarmEventsObserver

### Phase 2: IoT & Cloud (Weeks 5-8)
5. **Azure IoT** - AzureIoTOperations sample
6. **MQTT Layer** - Custom payloads + Store-and-forward
7. **REST APIs** - REST_WEB_WS_Server integration
8. **Prometheus** - Metrics exporter for observability

### Phase 3: Advanced Features (Weeks 9-12)
9. **Security** - 2FA + Advanced user management
10. **Recipes** - CFR21 audit trail recipes
11. **Edge Deployment** - Docker + OptixEdge
12. **AI Integration** - ChatGPT REST pattern for agents

---

## GitHub Issues to Create

Each learning path will have:
1. **Research Issue** - Explore and document the repository
2. **Integration Issue** - Implement 0xSCADA integration
3. **Test Issue** - Create integration tests per CLAUDE.md integrity rules

Total: 30 repositories x 3 issue types = ~90 issues (prioritized to ~30 key issues)
