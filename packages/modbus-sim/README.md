# @oxscada/modbus-sim

Modbus TCP simulator for OxSCADA development and testing.

**VS-1.1** - Vertical Slice: Modbus TCP Simulator

## Features

- Full Modbus TCP server implementation
- Coils, Discrete Inputs, Input Registers, Holding Registers
- Tag binding with scaling/offset
- Process simulation (tank physics)
- Event callbacks for monitoring

## Quick Start

```bash
cd packages/modbus-sim
npm install
npm run dev
```

The simulator starts on port 5020 with three simulated tanks.

## Usage

```typescript
import { createModbusSimulator } from "@oxscada/modbus-sim";

const sim = createModbusSimulator({ port: 5020 });

// Add a tank
sim.addTank({
  id: "TK-101",
  level: { name: "Level", value: 75.0, unit: "%", min: 0, max: 100 },
  temperature: { name: "Temperature", value: 45.2, unit: "°C", min: 0, max: 100 },
  inflow: 0.5,
  outflow: 0.3,
  capacity: 10000,
});

// Start server and simulation
await sim.start();
sim.startSimulation(100); // 100ms tick

// Read tag values
const level = sim.getTagValue("TK-101.Level"); // 75.0

// Control simulation
sim.setTankInflow("TK-101", 1.0);  // Increase inflow
sim.setTankOutflow("TK-101", 0.2); // Decrease outflow
```

## Register Map

| Tag | Register Type | Address | Scale |
|-----|--------------|---------|-------|
| TK-101.Level | Input Register | 10 | 0.1 |
| TK-101.Temperature | Input Register | 11 | 0.1 |
| TK-102.Level | Input Register | 20 | 0.1 |
| TK-102.Temperature | Input Register | 21 | 0.1 |
| TK-103.Level | Input Register | 30 | 0.1 |
| TK-103.Temperature | Input Register | 31 | 0.1 |

## API

### `createModbusSimulator(config?)`

Create a new simulator instance.

### `simulator.start()`

Start the Modbus TCP server.

### `simulator.stop()`

Stop the server and simulation.

### `simulator.bindTag(binding)`

Bind a tag name to a register address.

### `simulator.addTank(tank)`

Add a simulated tank with auto-bound tags.

### `simulator.startSimulation(tickMs)`

Start process simulation with specified tick interval.

### `simulator.onEvent(callback)`

Register callback for read/write events.

## Testing with Modbus Clients

```bash
# Using modpoll (if installed)
modpoll -m tcp -a 1 -r 10 -c 2 localhost:5020

# Or use any Modbus TCP client tool
```
