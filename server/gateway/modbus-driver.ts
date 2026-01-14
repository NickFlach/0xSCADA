/**
 * Real Modbus TCP Driver
 *
 * VS-1.2 - Vertical Slice: Gateway Modbus Driver
 *
 * Connects to Modbus TCP devices (including @oxscada/modbus-sim)
 * and provides real data polling and subscriptions.
 */

import ModbusRTU from "modbus-serial";
import type { ProtocolDriver, TagDefinition, TagValue } from "./index";

// =============================================================================
// TYPES
// =============================================================================

export interface ModbusDriverConfig {
  host: string;
  port: number;
  unitId: number;
  timeout: number;
  retryCount: number;
  retryDelay: number;
}

export type ModbusRegisterType = "coil" | "discrete" | "input" | "holding";

export interface ModbusAddress {
  type: ModbusRegisterType;
  address: number;
  length?: number; // For string/array reads
}

// =============================================================================
// ADDRESS PARSER
// =============================================================================

/**
 * Parse Modbus address string
 * Formats:
 *   "HR:100"  -> Holding Register 100
 *   "IR:50"   -> Input Register 50
 *   "C:0"     -> Coil 0
 *   "DI:10"   -> Discrete Input 10
 *   "40001"   -> Modbus standard (4xxxx = holding)
 */
export function parseModbusAddress(address: string): ModbusAddress {
  // Format: TYPE:ADDRESS
  if (address.includes(":")) {
    const [type, addr] = address.split(":");
    const addressNum = parseInt(addr, 10);

    switch (type.toUpperCase()) {
      case "HR":
      case "HOLDING":
        return { type: "holding", address: addressNum };
      case "IR":
      case "INPUT":
        return { type: "input", address: addressNum };
      case "C":
      case "COIL":
        return { type: "coil", address: addressNum };
      case "DI":
      case "DISCRETE":
        return { type: "discrete", address: addressNum };
      default:
        throw new Error(`Unknown register type: ${type}`);
    }
  }

  // Modbus standard addressing (0xxxx, 1xxxx, 3xxxx, 4xxxx)
  const num = parseInt(address, 10);
  if (num >= 40001 && num <= 49999) {
    return { type: "holding", address: num - 40001 };
  } else if (num >= 30001 && num <= 39999) {
    return { type: "input", address: num - 30001 };
  } else if (num >= 10001 && num <= 19999) {
    return { type: "discrete", address: num - 10001 };
  } else if (num >= 1 && num <= 9999) {
    return { type: "coil", address: num - 1 };
  }

  throw new Error(`Invalid Modbus address: ${address}`);
}

// =============================================================================
// REAL MODBUS TCP DRIVER
// =============================================================================

export class RealModbusTcpDriver implements ProtocolDriver {
  protocol = "MODBUS_TCP" as const;

  private client: ModbusRTU;
  private config: ModbusDriverConfig;
  private connected = false;
  private reconnecting = false;
  private subscriptionCallback?: (values: TagValue[]) => void;
  private subscriptionInterval?: NodeJS.Timeout;
  private subscribedTags: TagDefinition[] = [];
  private lastValues: Map<string, TagValue> = new Map();

  constructor(config: Partial<ModbusDriverConfig> & { host: string }) {
    this.config = {
      port: 502,
      unitId: 1,
      timeout: 5000,
      retryCount: 3,
      retryDelay: 1000,
      ...config,
    };

    this.client = new ModbusRTU();
    this.client.setTimeout(this.config.timeout);
  }

  // ===========================================================================
  // CONNECTION
  // ===========================================================================

  async connect(): Promise<void> {
    console.log(`[Modbus] Connecting to ${this.config.host}:${this.config.port}...`);

    try {
      await this.client.connectTCP(this.config.host, { port: this.config.port });
      this.client.setID(this.config.unitId);
      this.connected = true;
      console.log(`[Modbus] Connected to ${this.config.host}:${this.config.port}`);
    } catch (error) {
      console.error(`[Modbus] Connection failed:`, error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.unsubscribe();
    if (this.connected) {
      this.client.close(() => {
        console.log(`[Modbus] Disconnected`);
      });
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    for (let i = 0; i < this.config.retryCount; i++) {
      try {
        console.log(`[Modbus] Reconnect attempt ${i + 1}/${this.config.retryCount}...`);
        await this.connect();
        this.reconnecting = false;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, this.config.retryDelay));
      }
    }

    this.reconnecting = false;
    console.error(`[Modbus] Failed to reconnect after ${this.config.retryCount} attempts`);
  }

  // ===========================================================================
  // READ OPERATIONS
  // ===========================================================================

  async readTag(address: string): Promise<TagValue> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    const parsed = parseModbusAddress(address);
    let value: number | boolean;

    try {
      switch (parsed.type) {
        case "holding": {
          const result = await this.client.readHoldingRegisters(parsed.address, 1);
          value = result.data[0];
          break;
        }
        case "input": {
          const result = await this.client.readInputRegisters(parsed.address, 1);
          value = result.data[0];
          break;
        }
        case "coil": {
          const result = await this.client.readCoils(parsed.address, 1);
          value = result.data[0];
          break;
        }
        case "discrete": {
          const result = await this.client.readDiscreteInputs(parsed.address, 1);
          value = result.data[0];
          break;
        }
      }

      return {
        tag: address,
        value,
        quality: "GOOD",
        timestamp: new Date(),
      };
    } catch (error) {
      console.error(`[Modbus] Read error for ${address}:`, error);

      // Try to reconnect on connection errors
      if (!this.connected) {
        this.reconnect();
      }

      return {
        tag: address,
        value: 0,
        quality: "BAD",
        timestamp: new Date(),
      };
    }
  }

