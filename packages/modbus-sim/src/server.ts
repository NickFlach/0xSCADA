/**
 * Modbus TCP Simulator Server
 *
 * VS-1.1 - Vertical Slice: Modbus TCP Simulator
 *
 * Provides a simulated Modbus TCP server for development and testing
 * without requiring physical PLC hardware.
 */

import ModbusRTU from "modbus-serial";
import type {
  ModbusSimConfig,
  TagBinding,
  RegisterType,
  ModbusEvent,
  EventCallback,
  TankModel,
} from "./types";

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

const DEFAULT_CONFIG: ModbusSimConfig = {
  port: 502,
  unitId: 1,
  coilCount: 1000,
  discreteInputCount: 1000,
  inputRegisterCount: 1000,
  holdingRegisterCount: 1000,
};

// =============================================================================
// MODBUS SIMULATOR CLASS
// =============================================================================

export class ModbusSimulator {
  private config: ModbusSimConfig;
  private server: ModbusRTU.ServerTCP | null = null;

  // Register banks
  private coils: boolean[];
  private discreteInputs: boolean[];
  private inputRegisters: number[];
  private holdingRegisters: number[];

  // Tag bindings
  private tagBindings: Map<string, TagBinding> = new Map();

  // Event callbacks
  private eventCallbacks: EventCallback[] = [];

