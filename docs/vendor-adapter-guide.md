# 0xSCADA Vendor Adapter Development Guide

## Philosophy: Vendor Adaptable, Not Just Agnostic

0xSCADA is **vendor adaptable** — not merely vendor agnostic. The difference matters:

| Vendor Agnostic | Vendor Adaptable |
|---|---|
| Lowest common denominator | Full vendor capability exposure |
| Ignores vendor strengths | Vendors differentiate on quality |
| One-size-fits-all | Adapters extend the platform |
| Generic only | Specific + generic coexist |

Vendors **plug in and extend** 0xSCADA. A Siemens adapter can expose S7 diagnostics, block transfers, and LED status. A Rockwell adapter can expose CIP-specific tag browsing and fault logs. These vendor-specific capabilities are first-class citizens — not hidden behind abstraction.

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│                  0xSCADA Platform                 │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │           Adapter Manager                 │    │
│  │  • Lifecycle (init → ready → connected)   │    │
│  │  • Health monitoring                      │    │
│  │  • Hot-reload                             │    │
│  └──────────────┬───────────────────────────┘    │
│                 │                                 │
│  ┌──────────────┴───────────────────────────┐    │
│  │           Adapter Registry                │    │
│  │  • Register / Unregister                  │    │
│  │  • Lookup by ID, type, capability         │    │
│  └──────────────┬───────────────────────────┘    │
│                 │                                 │
│  ┌──────────┬───┴───────┬──────────────┐         │
│  │ Protocol │  Device   │   Feature    │         │
│  │ Adapters │  Adapters │   Adapters   │         │
│  └──────────┴───────────┴──────────────┘         │
└──────────────────────────────────────────────────┘
```

### Three Adapter Types

1. **Protocol Adapter** — Communication protocol (Modbus, S7, CIP, OPC-UA)
   - Connects to endpoints, reads/writes tags, discovers devices
2. **Device Adapter** — Device-specific features (diagnostics, firmware, config)
   - Exposes vendor-unique capabilities per device family
3. **Feature Adapter** — Cross-cutting capabilities (historian, analytics)
   - Extends platform with optional features

A single class can implement multiple adapter interfaces (e.g., Siemens S7 is both Protocol + Device).

## Quick Start: Creating an Adapter

### 1. Define Your Manifest

```typescript
import type {
  AdapterManifest,
  AdapterCapability,
  ProtocolAdapter,
  AdapterState,
  AdapterContext,
  AdapterHealthStatus,
  ProtocolEndpoint,
  ProtocolConnection,
} from "../../shared/types/vendor-adapter";

const MY_CAPABILITIES: AdapterCapability[] = [
  {
    id: "read-tags",
    name: "Tag Reading",
    category: "communication",
    required: true,
  },
  {
    id: "my-vendor-feature",
    name: "Special Vendor Feature",
    category: "custom",
    description: "Something only your hardware can do",
    required: false,
  },
];
```

### 2. Implement the Adapter

```typescript
export class MyVendorAdapter implements ProtocolAdapter {
  readonly manifest: AdapterManifest & { type: "protocol" } = {
    id: "my-vendor-protocol",
    name: "My Vendor Protocol Adapter",
    vendor: "My Company",
    version: "1.0.0",
    type: "protocol",
    capabilities: MY_CAPABILITIES,
  };

  readonly protocols = ["my-protocol"];
  private _state: AdapterState = "registered";
  private context: AdapterContext | null = null;
  private startTime = Date.now();

  get state() { return this._state; }

  async initialize(context: AdapterContext): Promise<void> {
    this.context = context;
    this._state = "initializing";
    
    // Load native libraries, validate config, etc.
    const host = context.config.defaultHost as string;
    context.log.info(`Initializing with default host: ${host}`);
    
    this._state = "ready";
    this.startTime = Date.now();
  }

  hasCapability(id: string): boolean {
    return this.manifest.capabilities.some((c) => c.id === id);
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    return {
      adapterId: this.manifest.id,
      state: this._state,
      healthy: this._state === "ready" || this._state === "connected",
      lastHealthCheck: new Date(),
      uptime: Date.now() - this.startTime,
      errorCount: 0,
    };
  }

  async dispose(): Promise<void> {
    this._state = "disposed";
  }

  async connect(endpoint: ProtocolEndpoint): Promise<ProtocolConnection> {
    // Your connection logic here
    throw new Error("Implement connect()");
  }
}
```

### 3. Register with the Platform

```typescript
import { getAdapterManager } from "../adapters/adapter-manager";
import { MyVendorAdapter } from "./my-vendor-adapter";

