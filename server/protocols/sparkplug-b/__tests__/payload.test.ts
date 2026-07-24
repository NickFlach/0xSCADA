/**
 * Tests for the Sparkplug B payload codec — pure metric mapping plus the
 * encode/decode wrapper exercised against an injected fake codec (so we do not
 * depend on the `sparkplug-payload` protobuf package being installed).
 * Issue #463.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  metricToProto,
  metricFromProto,
  payloadToProto,
  payloadFromProto,
  dataTypeName,
  dataTypeFromName,
  encodePayload,
  decodePayload,
  setCodec,
  type ProtoPayload,
} from "../payload";
import { SparkplugDataType, type SparkplugMetric, type SparkplugPayload } from "../types";

describe("data type name mapping", () => {
  it("maps enum to spec name and back", () => {
    expect(dataTypeName(SparkplugDataType.Int64)).toBe("Int64");
    expect(dataTypeName(SparkplugDataType.Boolean)).toBe("Boolean");
    expect(dataTypeFromName("Double")).toBe(SparkplugDataType.Double);
    expect(dataTypeFromName("UInt32")).toBe(SparkplugDataType.UInt32);
  });

  it("throws on unknown names/values", () => {
    expect(() => dataTypeFromName("NotAType")).toThrow();
    expect(() => dataTypeName(999 as SparkplugDataType)).toThrow();
  });
});

describe("metricToProto", () => {
  it("maps a basic metric and defaults the timestamp", () => {
    const metric: SparkplugMetric = {
      name: "Temperature",
      dataType: SparkplugDataType.Float,
      value: 42.5,
    };
    const proto = metricToProto(metric, 1000);
    expect(proto).toMatchObject({
      name: "Temperature",
      type: "Float",
      value: 42.5,
      timestamp: 1000,
      isNull: false,
    });
  });

  it("derives isNull and nulls the value", () => {
    const proto = metricToProto({ name: "x", dataType: SparkplugDataType.Int32, value: null });
    expect(proto.isNull).toBe(true);
    expect(proto.value).toBeNull();
  });

  it("preserves alias and historical flag", () => {
    const proto = metricToProto({
      name: "x",
      alias: 7,
      dataType: SparkplugDataType.Int32,
      value: 1,
      isHistorical: true,
    });
    expect(proto.alias).toBe(7);
    expect(proto.isHistorical).toBe(true);
  });

  it("maps properties with inferred types", () => {
    const proto = metricToProto({
      name: "x",
      dataType: SparkplugDataType.Double,
      value: 1.2,
      properties: { engUnit: "degC", quality: 192, enabled: true },
    });
    expect(proto.properties).toEqual({
      engUnit: { type: "String", value: "degC" },
      quality: { type: "Int32", value: 192 },
      enabled: { type: "Boolean", value: true },
    });
  });

  it("uses range-aware integer property types without Int32 truncation", () => {
    const proto = metricToProto({
      name: "x",
      dataType: SparkplugDataType.Double,
      value: 1,
      properties: {
        int32Max: 2_147_483_647,
        uint32HighBit: 2_147_483_648,
        belowInt32: -2_147_483_649,
        uint64Max: 18_446_744_073_709_551_615n,
      },
    });

    expect(proto.properties).toMatchObject({
      int32Max: { type: "Int32", value: 2_147_483_647 },
      uint32HighBit: { type: "UInt32", value: "2147483648" },
      belowInt32: { type: "Int64", value: "-2147483649" },
      uint64Max: { type: "UInt64", value: "18446744073709551615" },
    });
  });

  it("rejects invalid outbound metric timestamps, aliases, and property integers", () => {
    const metric: SparkplugMetric = {
      name: "x",
      dataType: SparkplugDataType.Int32,
      value: 1,
    };

    expect(() => metricToProto({ ...metric, timestamp: -1 })).toThrow(
      /metric timestamp/,
    );
    expect(() => metricToProto({ ...metric, timestamp: 1.5 })).toThrow(
      /metric timestamp/,
    );
    expect(() =>
      metricToProto({ ...metric, alias: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(/metric alias/);
    expect(() =>
      metricToProto({
        ...metric,
        properties: { invalid: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow(/property integer/);
  });
});

describe("metric round trip", () => {
  it("survives metricToProto -> metricFromProto", () => {
    const metric: SparkplugMetric = {
      name: "Pressure",
      alias: 3,
      dataType: SparkplugDataType.Double,
      value: 99.9,
      timestamp: 5000,
    };
    const back = metricFromProto(metricToProto(metric, 5000));
    expect(back.name).toBe("Pressure");
    expect(back.alias).toBe(3);
    expect(back.dataType).toBe(SparkplugDataType.Double);
    expect(back.value).toBe(99.9);
  });
});

describe("payloadToProto / payloadFromProto", () => {
  it("maps payload metrics and seq", () => {
    const payload: SparkplugPayload = {
      timestamp: 1234,
      seq: 5,
      metrics: [{ name: "a", dataType: SparkplugDataType.Int32, value: 1 }],
    };
    const proto = payloadToProto(payload, 1234);
    expect(proto.timestamp).toBe(1234);
    expect(proto.seq).toBe(5);
    expect(proto.metrics).toHaveLength(1);

    const back = payloadFromProto(proto);
    expect(back.seq).toBe(5);
    expect(back.metrics[0].name).toBe("a");
  });

  it("enforces outbound timestamp and 0..255 sequence ranges", () => {
    const payload: SparkplugPayload = { timestamp: 1, metrics: [] };

    expect(() => payloadToProto({ ...payload, timestamp: -1 })).toThrow(
      /payload timestamp/,
    );
    expect(() =>
      payloadToProto({ ...payload, timestamp: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(/payload timestamp/);
    expect(() => payloadToProto({ ...payload, seq: -1 })).toThrow(
      /payload sequence/,
    );
    expect(() => payloadToProto({ ...payload, seq: 256 })).toThrow(/0\.\.255/);
    expect(() => payloadToProto({ ...payload, seq: 1.5 })).toThrow(
      /payload sequence/,
    );
  });

  it("rejects decoded metadata outside the internal safe ranges", () => {
    expect(() =>
      payloadFromProto({ timestamp: -1, metrics: [] }),
    ).toThrow(/payload timestamp/);
    expect(() =>
      payloadFromProto({ timestamp: 1, seq: 256, metrics: [] }),
    ).toThrow(/0\.\.255/);
  });
});

describe("encode/decode with injected codec", () => {
  // Fake codec: JSON-serializes the proto object to bytes and back. This proves
  // the wrapper wires payloadToProto/payloadFromProto around the codec without
  // requiring the real protobuf package.
  const fakeCodec = {
    encodePayload(p: ProtoPayload): Uint8Array {
      return new TextEncoder().encode(JSON.stringify(p));
    },
    decodePayload(buf: Uint8Array): ProtoPayload {
      return JSON.parse(new TextDecoder().decode(buf)) as ProtoPayload;
    },
  };

  beforeEach(() => setCodec(fakeCodec));
  afterEach(() => setCodec(null));

  it("encodes then decodes back to an equivalent payload", () => {
    const payload: SparkplugPayload = {
      timestamp: 1234,
      seq: 0,
      metrics: [
        { name: "Temperature", dataType: SparkplugDataType.Float, value: 21.3 },
        { name: "Running", dataType: SparkplugDataType.Boolean, value: true },
      ],
    };
    const bytes = encodePayload(payload, 1234);
    expect(bytes).toBeInstanceOf(Uint8Array);

    const decoded = decodePayload(bytes);
    expect(decoded.seq).toBe(0);
    expect(decoded.metrics.map((m) => m.name)).toEqual(["Temperature", "Running"]);
    expect(decoded.metrics[1].value).toBe(true);
    expect(decoded.metrics[0].dataType).toBe(SparkplugDataType.Float);
  });
});
