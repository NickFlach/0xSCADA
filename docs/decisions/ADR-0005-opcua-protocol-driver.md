# ADR-0005: OPC-UA as Primary Protocol Driver

## Status

Accepted

## Date

2024-01-25

## Context

SCADA systems must communicate with diverse industrial devices:
- PLCs (Programmable Logic Controllers)
- RTUs (Remote Terminal Units)
- Sensors and actuators
- HMIs (Human-Machine Interfaces)
- Historians and data loggers

The industrial automation landscape includes many legacy protocols:
- Modbus (RTU/TCP) - Simple but limited
- DNP3 - Utility-focused, complex
- Profinet/Profibus - Siemens ecosystem
- EtherNet/IP - Rockwell ecosystem
- BACnet - Building automation

We need a unifying protocol strategy that:
1. Supports modern security requirements
2. Provides semantic data modeling
3. Works across vendor ecosystems
4. Scales from field devices to enterprise

## Decision

We adopt **OPC-UA (Unified Architecture)** as the primary protocol driver:

1. **Protocol Hierarchy**:
   ```
   Application Layer: 0xSCADA Core
         ↓
   OPC-UA Client/Server
         ↓
   Protocol Adapters: Modbus, DNP3, etc. (legacy support)
         ↓
   Field Devices
   ```

2. **OPC-UA Features Used**:
   - **Information Modeling**: Semantic device descriptions
   - **Security**: X.509 certificates, encryption, signing
   - **Pub/Sub**: Efficient telemetry distribution
   - **Historical Access**: Built-in time-series queries
   - **Alarms & Conditions**: Standardized event handling

3. **Implementation**:
   - open62541 (C library) for embedded gateways
   - node-opcua (Node.js) for cloud connectors
   - Custom address space for 0xSCADA data model

4. **Legacy Protocol Support**:
   - OPC-UA wrappers for Modbus devices
   - Protocol translation gateways
   - Gradual migration path for brownfield sites

## Consequences

### Positive

- **Interoperability**: Vendor-neutral standard (IEC 62541)
- **Security-first**: Built-in authentication, encryption, authorization
- **Semantic richness**: Self-describing data models
- **Industry adoption**: Major vendors support OPC-UA
- **Future-proof**: Active development, Industry 4.0 aligned

### Negative

- **Complexity**: Steeper learning curve than Modbus
- **Resource requirements**: Higher memory/CPU than simple protocols
- **Legacy devices**: Older equipment needs protocol gateways
- **Implementation effort**: Larger codebase to maintain

### Neutral

- Becoming de facto standard for industrial IoT
- Good open-source implementations available
- Certification program ensures compliance

## Alternatives Considered

### Alternative 1: MQTT + Custom Protocol

Use MQTT as transport with custom payload format.

Rejected because: No standardized information model, security varies by broker, doesn't address device-level protocol diversity.

### Alternative 2: Modbus-Only

Standardize on Modbus TCP for all devices.

Rejected because: No security, limited data types, no semantic modeling, doesn't scale for complex systems.

### Alternative 3: Multi-Protocol with No Unification

Support all protocols natively without abstraction.

Rejected because: Exponential complexity, inconsistent security posture, harder to maintain.

### Alternative 4: Proprietary Solution

Use vendor-specific protocol (Siemens, Rockwell, etc.).

Rejected because: Vendor lock-in, licensing costs, limited to specific ecosystems.

## References

- [OPC Foundation](https://opcfoundation.org/)
- [IEC 62541 Standard](https://webstore.iec.ch/publication/25997)
- [open62541 Library](https://open62541.org/)
- [node-opcua Documentation](https://node-opcua.github.io/)
