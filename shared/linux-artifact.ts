/**
 * 0xSCADA Linux Fork Artifact Types
 * 
 * VERITY Architecture - Phase α.2.1: Linux Fork Trace Capture
 * 
 * Artifact types for:
 * - Kernel traces (ftrace, eBPF)
 * - Sensor data bursts
 * - Firmware images
 * - Device states
 * - Deterministic replay artifacts
 */

import { z } from "zod";
import { contentHashSchema } from "./artifact";

// =============================================================================
// TRACE TYPES
// =============================================================================

export const TraceType = {
  FTRACE: "ftrace",
  EBPF: "ebpf",
  PERF: "perf",
  STRACE: "strace",
  KPROBE: "kprobe",
  UPROBE: "uprobe",
  TRACEPOINT: "tracepoint",
} as const;

export type TraceType = (typeof TraceType)[keyof typeof TraceType];

// =============================================================================
// SENSOR TYPES
// =============================================================================

export const SensorProtocol = {
  MODBUS_RTU: "modbus-rtu",
  MODBUS_TCP: "modbus-tcp",
  OPCUA: "opcua",
  PROFINET: "profinet",
  ETHERCAT: "ethercat",
  CANBUS: "canbus",
  MQTT: "mqtt",
  RAW: "raw",
} as const;

export type SensorProtocol = (typeof SensorProtocol)[keyof typeof SensorProtocol];

// =============================================================================
// KERNEL TRACE
// =============================================================================

export const kernelTraceSchema = z.object({
  traceId: z.string(),
  traceType: z.enum(["ftrace", "ebpf", "perf", "strace", "kprobe", "uprobe", "tracepoint"]),
  
  /** When the trace was captured */
  capturedAt: z.string().datetime(),
  
  /** Duration of the trace capture in milliseconds */
  durationMs: z.number().positive(),
  
  /** System info at capture time */
  system: z.object({
    hostname: z.string(),
    kernelVersion: z.string(),
    architecture: z.string(),
    cpuCount: z.number().int().positive(),
  }),
  
  /** Trace configuration */
  config: z.object({
    events: z.array(z.string()).optional(),
    filters: z.array(z.string()).optional(),
    bufferSizeKb: z.number().int().positive().optional(),
    sampleRateHz: z.number().positive().optional(),
  }).optional(),
  
  /** Statistics about the captured trace */
  stats: z.object({
    eventCount: z.number().int().nonnegative(),
    droppedEvents: z.number().int().nonnegative().optional(),
    compressedSizeBytes: z.number().int().nonnegative(),
    uncompressedSizeBytes: z.number().int().nonnegative(),
  }),
  
  /** Hash of the raw trace data */
  rawTraceHash: contentHashSchema,
  
  /** Associated device or PLC if applicable */
  deviceId: z.string().optional(),
  
  /** Linked trigger (what caused this trace to be captured) */
  trigger: z.object({
    type: z.enum(["manual", "alarm", "anomaly", "scheduled", "threshold"]),
    source: z.string().optional(),
    details: z.record(z.unknown()).optional(),
  }).optional(),
});

export type KernelTrace = z.infer<typeof kernelTraceSchema>;

// =============================================================================
// SENSOR BURST
// =============================================================================

export const sensorBurstSchema = z.object({
  burstId: z.string(),
  
  /** Sensor/device identification */
  source: z.object({
    deviceId: z.string(),
    deviceName: z.string().optional(),
    protocol: z.enum([
      "modbus-rtu", "modbus-tcp", "opcua", "profinet",
      "ethercat", "canbus", "mqtt", "raw"
    ]),
    address: z.string().optional(), // IP, serial port, etc.
  }),
  
  /** Time window of the burst */
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  sampleCount: z.number().int().positive(),
  sampleRateHz: z.number().positive().optional(),
  
  /** Data points captured */
  channels: z.array(z.object({
    name: z.string(),
    unit: z.string().optional(),
    dataType: z.enum(["int16", "int32", "float32", "float64", "bool", "string"]),
    registerAddress: z.number().int().optional(),
    sampleCount: z.number().int().positive(),
    minValue: z.number().optional(),
    maxValue: z.number().optional(),
    meanValue: z.number().optional(),
  })),
  
  /** Hash of the raw sensor data */
  rawDataHash: contentHashSchema,
  
  /** Compression info */
  compression: z.object({
    algorithm: z.enum(["none", "gzip", "lz4", "zstd"]),
    originalSizeBytes: z.number().int().positive(),
    compressedSizeBytes: z.number().int().positive(),
  }),
  
  /** Quality indicators */
  quality: z.object({
    validSamples: z.number().int().nonnegative(),
    invalidSamples: z.number().int().nonnegative(),
    communicationErrors: z.number().int().nonnegative().optional(),
  }).optional(),
});

export type SensorBurst = z.infer<typeof sensorBurstSchema>;

// =============================================================================
// FIRMWARE IMAGE
// =============================================================================

