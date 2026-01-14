/**
 * @oxscada/modbus-sim
 *
 * Modbus TCP simulator for OxSCADA development and testing.
 *
 * VS-1.1 - Vertical Slice: Modbus TCP Simulator
 */

export * from "./types";
export * from "./server";

// Quick start example
import { createModbusSimulator, type TankModel } from "./server";

if (require.main === module) {
  // Run as standalone server
  const sim = createModbusSimulator({ port: 5020 }); // Use 5020 to avoid privileged port

  // Add simulated tanks
  const tank101: TankModel = {
    id: "TK-101",
    level: { name: "Level", value: 75.0, unit: "%", min: 0, max: 100 },
    temperature: { name: "Temperature", value: 45.2, unit: "°C", min: 0, max: 100 },
    inflow: 0.5,
    outflow: 0.3,
    capacity: 10000,
  };

  const tank102: TankModel = {
    id: "TK-102",
    level: { name: "Level", value: 23.1, unit: "%", min: 0, max: 100 },
    temperature: { name: "Temperature", value: 38.7, unit: "°C", min: 0, max: 100 },
    inflow: 0.2,
    outflow: 0.4,
    capacity: 10000,
  };

  const tank103: TankModel = {
    id: "TK-103",
    level: { name: "Level", value: 98.4, unit: "%", min: 0, max: 100 },
    temperature: { name: "Temperature", value: 52.1, unit: "°C", min: 0, max: 100 },
    inflow: 0.1,
    outflow: 0.05,
    capacity: 10000,
  };

  sim.addTank(tank101);
  sim.addTank(tank102);
  sim.addTank(tank103);

  // Log events
  sim.onEvent((event) => {
    console.log(`[Event] ${event.type} ${event.registerType}[${event.address}]`);
  });

  // Start server and simulation
  sim.start().then(() => {
    sim.startSimulation(100);
    console.log("\nModbus Simulator running. Press Ctrl+C to stop.\n");
    console.log("Register Map:");
    console.log("  TK-101.Level       -> Input Register 10 (scaled x0.1)");
    console.log("  TK-101.Temperature -> Input Register 11 (scaled x0.1)");
    console.log("  TK-102.Level       -> Input Register 20 (scaled x0.1)");
    console.log("  TK-102.Temperature -> Input Register 21 (scaled x0.1)");
    console.log("  TK-103.Level       -> Input Register 30 (scaled x0.1)");
    console.log("  TK-103.Temperature -> Input Register 31 (scaled x0.1)");
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    sim.stop();
    process.exit(0);
  });
}