  async readTags(addresses: string[]): Promise<TagValue[]> {
    const results: TagValue[] = [];

    for (const address of addresses) {
      const result = await this.readTag(address);
      results.push(result);
    }

    return results;
  }

  /**
   * Read multiple holding registers in one request (optimized)
   */
  async readHoldingRegisters(startAddress: number, count: number): Promise<number[]> {
    if (!this.connected) throw new Error("Not connected");

    const result = await this.client.readHoldingRegisters(startAddress, count);
    return result.data;
  }

  /**
   * Read multiple input registers in one request (optimized)
   */
  async readInputRegisters(startAddress: number, count: number): Promise<number[]> {
    if (!this.connected) throw new Error("Not connected");

    const result = await this.client.readInputRegisters(startAddress, count);
    return result.data;
  }

  // ===========================================================================
  // WRITE OPERATIONS
  // ===========================================================================

  async writeTag(address: string, value: number | string | boolean): Promise<boolean> {
    if (!this.connected) throw new Error("Not connected");

    const parsed = parseModbusAddress(address);

    try {
      switch (parsed.type) {
        case "holding":
          await this.client.writeRegister(parsed.address, Number(value));
          break;
        case "coil":
          await this.client.writeCoil(parsed.address, Boolean(value));
          break;
        default:
          throw new Error(`Cannot write to ${parsed.type} registers`);
      }

      console.log(`[Modbus] Write ${address} = ${value}`);
      return true;
    } catch (error) {
      console.error(`[Modbus] Write error for ${address}:`, error);
      return false;
    }
  }

  // ===========================================================================
  // SUBSCRIPTIONS
  // ===========================================================================

  subscribe(tags: TagDefinition[], callback: (values: TagValue[]) => void): void {
    this.subscribedTags = tags;
    this.subscriptionCallback = callback;

    // Find minimum scan rate
    const minScanRate = Math.min(...tags.map((t) => t.scanRate), 1000);

    console.log(`[Modbus] Subscribing to ${tags.length} tags (scan rate: ${minScanRate}ms)`);

    this.subscriptionInterval = setInterval(async () => {
      if (!this.connected || !this.subscriptionCallback) return;

      try {
        const values: TagValue[] = [];

        for (const tag of this.subscribedTags) {
          const result = await this.readTag(tag.address);

          // Apply scaling if configured
          let scaledValue = result.value;
          if (typeof scaledValue === "number" && tag.name.includes(".")) {
            // Check for scaling in tag metadata (could be extended)
          }

          const tagValue: TagValue = {
            tag: tag.name,
            value: scaledValue,
            quality: result.quality,
            timestamp: result.timestamp,
            assetId: tag.assetId,
            unit: tag.unit,
          };

          // Check deadband
          const lastValue = this.lastValues.get(tag.name);
          if (lastValue && tag.deadband && typeof tagValue.value === "number" && typeof lastValue.value === "number") {
            if (Math.abs(tagValue.value - lastValue.value) < tag.deadband) {
              continue; // Skip - within deadband
            }
          }

          this.lastValues.set(tag.name, tagValue);
          values.push(tagValue);
        }

        if (values.length > 0) {
          this.subscriptionCallback(values);
        }
      } catch (error) {
        console.error(`[Modbus] Subscription poll error:`, error);
      }
    }, minScanRate);
  }

  unsubscribe(): void {
    if (this.subscriptionInterval) {
      clearInterval(this.subscriptionInterval);
      this.subscriptionInterval = undefined;
    }
    this.subscriptionCallback = undefined;
    this.subscribedTags = [];
    console.log(`[Modbus] Unsubscribed`);
  }

  // ===========================================================================
  // STATUS
  // ===========================================================================

  getStatus(): Record<string, unknown> {
    return {
      protocol: this.protocol,
      host: this.config.host,
      port: this.config.port,
      unitId: this.config.unitId,
      connected: this.connected,
      subscribedTags: this.subscribedTags.length,
      reconnecting: this.reconnecting,
    };
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createModbusDriver(
  host: string,
  port: number = 502,
  unitId: number = 1
): RealModbusTcpDriver {
  return new RealModbusTcpDriver({ host, port, unitId });
}