export const firmwareImageSchema = z.object({
  imageId: z.string(),
  
  /** Device this firmware is for */
  device: z.object({
    deviceId: z.string(),
    deviceType: z.string(),
    manufacturer: z.string().optional(),
    model: z.string().optional(),
  }),
  
  /** Firmware version info */
  version: z.object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
    patch: z.number().int().nonnegative().optional(),
    buildNumber: z.string().optional(),
    versionString: z.string(),
  }),
  
  /** When the firmware was captured/extracted */
  capturedAt: z.string().datetime(),
  
  /** Hash of the firmware binary */
  binaryHash: contentHashSchema,
  
  /** Size in bytes */
  sizeBytes: z.number().int().positive(),
  
  /** Format info */
  format: z.object({
    type: z.enum(["raw", "hex", "srec", "elf", "bin", "encrypted"]),
    encrypted: z.boolean().default(false),
    signed: z.boolean().default(false),
  }),
  
  /** Metadata */
  metadata: z.record(z.unknown()).optional(),
  
  /** Previous firmware version if this is an update */
  previousVersionHash: contentHashSchema.optional(),
});

export type FirmwareImage = z.infer<typeof firmwareImageSchema>;

// =============================================================================
// DEVICE STATE SNAPSHOT
// =============================================================================

export const deviceStateSnapshotSchema = z.object({
  snapshotId: z.string(),
  
  /** Device identification */
  device: z.object({
    deviceId: z.string(),
    deviceType: z.string(),
    name: z.string().optional(),
    protocol: z.enum([
      "modbus-rtu", "modbus-tcp", "opcua", "profinet",
      "ethercat", "canbus", "mqtt", "raw"
    ]).optional(),
  }),
  
  /** When the snapshot was taken */
  capturedAt: z.string().datetime(),
  
  /** Device state data */
  state: z.object({
    /** Operating mode */
    mode: z.string().optional(),
    
    /** Status flags */
    status: z.record(z.boolean()).optional(),
    
    /** Register/variable values */
    registers: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
    
    /** Configuration at time of snapshot */
    configuration: z.record(z.unknown()).optional(),
    
    /** Alarm states */
    alarms: z.array(z.object({
      id: z.string(),
      active: z.boolean(),
      message: z.string().optional(),
    })).optional(),
  }),
  
  /** Hash of the full state blob */
  stateHash: contentHashSchema,
  
  /** Previous state for delta computation */
  previousSnapshotHash: contentHashSchema.optional(),
  
  /** Change summary from previous state */
  changeSummary: z.object({
    changedRegisters: z.number().int().nonnegative(),
    changedStatus: z.number().int().nonnegative(),
    newAlarms: z.number().int().nonnegative(),
    clearedAlarms: z.number().int().nonnegative(),
  }).optional(),
});

export type DeviceStateSnapshot = z.infer<typeof deviceStateSnapshotSchema>;

// =============================================================================
// LINUX ARTIFACT METADATA (Union type for all Linux artifacts)
// =============================================================================

export const LinuxArtifactType = {
  KERNEL_TRACE: "kernel-trace",
  SENSOR_BURST: "sensor-burst",
  FIRMWARE_IMAGE: "firmware-image",
  DEVICE_STATE: "device-state",
} as const;

export type LinuxArtifactType = (typeof LinuxArtifactType)[keyof typeof LinuxArtifactType];

export type LinuxArtifactMetadata = 
  | { type: "kernel-trace"; trace: KernelTrace }
  | { type: "sensor-burst"; burst: SensorBurst }
  | { type: "firmware-image"; firmware: FirmwareImage }
  | { type: "device-state"; snapshot: DeviceStateSnapshot };

// =============================================================================
// CREATE INPUT SCHEMAS
// =============================================================================

export const createKernelTraceInputSchema = z.object({
  traceType: z.enum(["ftrace", "ebpf", "perf", "strace", "kprobe", "uprobe", "tracepoint"]),
  durationMs: z.number().positive(),
  system: kernelTraceSchema.shape.system,
  config: kernelTraceSchema.shape.config.optional(),
  rawTrace: z.union([z.string(), z.instanceof(Buffer), z.instanceof(Uint8Array)]),
  deviceId: z.string().optional(),
  trigger: kernelTraceSchema.shape.trigger.optional(),
  siteId: z.string().optional(),
  assetId: z.string().optional(),
});

export type CreateKernelTraceInput = z.infer<typeof createKernelTraceInputSchema>;

export const createSensorBurstInputSchema = z.object({
  source: sensorBurstSchema.shape.source,
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  channels: sensorBurstSchema.shape.channels,
  rawData: z.union([z.string(), z.instanceof(Buffer), z.instanceof(Uint8Array)]),
  sampleRateHz: z.number().positive().optional(),
  quality: sensorBurstSchema.shape.quality.optional(),
  siteId: z.string().optional(),
  assetId: z.string().optional(),
});

export type CreateSensorBurstInput = z.infer<typeof createSensorBurstInputSchema>;

export const createFirmwareImageInputSchema = z.object({
  device: firmwareImageSchema.shape.device,
  version: firmwareImageSchema.shape.version,
  binary: z.union([z.string(), z.instanceof(Buffer), z.instanceof(Uint8Array)]),
  format: firmwareImageSchema.shape.format,
  metadata: z.record(z.unknown()).optional(),
  previousVersionHash: contentHashSchema.optional(),
  siteId: z.string().optional(),
  assetId: z.string().optional(),
});

export type CreateFirmwareImageInput = z.infer<typeof createFirmwareImageInputSchema>;

export const createDeviceStateSnapshotInputSchema = z.object({
  device: deviceStateSnapshotSchema.shape.device,
  state: deviceStateSnapshotSchema.shape.state,
  previousSnapshotHash: contentHashSchema.optional(),
  siteId: z.string().optional(),
  assetId: z.string().optional(),
});

export type CreateDeviceStateSnapshotInput = z.infer<typeof createDeviceStateSnapshotInputSchema>;