  // Process simulation
  private tanks: Map<string, TankModel> = new Map();
  private simulationInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<ModbusSimConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize register banks
    this.coils = new Array(this.config.coilCount).fill(false);
    this.discreteInputs = new Array(this.config.discreteInputCount).fill(false);
    this.inputRegisters = new Array(this.config.inputRegisterCount).fill(0);
    this.holdingRegisters = new Array(this.config.holdingRegisterCount).fill(0);
  }

  // ===========================================================================
  // SERVER LIFECYCLE
  // ===========================================================================

  async start(): Promise<void> {
    const vector = {
      getInputRegister: (addr: number) => {
        this.emitEvent({ type: "read", registerType: "inputRegister", address: addr, quantity: 1, timestamp: new Date() });
        return this.inputRegisters[addr] ?? 0;
      },
      getHoldingRegister: (addr: number) => {
        this.emitEvent({ type: "read", registerType: "holdingRegister", address: addr, quantity: 1, timestamp: new Date() });
        return this.holdingRegisters[addr] ?? 0;
      },
      getCoil: (addr: number) => {
        this.emitEvent({ type: "read", registerType: "coil", address: addr, quantity: 1, timestamp: new Date() });
        return this.coils[addr] ?? false;
      },
      getDiscreteInput: (addr: number) => {
        this.emitEvent({ type: "read", registerType: "discreteInput", address: addr, quantity: 1, timestamp: new Date() });
        return this.discreteInputs[addr] ?? false;
      },
      setRegister: (addr: number, value: number) => {
        this.holdingRegisters[addr] = value;
        this.emitEvent({ type: "write", registerType: "holdingRegister", address: addr, values: [value], timestamp: new Date() });
      },
      setCoil: (addr: number, value: boolean) => {
        this.coils[addr] = value;
        this.emitEvent({ type: "write", registerType: "coil", address: addr, values: [value], timestamp: new Date() });
      },
    };

    this.server = new ModbusRTU.ServerTCP(vector, {
      host: "0.0.0.0",
      port: this.config.port,
      unitID: this.config.unitId,
    });

    console.log(`[ModbusSim] Server started on port ${this.config.port}`);
  }

  stop(): void {
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
    if (this.server) {
      this.server.close(() => {
        console.log("[ModbusSim] Server stopped");
      });
      this.server = null;
    }
  }

  // ===========================================================================
  // TAG BINDING
  // ===========================================================================

  bindTag(binding: TagBinding): void {
    this.tagBindings.set(binding.tag, binding);
    console.log(`[ModbusSim] Bound tag ${binding.tag} to ${binding.registerType}[${binding.address}]`);
  }

  unbindTag(tag: string): void {
    this.tagBindings.delete(tag);
  }

  getTagValue(tag: string): number | boolean | null {
    const binding = this.tagBindings.get(tag);
    if (!binding) return null;

    let rawValue: number | boolean;
    switch (binding.registerType) {
      case "coil":
        rawValue = this.coils[binding.address];
        break;
      case "discreteInput":
        rawValue = this.discreteInputs[binding.address];
        break;
      case "inputRegister":
        rawValue = this.inputRegisters[binding.address];
        break;
      case "holdingRegister":
        rawValue = this.holdingRegisters[binding.address];
        break;
    }

    if (typeof rawValue === "number" && binding.scale) {
      rawValue = rawValue * binding.scale + (binding.offset ?? 0);
    }

    return rawValue;
  }

  setTagValue(tag: string, value: number | boolean): void {
    const binding = this.tagBindings.get(tag);
    if (!binding) return;

    if (typeof value === "number" && binding.scale) {
      value = (value - (binding.offset ?? 0)) / binding.scale;
    }

    switch (binding.registerType) {
      case "coil":
        this.coils[binding.address] = Boolean(value);
        break;
      case "holdingRegister":
        this.holdingRegisters[binding.address] = Number(value);
        break;
      // discreteInput and inputRegister are read-only from client perspective
      // but can be set by simulator
      case "discreteInput":
        this.discreteInputs[binding.address] = Boolean(value);
        break;
      case "inputRegister":
        this.inputRegisters[binding.address] = Number(value);
        break;
    }
  }

  // ===========================================================================
  // DIRECT REGISTER ACCESS
  // ===========================================================================

  setHoldingRegister(address: number, value: number): void {
    this.holdingRegisters[address] = value;
  }

  getHoldingRegister(address: number): number {
    return this.holdingRegisters[address] ?? 0;
  }

  setInputRegister(address: number, value: number): void {
    this.inputRegisters[address] = value;
  }

  getInputRegister(address: number): number {
    return this.inputRegisters[address] ?? 0;
  }

  setCoil(address: number, value: boolean): void {
    this.coils[address] = value;
  }

  getCoil(address: number): boolean {
    return this.coils[address] ?? false;
  }

  setDiscreteInput(address: number, value: boolean): void {
    this.discreteInputs[address] = value;
  }

  getDiscreteInput(address: number): boolean {
    return this.discreteInputs[address] ?? false;
  }

  // ===========================================================================
  // PROCESS SIMULATION
  // ===========================================================================

  addTank(tank: TankModel): void {
    this.tanks.set(tank.id, tank);

    // Auto-bind tank tags to registers
    const baseAddr = this.tanks.size * 10;
    this.bindTag({ tag: `${tank.id}.Level`, registerType: "inputRegister", address: baseAddr, scale: 0.1 });
    this.bindTag({ tag: `${tank.id}.Temperature`, registerType: "inputRegister", address: baseAddr + 1, scale: 0.1 });

    // Initialize register values
    this.inputRegisters[baseAddr] = tank.level.value * 10;
    this.inputRegisters[baseAddr + 1] = tank.temperature.value * 10;

    console.log(`[ModbusSim] Added tank ${tank.id} at register base ${baseAddr}`);
  }

  startSimulation(tickMs: number = 100): void {
    if (this.simulationInterval) return;

    this.simulationInterval = setInterval(() => {
      const dt = tickMs / 1000; // Convert to seconds

      for (const [id, tank] of this.tanks) {
        // Simple tank physics: level changes based on inflow/outflow
        const volumeChange = (tank.inflow - tank.outflow) * dt;
        const levelChange = (volumeChange / tank.capacity) * 100;

        tank.level.value = Math.max(
          tank.level.min,
          Math.min(tank.level.max, tank.level.value + levelChange)
        );

        // Update registers
        const binding = this.tagBindings.get(`${id}.Level`);
        if (binding) {
          this.inputRegisters[binding.address] = Math.round(tank.level.value * 10);
        }
      }
    }, tickMs);

    console.log(`[ModbusSim] Simulation started (tick: ${tickMs}ms)`);
  }

  stopSimulation(): void {
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
      console.log("[ModbusSim] Simulation stopped");
    }
  }

  setTankInflow(tankId: string, rate: number): void {
    const tank = this.tanks.get(tankId);
    if (tank) tank.inflow = rate;
  }

  setTankOutflow(tankId: string, rate: number): void {
    const tank = this.tanks.get(tankId);
    if (tank) tank.outflow = rate;
  }

  // ===========================================================================
  // EVENTS
  // ===========================================================================

  onEvent(callback: EventCallback): void {
    this.eventCallbacks.push(callback);
  }

  private emitEvent(event: ModbusEvent): void {
    for (const callback of this.eventCallbacks) {
      callback(event);
    }
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export function createModbusSimulator(config?: Partial<ModbusSimConfig>): ModbusSimulator {
  return new ModbusSimulator(config);
}
