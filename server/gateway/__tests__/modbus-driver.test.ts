/**
 * Modbus Driver Tests
 * Issue #48 — Tests for Modbus TCP/RTU protocol driver.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseModbusAddress, RealModbusTcpDriver } from '../modbus-driver';

// =============================================================================
// ADDRESS PARSER TESTS
// =============================================================================

describe('parseModbusAddress', () => {
  it('parses HR: prefix as holding register', () => {
    const result = parseModbusAddress('HR:100');
    expect(result).toEqual({ type: 'holding', address: 100 });
  });

  it('parses HOLDING: prefix', () => {
    const result = parseModbusAddress('HOLDING:50');
    expect(result).toEqual({ type: 'holding', address: 50 });
  });

  it('parses IR: prefix as input register', () => {
    const result = parseModbusAddress('IR:200');
    expect(result).toEqual({ type: 'input', address: 200 });
  });

  it('parses C: prefix as coil', () => {
    const result = parseModbusAddress('C:0');
    expect(result).toEqual({ type: 'coil', address: 0 });
  });

  it('parses DI: prefix as discrete input', () => {
    const result = parseModbusAddress('DI:10');
    expect(result).toEqual({ type: 'discrete', address: 10 });
  });

  it('parses standard Modbus address 40001 as holding register 0', () => {
    const result = parseModbusAddress('40001');
    expect(result).toEqual({ type: 'holding', address: 0 });
  });

  it('parses standard Modbus address 40100 as holding register 99', () => {
    const result = parseModbusAddress('40100');
    expect(result).toEqual({ type: 'holding', address: 99 });
  });

  it('parses standard Modbus address 30001 as input register 0', () => {
    const result = parseModbusAddress('30001');
    expect(result).toEqual({ type: 'input', address: 0 });
  });

  it('parses standard Modbus address 10001 as discrete input 0', () => {
    const result = parseModbusAddress('10001');
    expect(result).toEqual({ type: 'discrete', address: 0 });
  });

  it('parses standard Modbus address 1 as coil 0', () => {
    const result = parseModbusAddress('1');
    expect(result).toEqual({ type: 'coil', address: 0 });
  });

  it('throws for unknown prefix', () => {
    expect(() => parseModbusAddress('XX:100')).toThrow('Unknown register type');
  });

  it('throws for invalid standard address', () => {
    expect(() => parseModbusAddress('99999')).toThrow('Invalid Modbus address');
  });
});

// =============================================================================
// DRIVER TESTS (with mocked ModbusRTU)
// =============================================================================

// Mock modbus-serial
vi.mock('modbus-serial', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      connectTCP: vi.fn().mockResolvedValue(undefined),
      setID: vi.fn(),
      setTimeout: vi.fn(),
      close: vi.fn((cb?: () => void) => cb?.()),
      readHoldingRegisters: vi.fn().mockResolvedValue({ data: [42] }),
      readInputRegisters: vi.fn().mockResolvedValue({ data: [100] }),
      readCoils: vi.fn().mockResolvedValue({ data: [true] }),
      readDiscreteInputs: vi.fn().mockResolvedValue({ data: [false] }),
      writeRegister: vi.fn().mockResolvedValue(undefined),
      writeCoil: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

describe('RealModbusTcpDriver', () => {
  let driver: RealModbusTcpDriver;

  beforeEach(() => {
    driver = new RealModbusTcpDriver({ host: '127.0.0.1', port: 502 });
  });

  describe('connection', () => {
    it('connects successfully', async () => {
      await driver.connect();
      expect(driver.isConnected()).toBe(true);
    });

    it('disconnects successfully', async () => {
      await driver.connect();
      await driver.disconnect();
      expect(driver.isConnected()).toBe(false);
    });

    it('reports status', async () => {
      const status = driver.getStatus();
      expect(status.protocol).toBe('MODBUS_TCP');
      expect(status.host).toBe('127.0.0.1');
      expect(status.port).toBe(502);
    });
  });

  describe('reading', () => {
    beforeEach(async () => {
      await driver.connect();
    });

    it('reads holding register', async () => {
      const result = await driver.readTag('HR:100');
      expect(result.value).toBe(42);
      expect(result.quality).toBe('GOOD');
    });

    it('reads input register', async () => {
      const result = await driver.readTag('IR:50');
      expect(result.value).toBe(100);
      expect(result.quality).toBe('GOOD');
    });

    it('reads coil', async () => {
      const result = await driver.readTag('C:0');
      expect(result.value).toBe(true);
      expect(result.quality).toBe('GOOD');
    });

    it('reads discrete input', async () => {
      const result = await driver.readTag('DI:10');
      expect(result.value).toBe(false);
      expect(result.quality).toBe('GOOD');
    });

    it('reads multiple tags', async () => {
      const results = await driver.readTags(['HR:100', 'IR:50']);
      expect(results).toHaveLength(2);
    });

    it('reads bulk holding registers', async () => {
      const data = await driver.readHoldingRegisters(0, 10);
      expect(data).toEqual([42]);
    });

    it('throws when not connected', async () => {
      await driver.disconnect();
      await expect(driver.readTag('HR:0')).rejects.toThrow('Not connected');
    });
  });

  describe('writing', () => {
    beforeEach(async () => {
      await driver.connect();
    });

    it('writes holding register', async () => {
      const result = await driver.writeTag('HR:100', 99);
      expect(result).toBe(true);
    });

    it('writes coil', async () => {
      const result = await driver.writeTag('C:0', true);
      expect(result).toBe(true);
    });

    it('rejects write to input register', async () => {
      const result = await driver.writeTag('IR:0', 0);
      expect(result).toBe(false);
    });

    it('throws when not connected', async () => {
      await driver.disconnect();
      await expect(driver.writeTag('HR:0', 0)).rejects.toThrow('Not connected');
    });
  });

  describe('subscriptions', () => {
    beforeEach(async () => {
      await driver.connect();
    });

    it('subscribes to tags and receives callback', async () => {
      const callback = vi.fn();
      driver.subscribe(
        [{ name: 'test', address: 'HR:100', scanRate: 100, assetId: 'a1', unit: 'units' }],
        callback
      );

      // Wait for at least one poll
      await new Promise((r) => setTimeout(r, 200));
      driver.unsubscribe();

      expect(callback).toHaveBeenCalled();
    });

    it('unsubscribes cleanly', () => {
      const callback = vi.fn();
      driver.subscribe(
        [{ name: 'test', address: 'HR:100', scanRate: 100, assetId: 'a1', unit: 'units' }],
        callback
      );
      driver.unsubscribe();
      // No error = success
    });
  });
});