const manager = getAdapterManager({
  adapterConfigs: {
    "my-vendor-protocol": {
      defaultHost: "192.168.1.100",
    },
  },
});

await manager.registerAdapter(new MyVendorAdapter());
```

### 4. Certify Your Adapter

```typescript
import { AdapterCertification } from "../adapters/adapter-certification";

const result = await AdapterCertification.certify(new MyVendorAdapter());
console.log(`Passed: ${result.passedTests}/${result.totalTests}`);

if (!result.passed) {
  for (const test of result.results.filter(r => !r.passed)) {
    console.error(`FAIL: ${test.name} — ${test.message}`);
  }
}
```

## Adapter Lifecycle

```
registered → initializing → ready → connected → disconnecting → disposed
                              ↑         ↓
                              └── error ←┘
```

| State | Description |
|---|---|
| `registered` | Adapter class instantiated, registered in registry |
| `initializing` | `initialize()` in progress |
| `ready` | Initialized, ready to accept connections |
| `connected` | Has active connections to devices |
| `error` | Encountered an error (can recover to `ready`) |
| `disconnecting` | Shutting down connections |
| `disposed` | Fully shut down, cannot be reused |

## Capability Declaration

Capabilities let the platform (and other adapters) discover what features are available:

```typescript
const capabilities: AdapterCapability[] = [
  {
    id: "read-tags",          // Machine-readable ID
    name: "Tag Reading",       // Human-readable name
    category: "communication", // Grouping category
    required: true,            // Is this core to the adapter?
    description: "...",        // What it does
    configSchema: {            // Optional JSON Schema for config
      type: "object",
      properties: {
        pollInterval: { type: "number", default: 1000 },
      },
    },
  },
];
```

### Standard Capability IDs

Use these for interoperability:

| ID | Category | Description |
|---|---|---|
| `read-tags` | communication | Read process values |
| `write-tags` | communication | Write process values |
| `device-discovery` | discovery | Find devices on network |
| `diagnostics` | diagnostics | Device health/status |
| `firmware-info` | firmware | Read firmware version |
| `firmware-update` | firmware | Update device firmware |
| `tag-browsing` | configuration | Browse available tags |
| `block-transfer` | configuration | Upload/download programs |

Custom capabilities use vendor-prefixed IDs: `siemens:led-status`, `rockwell:fault-log`.

## Platform Context

Every adapter receives an `AdapterContext` during initialization:

```typescript
interface AdapterContext {
  log: AdapterLogger;                    // Structured logging
  config: Record<string, unknown>;       // Per-adapter config
  emit: (event: string, data) => void;   // Event bus
  platform: PlatformServices;            // Platform APIs
}
```

### Platform Services

```typescript
// Get another adapter
const modbusAdapter = context.platform.getAdapter("generic-modbus");

// Find all protocol adapters
const protocols = context.platform.getAdaptersByType("protocol");

// Persist adapter state (survives restarts)
const storage = context.platform.getStorage("my-adapter");
await storage.set("lastScan", new Date().toISOString());
const last = await storage.get<string>("lastScan");
```

## Hot-Reload

Adapters can be reloaded at runtime without restarting the platform:

```typescript
const manager = getAdapterManager();

// Replace with updated adapter (dispose old, register new)
await manager.reloadAdapter(new MyVendorAdapter());
```

## Wrapping Existing Drivers

See `server/adapters/vendors/generic-modbus.ts` for a reference implementation that wraps the existing `server/gateway/modbus-driver.ts`.

Pattern:
1. Create adapter class implementing `ProtocolAdapter`
2. In `connect()`, instantiate the legacy driver
3. In the connection's `read()`/`write()`, delegate to the legacy driver
4. In `disconnect()`, clean up the legacy driver

## Testing

Run the test suite:

```bash
npx vitest run server/__tests__/vendor-adapter.test.ts
```

Use the certification suite for validation:

```typescript
import { AdapterCertification } from "../adapters/adapter-certification";

const result = await AdapterCertification.certify(myAdapter);
assert(result.passed, "Adapter must pass certification");
```

## Reference Adapters

| Adapter | File | Type | Protocols |
|---|---|---|---|
| Siemens S7 | `server/adapters/vendors/siemens-s7.ts` | Protocol + Device | S7comm, S7comm+ |
| Rockwell CIP | `server/adapters/vendors/rockwell-cip.ts` | Protocol + Device | CIP, EtherNet/IP |
| Generic Modbus | `server/adapters/vendors/generic-modbus.ts` | Protocol | Modbus TCP |

These are simulated reference implementations. For production, replace the simulated connections with real protocol libraries (snap7, ethernet-ip, modbus-serial, etc.).
