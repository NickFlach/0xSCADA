# Modbus TCP/RTU Protocol Driver

## Overview

The Modbus driver (`server/gateway/modbus-driver.ts`) provides TCP connectivity to Modbus devices. It supports all four register types, subscriptions with deadband filtering, and automatic reconnection.

## Supported Register Types

| Prefix | Type | Read | Write |
|--------|------|------|-------|
| `HR:` / `HOLDING:` | Holding Register | ✅ | ✅ |
| `IR:` / `INPUT:` | Input Register | ✅ | ❌ |
| `C:` / `COIL:` | Coil | ✅ | ✅ |
| `DI:` / `DISCRETE:` | Discrete Input | ✅ | ❌ |

Standard Modbus addressing (40001, 30001, etc.) is also supported.

## Usage

```typescript
import { createModbusDriver } from '../server/gateway/modbus-driver';

const driver = createModbusDriver('192.168.1.100', 502, 1);
await driver.connect();

// Read a single tag
const value = await driver.readTag('HR:100');

// Write
await driver.writeTag('HR:100', 42);

// Subscribe with polling
driver.subscribe(
  [{ name: 'temp', address: 'HR:100', scanRate: 1000, unit: '°C' }],
  (values) => console.log(values)
);

await driver.disconnect();
```

## Configuration

```typescript
{
  host: '192.168.1.100',
  port: 502,         // Default Modbus TCP port
  unitId: 1,         // Modbus slave ID
  timeout: 5000,     // Request timeout (ms)
  retryCount: 3,     // Reconnection attempts
  retryDelay: 1000,  // Delay between retries (ms)
}
```

## Error Handling

- **Connection loss**: Automatic reconnection with configurable retries
- **Read errors**: Returns `quality: 'BAD'` instead of throwing
- **Write errors**: Returns `false` on failure

## RTU Support

The driver uses `modbus-serial` which supports both TCP and RTU. For RTU over serial:

```typescript
// RTU connections use the same ModbusRTU client
// Connect via serial port instead of TCP
client.connectRTUBuffered('/dev/ttyUSB0', { baudRate: 9600 });
```

## Testing

Tests are located at `server/gateway/__tests__/modbus-driver.test.ts`.
