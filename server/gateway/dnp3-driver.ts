/**
 * DNP3 Protocol Driver for Utility SCADA Integration
 *
 * Issue #81 - DNP3 Protocol Driver
 *
 * Implements DNP3 (Distributed Network Protocol 3) for utility SCADA systems.
 * Supports:
 * - Data Link Layer, Transport Layer, and Application Layer
 * - Binary Inputs/Outputs, Analog Inputs/Outputs, Counters
 * - Unsolicited responses and event polling
 * - Class 0/1/2/3 data objects
 * - TCP and Serial connections (TCP primary)
 */

import { EventEmitter } from "events";
import * as net from "net";
import type { ProtocolDriver, TagDefinition, TagValue } from "./index";

// =============================================================================
// DNP3 CONSTANTS
// =============================================================================

/**
 * DNP3 Function Codes
 */
export const DNP3FunctionCode = {
  // Request Function Codes
  CONFIRM: 0x00,
  READ: 0x01,
  WRITE: 0x02,
  SELECT: 0x03,
  OPERATE: 0x04,
  DIRECT_OPERATE: 0x05,
  DIRECT_OPERATE_NO_ACK: 0x06,
  FREEZE: 0x07,
  FREEZE_NO_ACK: 0x08,
  FREEZE_CLEAR: 0x09,
  FREEZE_CLEAR_NO_ACK: 0x0a,
  FREEZE_AT_TIME: 0x0b,
  FREEZE_AT_TIME_NO_ACK: 0x0c,
  COLD_RESTART: 0x0d,
  WARM_RESTART: 0x0e,
  INITIALIZE_DATA: 0x0f,
  INITIALIZE_APPLICATION: 0x10,
  START_APPLICATION: 0x11,
  STOP_APPLICATION: 0x12,
  SAVE_CONFIGURATION: 0x13,
  ENABLE_UNSOLICITED: 0x14,
  DISABLE_UNSOLICITED: 0x15,
  ASSIGN_CLASS: 0x16,
  DELAY_MEASURE: 0x17,
  RECORD_CURRENT_TIME: 0x18,
  OPEN_FILE: 0x19,
  CLOSE_FILE: 0x1a,
  DELETE_FILE: 0x1b,
  GET_FILE_INFO: 0x1c,
  AUTHENTICATE_FILE: 0x1d,
  ABORT_FILE: 0x1e,

  // Response Function Codes
  RESPONSE: 0x81,
  UNSOLICITED_RESPONSE: 0x82,
} as const;

export type DNP3FunctionCode =
  (typeof DNP3FunctionCode)[keyof typeof DNP3FunctionCode];

/**
 * DNP3 Object Groups
 */
export const DNP3ObjectGroup = {
  // Binary Inputs
  BINARY_INPUT: 1, // Group 1: Binary Input
  BINARY_INPUT_EVENT: 2, // Group 2: Binary Input Event

  // Binary Outputs
  BINARY_OUTPUT: 10, // Group 10: Binary Output
  BINARY_OUTPUT_EVENT: 11, // Group 11: Binary Output Event
  BINARY_OUTPUT_COMMAND: 12, // Group 12: Binary Output Command

  // Counters
  COUNTER: 20, // Group 20: Counter
  COUNTER_EVENT: 22, // Group 22: Counter Event
  FROZEN_COUNTER: 21, // Group 21: Frozen Counter
  FROZEN_COUNTER_EVENT: 23, // Group 23: Frozen Counter Event

  // Analog Inputs
  ANALOG_INPUT: 30, // Group 30: Analog Input
  ANALOG_INPUT_EVENT: 32, // Group 32: Analog Input Event
  FROZEN_ANALOG_INPUT: 31, // Group 31: Frozen Analog Input
  FROZEN_ANALOG_INPUT_EVENT: 33, // Group 33: Frozen Analog Input Event

  // Analog Outputs
  ANALOG_OUTPUT_STATUS: 40, // Group 40: Analog Output Status
  ANALOG_OUTPUT_EVENT: 42, // Group 42: Analog Output Event
  ANALOG_OUTPUT_COMMAND: 41, // Group 41: Analog Output Command

  // Time and Date
  TIME_DATE: 50, // Group 50: Time and Date

  // Class Data
  CLASS_0: 60, // Group 60: Class Data - Class 0
  CLASS_1: 60, // Group 60: Class Data - Class 1
  CLASS_2: 60, // Group 60: Class Data - Class 2
  CLASS_3: 60, // Group 60: Class Data - Class 3

  // Internal Indications
  INTERNAL_INDICATIONS: 80, // Group 80: Internal Indications
} as const;

export type DNP3ObjectGroup =
  (typeof DNP3ObjectGroup)[keyof typeof DNP3ObjectGroup];

/**
 * DNP3 Object Variations
 */
export const DNP3ObjectVariation = {
  // Binary Input Variations (Group 1)
  BINARY_INPUT_PACKED: 0x01, // Variation 1: Packed format
  BINARY_INPUT_FLAGS: 0x02, // Variation 2: With flags

  // Binary Input Event Variations (Group 2)
  BINARY_INPUT_EVENT_NO_TIME: 0x01, // Variation 1: Without time
  BINARY_INPUT_EVENT_ABS_TIME: 0x02, // Variation 2: With absolute time
  BINARY_INPUT_EVENT_REL_TIME: 0x03, // Variation 3: With relative time

  // Binary Output Variations (Group 10)
  BINARY_OUTPUT_PACKED: 0x01, // Variation 1: Packed format
  BINARY_OUTPUT_FLAGS: 0x02, // Variation 2: With flags

  // Counter Variations (Group 20)
  COUNTER_32BIT_FLAGS: 0x01, // Variation 1: 32-bit with flags
  COUNTER_16BIT_FLAGS: 0x02, // Variation 2: 16-bit with flags
  COUNTER_32BIT_DELTA_FLAGS: 0x03, // Variation 3: 32-bit delta with flags
  COUNTER_16BIT_DELTA_FLAGS: 0x04, // Variation 4: 16-bit delta with flags
  COUNTER_32BIT: 0x05, // Variation 5: 32-bit without flags
  COUNTER_16BIT: 0x06, // Variation 6: 16-bit without flags
  COUNTER_32BIT_DELTA: 0x07, // Variation 7: 32-bit delta without flags
  COUNTER_16BIT_DELTA: 0x08, // Variation 8: 16-bit delta without flags

  // Analog Input Variations (Group 30)
  ANALOG_INPUT_32BIT_FLAGS: 0x01, // Variation 1: 32-bit with flags
  ANALOG_INPUT_16BIT_FLAGS: 0x02, // Variation 2: 16-bit with flags
  ANALOG_INPUT_32BIT: 0x03, // Variation 3: 32-bit without flags
  ANALOG_INPUT_16BIT: 0x04, // Variation 4: 16-bit without flags
  ANALOG_INPUT_FLOAT_FLAGS: 0x05, // Variation 5: Single-precision float with flags
  ANALOG_INPUT_DOUBLE_FLAGS: 0x06, // Variation 6: Double-precision float with flags

  // Analog Output Status Variations (Group 40)
  ANALOG_OUTPUT_32BIT_FLAGS: 0x01, // Variation 1: 32-bit with flags
  ANALOG_OUTPUT_16BIT_FLAGS: 0x02, // Variation 2: 16-bit with flags
  ANALOG_OUTPUT_FLOAT_FLAGS: 0x03, // Variation 3: Single-precision float with flags
  ANALOG_OUTPUT_DOUBLE_FLAGS: 0x04, // Variation 4: Double-precision float with flags

  // Class Data Variations (Group 60)
  CLASS_0_DATA: 0x01, // Variation 1: Class 0 data
  CLASS_1_DATA: 0x02, // Variation 2: Class 1 data (events)
  CLASS_2_DATA: 0x03, // Variation 3: Class 2 data (events)
  CLASS_3_DATA: 0x04, // Variation 4: Class 3 data (events)
} as const;

export type DNP3ObjectVariation =
  (typeof DNP3ObjectVariation)[keyof typeof DNP3ObjectVariation];

/**
 * DNP3 Quality Flags
 */
export const DNP3QualityFlag = {
  ONLINE: 0x01, // Point is online
  RESTART: 0x02, // Device has been restarted
  COMM_LOST: 0x04, // Communication lost
  REMOTE_FORCED: 0x08, // Value forced by operator
  LOCAL_FORCED: 0x10, // Value forced locally
  OVER_RANGE: 0x20, // Value is over range
  REFERENCE_ERR: 0x40, // Reference error
  RESERVED: 0x80, // Reserved
} as const;

export type DNP3QualityFlag =
  (typeof DNP3QualityFlag)[keyof typeof DNP3QualityFlag];

/**
 * DNP3 Internal Indication Flags (IIN)
 */
export const DNP3InternalIndication = {
  // First byte (IIN1)
  ALL_STATIONS: 0x0001, // Broadcast message received
  CLASS_1_EVENTS: 0x0002, // Class 1 events available
  CLASS_2_EVENTS: 0x0004, // Class 2 events available
  CLASS_3_EVENTS: 0x0008, // Class 3 events available
  NEED_TIME: 0x0010, // Outstation needs time sync
  LOCAL_CONTROL: 0x0020, // Some outputs in local control
  DEVICE_TROUBLE: 0x0040, // Device trouble
  DEVICE_RESTART: 0x0080, // Device has restarted

  // Second byte (IIN2)
  NO_FUNC_CODE_SUPPORT: 0x0100, // Function code not supported
  OBJECT_UNKNOWN: 0x0200, // Object unknown
  PARAMETER_ERROR: 0x0400, // Parameter error
  EVENT_BUFFER_OVERFLOW: 0x0800, // Event buffer overflow
  ALREADY_EXECUTING: 0x1000, // Operation already in progress
  CONFIG_CORRUPT: 0x2000, // Configuration corrupt
  RESERVED_2: 0x4000, // Reserved
  RESERVED_1: 0x8000, // Reserved
} as const;

export type DNP3InternalIndication =
  (typeof DNP3InternalIndication)[keyof typeof DNP3InternalIndication];

// =============================================================================
// DNP3 TYPES
// =============================================================================

/**
 * DNP3 Driver Configuration
 */
export interface DNP3DriverConfig {
  host: string;
  port: number;
  masterAddress: number; // DNP3 master station address (0-65519)
  outstationAddress: number; // DNP3 outstation address (0-65519)
  timeout: number;
  retryCount: number;
  retryDelay: number;
  enableUnsolicited: boolean;
  pollInterval: number; // Class poll interval in ms
  integrityPollInterval: number; // Class 0 integrity poll interval in ms
}

/**
 * DNP3 Point Types
 */
export type DNP3PointType =
  | "BINARY_INPUT"
  | "BINARY_OUTPUT"
  | "ANALOG_INPUT"
  | "ANALOG_OUTPUT"
  | "COUNTER"
  | "FROZEN_COUNTER";

/**
 * DNP3 Data Point
 */
export interface DNP3DataPoint {
  index: number;
  type: DNP3PointType;
  value: number | boolean;
  quality: number; // DNP3 quality flags
  timestamp?: Date;
  eventClass?: 1 | 2 | 3;
}

/**
 * DNP3 Address Configuration
 */
export interface DNP3Address {
  type: DNP3PointType;
  index: number;
  eventClass?: 1 | 2 | 3;
}

/**
 * DNP3 Data Link Layer Frame
 */
export interface DNP3DataLinkFrame {
  start: number; // 0x0564
  length: number;
  control: number;
  destination: number;
  source: number;
  crc: number;
  userData?: Buffer;
}

/**
 * DNP3 Transport Layer Segment
 */
export interface DNP3TransportSegment {
  fin: boolean; // Final segment
  fir: boolean; // First segment
  sequence: number;
  data: Buffer;
}

/**
 * DNP3 Application Layer Message
 */
export interface DNP3ApplicationMessage {
  applicationControl: number;
  functionCode: number;
  internalIndications?: number;
  objects: DNP3ObjectHeader[];
}

/**
 * DNP3 Object Header
 */
export interface DNP3ObjectHeader {
  group: number;
  variation: number;
  qualifier: number;
  range: DNP3Range;
  data: Buffer;
}

/**
 * DNP3 Range Specification
 */
export interface DNP3Range {
  startIndex?: number;
  stopIndex?: number;
  count?: number;
}

/**
 * DNP3 Binary Output Control
 */
export interface DNP3ControlRelayOutputBlock {
  controlCode: number;
  count: number;
  onTime: number;
  offTime: number;
  status: number;
}

// =============================================================================
// CRC-16 CALCULATION (DNP3-specific)
// =============================================================================

/**
 * DNP3 CRC-16 lookup table
 */
const DNP3_CRC_TABLE: number[] = (function () {
  const table: number[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = 0;
    let temp = i;
    for (let j = 0; j < 8; j++) {
      if ((crc ^ temp) & 0x0001) {
        crc = (crc >> 1) ^ 0xa6bc;
      } else {
        crc = crc >> 1;
      }
      temp = temp >> 1;
    }
    table[i] = crc;
  }
  return table;
})();

/**
 * Calculate DNP3 CRC-16
 */
export function calculateDNP3CRC(data: Buffer): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    const index = (crc ^ data[i]) & 0xff;
    crc = (crc >> 8) ^ DNP3_CRC_TABLE[index];
  }
  return ~crc & 0xffff;
}

/**
 * Verify DNP3 CRC
 */
export function verifyDNP3CRC(data: Buffer, expectedCrc: number): boolean {
  return calculateDNP3CRC(data) === expectedCrc;
}

// =============================================================================
// DNP3 ADDRESS PARSER
// =============================================================================

/**
 * Parse DNP3 address string
 * Formats:
 *   "BI:0"   -> Binary Input index 0
 *   "BO:5"   -> Binary Output index 5
 *   "AI:10"  -> Analog Input index 10
 *   "AO:3"   -> Analog Output index 3
 *   "CT:0"   -> Counter index 0
 *   "FC:0"   -> Frozen Counter index 0
 *   "1:0"    -> Group 1, index 0 (Binary Input)
 */
export function parseDNP3Address(address: string): DNP3Address {
  if (address.includes(":")) {
    const [type, indexStr] = address.split(":");
    const index = parseInt(indexStr, 10);

    if (isNaN(index) || index < 0) {
      throw new Error(`Invalid DNP3 index: ${indexStr}`);
    }

    switch (type.toUpperCase()) {
      case "BI":
      case "1":
      case "BINARY_INPUT":
        return { type: "BINARY_INPUT", index };
      case "BO":
      case "10":
      case "BINARY_OUTPUT":
        return { type: "BINARY_OUTPUT", index };
      case "AI":
      case "30":
      case "ANALOG_INPUT":
        return { type: "ANALOG_INPUT", index };
      case "AO":
      case "40":
      case "ANALOG_OUTPUT":
        return { type: "ANALOG_OUTPUT", index };
      case "CT":
      case "20":
      case "COUNTER":
        return { type: "COUNTER", index };
      case "FC":
      case "21":
      case "FROZEN_COUNTER":
        return { type: "FROZEN_COUNTER", index };
      default:
        throw new Error(`Unknown DNP3 point type: ${type}`);
    }
  }

  throw new Error(`Invalid DNP3 address format: ${address}`);
}

/**
 * Get DNP3 object group from point type
 */
export function getObjectGroup(pointType: DNP3PointType): number {
  switch (pointType) {
    case "BINARY_INPUT":
      return DNP3ObjectGroup.BINARY_INPUT;
    case "BINARY_OUTPUT":
      return DNP3ObjectGroup.BINARY_OUTPUT;
    case "ANALOG_INPUT":
      return DNP3ObjectGroup.ANALOG_INPUT;
    case "ANALOG_OUTPUT":
      return DNP3ObjectGroup.ANALOG_OUTPUT_STATUS;
    case "COUNTER":
      return DNP3ObjectGroup.COUNTER;
    case "FROZEN_COUNTER":
      return DNP3ObjectGroup.FROZEN_COUNTER;
    default:
      throw new Error(`Unknown point type: ${pointType}`);
  }
}

/**
 * Get default variation for point type
 */
export function getDefaultVariation(pointType: DNP3PointType): number {
  switch (pointType) {
    case "BINARY_INPUT":
      return DNP3ObjectVariation.BINARY_INPUT_FLAGS;
    case "BINARY_OUTPUT":
      return DNP3ObjectVariation.BINARY_OUTPUT_FLAGS;
    case "ANALOG_INPUT":
      return DNP3ObjectVariation.ANALOG_INPUT_32BIT_FLAGS;
    case "ANALOG_OUTPUT":
      return DNP3ObjectVariation.ANALOG_OUTPUT_32BIT_FLAGS;
    case "COUNTER":
      return DNP3ObjectVariation.COUNTER_32BIT_FLAGS;
    case "FROZEN_COUNTER":
      return DNP3ObjectVariation.COUNTER_32BIT_FLAGS;
    default:
      return 0;
  }
}

// =============================================================================
// DNP3 DATA LINK LAYER
// =============================================================================

/**
 * DNP3 Data Link Layer
 * Handles frame construction, CRC, and basic framing
 */
export class DNP3DataLinkLayer extends EventEmitter {
  private masterAddress: number;
  private outstationAddress: number;
  private frameBuffer: Buffer = Buffer.alloc(0);

  // Frame constants
  private static readonly START_BYTES = 0x0564;
  private static readonly MIN_FRAME_SIZE = 10;
  private static readonly MAX_FRAME_SIZE = 292;
  private static readonly HEADER_SIZE = 10;
  private static readonly USER_DATA_BLOCK_SIZE = 16;

  constructor(masterAddress: number, outstationAddress: number) {
    super();
    this.masterAddress = masterAddress;
    this.outstationAddress = outstationAddress;
  }

  /**
   * Build a data link layer frame
   */
  buildFrame(
    userData: Buffer,
    direction: "MASTER_TO_OUTSTATION" | "OUTSTATION_TO_MASTER" = "MASTER_TO_OUTSTATION",
    primary: boolean = true,
    fcb: boolean = false,
    fcv: boolean = false
  ): Buffer {
    // Calculate control byte
    let control = 0;
    if (direction === "MASTER_TO_OUTSTATION") {
      control |= 0x80; // DIR bit
    }
    if (primary) {
      control |= 0x40; // PRM bit
    }
    if (fcb) {
      control |= 0x20; // FCB bit
    }
    if (fcv) {
      control |= 0x10; // FCV/DFC bit
    }
    // Function code for primary data
    control |= 0x04; // User data function code

    // Build header
    const header = Buffer.alloc(8);
    header.writeUInt16LE(DNP3DataLinkLayer.START_BYTES, 0);
    header.writeUInt8(userData.length + 5, 2); // Length includes control and addresses
    header.writeUInt8(control, 3);
    header.writeUInt16LE(
      direction === "MASTER_TO_OUTSTATION"
        ? this.outstationAddress
        : this.masterAddress,
      4
    );
    header.writeUInt16LE(
      direction === "MASTER_TO_OUTSTATION"
        ? this.masterAddress
        : this.outstationAddress,
      6
    );

    // Calculate header CRC
    const headerCRC = calculateDNP3CRC(header);

    // Build frame with CRC blocks
    const frameData: Buffer[] = [header];
    frameData.push(Buffer.from([headerCRC & 0xff, (headerCRC >> 8) & 0xff]));

    // Add user data with CRC every 16 bytes
    let offset = 0;
    while (offset < userData.length) {
      const blockSize = Math.min(
        DNP3DataLinkLayer.USER_DATA_BLOCK_SIZE,
        userData.length - offset
      );
      const block = userData.subarray(offset, offset + blockSize);
      const blockCRC = calculateDNP3CRC(block);
      frameData.push(block);
      frameData.push(Buffer.from([blockCRC & 0xff, (blockCRC >> 8) & 0xff]));
      offset += blockSize;
    }

    return Buffer.concat(frameData);
  }

  /**
   * Parse received data and emit complete frames
   */
  parseData(data: Buffer): DNP3DataLinkFrame[] {
    this.frameBuffer = Buffer.concat([this.frameBuffer, data]);
    const frames: DNP3DataLinkFrame[] = [];

    while (this.frameBuffer.length >= DNP3DataLinkLayer.MIN_FRAME_SIZE) {
      // Find start bytes
      let startIndex = -1;
      for (let i = 0; i < this.frameBuffer.length - 1; i++) {
        if (
          this.frameBuffer.readUInt16LE(i) === DNP3DataLinkLayer.START_BYTES
        ) {
          startIndex = i;
          break;
        }
      }

      if (startIndex === -1) {
        // No valid start found, clear buffer
        this.frameBuffer = Buffer.alloc(0);
        break;
      }

      // Discard data before start
      if (startIndex > 0) {
        this.frameBuffer = this.frameBuffer.subarray(startIndex);
      }

      // Check if we have enough data for the header
      if (this.frameBuffer.length < DNP3DataLinkLayer.MIN_FRAME_SIZE) {
        break;
      }

      // Parse header
      const length = this.frameBuffer.readUInt8(2);
      const control = this.frameBuffer.readUInt8(3);
      const destination = this.frameBuffer.readUInt16LE(4);
      const source = this.frameBuffer.readUInt16LE(6);
      const headerCRC = this.frameBuffer.readUInt16LE(8);

      // Verify header CRC
      const headerData = this.frameBuffer.subarray(0, 8);
      if (!verifyDNP3CRC(headerData, headerCRC)) {
        // Invalid CRC, skip this byte and try again
        this.frameBuffer = this.frameBuffer.subarray(1);
        continue;
      }

      // Calculate total frame size
      const userDataLength = length - 5; // Subtract control and addresses
      const numBlocks = Math.ceil(
        userDataLength / DNP3DataLinkLayer.USER_DATA_BLOCK_SIZE
      );
      const totalFrameSize =
        DNP3DataLinkLayer.MIN_FRAME_SIZE + userDataLength + numBlocks * 2;

      if (this.frameBuffer.length < totalFrameSize) {
        // Not enough data yet
        break;
      }

      // Extract and verify user data blocks
      const userData: Buffer[] = [];
      let offset = DNP3DataLinkLayer.MIN_FRAME_SIZE;
      let remaining = userDataLength;
      let validFrame = true;

      while (remaining > 0 && validFrame) {
        const blockSize = Math.min(
          DNP3DataLinkLayer.USER_DATA_BLOCK_SIZE,
          remaining
        );
        const block = this.frameBuffer.subarray(offset, offset + blockSize);
        const blockCRC = this.frameBuffer.readUInt16LE(offset + blockSize);

        if (!verifyDNP3CRC(block, blockCRC)) {
          validFrame = false;
          break;
        }

        userData.push(block);
        offset += blockSize + 2;
        remaining -= blockSize;
      }

      if (!validFrame) {
        this.frameBuffer = this.frameBuffer.subarray(1);
        continue;
      }

      // Create frame object
      const frame: DNP3DataLinkFrame = {
        start: DNP3DataLinkLayer.START_BYTES,
        length,
        control,
        destination,
        source,
        crc: headerCRC,
        userData: Buffer.concat(userData),
      };

      frames.push(frame);
      this.frameBuffer = this.frameBuffer.subarray(totalFrameSize);
    }

    return frames;
  }
}

// =============================================================================
// DNP3 TRANSPORT LAYER
// =============================================================================

/**
 * DNP3 Transport Layer
 * Handles message segmentation and reassembly
 */
export class DNP3TransportLayer extends EventEmitter {
  private receiveBuffer: Buffer = Buffer.alloc(0);
  private expectedSequence: number = 0;
  private sendSequence: number = 0;

  private static readonly MAX_SEGMENT_SIZE = 249; // Max user data per segment

  /**
   * Segment application layer data for transmission
   */
  segmentData(data: Buffer): DNP3TransportSegment[] {
    const segments: DNP3TransportSegment[] = [];
    let offset = 0;

    while (offset < data.length) {
      const remaining = data.length - offset;
      const segmentSize = Math.min(
        DNP3TransportLayer.MAX_SEGMENT_SIZE,
        remaining
      );
      const segmentData = data.subarray(offset, offset + segmentSize);

      segments.push({
        fir: offset === 0,
        fin: offset + segmentSize >= data.length,
        sequence: this.sendSequence,
        data: segmentData,
      });

      this.sendSequence = (this.sendSequence + 1) & 0x3f; // 6-bit sequence
      offset += segmentSize;
    }

    return segments;
  }

  /**
   * Build transport header
   */
  buildSegment(segment: DNP3TransportSegment): Buffer {
    let header = segment.sequence & 0x3f;
    if (segment.fir) header |= 0x40;
    if (segment.fin) header |= 0x80;

    return Buffer.concat([Buffer.from([header]), segment.data]);
  }

  /**
   * Process received transport segment
   */
  processSegment(data: Buffer): Buffer | null {
    if (data.length < 1) return null;

    const header = data.readUInt8(0);
    const fir = (header & 0x40) !== 0;
    const fin = (header & 0x80) !== 0;
    const sequence = header & 0x3f;

    const segmentData = data.subarray(1);

    // Handle first segment
    if (fir) {
      this.receiveBuffer = segmentData;
      this.expectedSequence = (sequence + 1) & 0x3f;
    } else if (sequence === this.expectedSequence) {
      // Continue receiving
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, segmentData]);
      this.expectedSequence = (sequence + 1) & 0x3f;
    } else {
      // Sequence error - reset
      this.receiveBuffer = Buffer.alloc(0);
      return null;
    }

    // Return complete message
    if (fin) {
      const message = this.receiveBuffer;
      this.receiveBuffer = Buffer.alloc(0);
      return message;
    }

    return null;
  }
}

// =============================================================================
// DNP3 APPLICATION LAYER
// =============================================================================

/**
 * DNP3 Application Layer
 * Handles message formatting and parsing
 */
export class DNP3ApplicationLayer extends EventEmitter {
  private sequence: number = 0;

  /**
   * Build a read request
   */
  buildReadRequest(objects: Array<{ group: number; variation: number; range?: DNP3Range }>): Buffer {
    const buffers: Buffer[] = [];

    // Application control: FIR=1, FIN=1, SEQ=n
    const appControl = 0xc0 | (this.sequence & 0x0f);
    this.sequence = (this.sequence + 1) & 0x0f;

    buffers.push(Buffer.from([appControl, DNP3FunctionCode.READ]));

    // Add object headers
    for (const obj of objects) {
      const header = this.buildObjectHeader(obj.group, obj.variation, obj.range);
      buffers.push(header);
    }

    return Buffer.concat(buffers);
  }

  /**
   * Build an integrity poll request (Class 0, 1, 2, 3)
   */
  buildIntegrityPollRequest(): Buffer {
    return this.buildReadRequest([
      { group: DNP3ObjectGroup.CLASS_0, variation: DNP3ObjectVariation.CLASS_3_DATA },
      { group: DNP3ObjectGroup.CLASS_0, variation: DNP3ObjectVariation.CLASS_2_DATA },
      { group: DNP3ObjectGroup.CLASS_0, variation: DNP3ObjectVariation.CLASS_1_DATA },
      { group: DNP3ObjectGroup.CLASS_0, variation: DNP3ObjectVariation.CLASS_0_DATA },
    ]);
  }

  /**
   * Build a class poll request
   */
  buildClassPollRequest(classes: Array<1 | 2 | 3>): Buffer {
    const objects = classes.map((c) => ({
      group: DNP3ObjectGroup.CLASS_0,
      variation: c + 1, // Class N is variation N+1 in group 60
    }));
    return this.buildReadRequest(objects);
  }

  /**
   * Build a direct operate request
   */
  buildDirectOperateRequest(
    group: number,
    variation: number,
    index: number,
    value: number | boolean | DNP3ControlRelayOutputBlock
  ): Buffer {
    const buffers: Buffer[] = [];

    // Application control
    const appControl = 0xc0 | (this.sequence & 0x0f);
    this.sequence = (this.sequence + 1) & 0x0f;

    buffers.push(Buffer.from([appControl, DNP3FunctionCode.DIRECT_OPERATE]));

    // Object header with single point
    const header = Buffer.alloc(4);
    header.writeUInt8(group, 0);
    header.writeUInt8(variation, 1);
    header.writeUInt8(0x28, 2); // Qualifier: 8-bit index, 8-bit count
    header.writeUInt8(1, 3); // Count
    buffers.push(header);

    // Index
    buffers.push(Buffer.from([index]));

    // Value
    if (group === DNP3ObjectGroup.BINARY_OUTPUT_COMMAND) {
      // Control Relay Output Block
      const crob = value as DNP3ControlRelayOutputBlock;
      const crobBuffer = Buffer.alloc(11);
      crobBuffer.writeUInt8(crob.controlCode, 0);
      crobBuffer.writeUInt8(crob.count, 1);
      crobBuffer.writeUInt32LE(crob.onTime, 2);
      crobBuffer.writeUInt32LE(crob.offTime, 6);
      crobBuffer.writeUInt8(crob.status, 10);
      buffers.push(crobBuffer);
    } else if (group === DNP3ObjectGroup.ANALOG_OUTPUT_COMMAND) {
      // Analog output value
      const valueBuffer = Buffer.alloc(5);
      valueBuffer.writeUInt8(0, 0); // Status/flags
      valueBuffer.writeInt32LE(value as number, 1);
      buffers.push(valueBuffer);
    }

    return Buffer.concat(buffers);
  }

  /**
   * Build enable/disable unsolicited request
   */
  buildUnsolicitedRequest(enable: boolean, classes: Array<1 | 2 | 3> = [1, 2, 3]): Buffer {
    const buffers: Buffer[] = [];

    const appControl = 0xc0 | (this.sequence & 0x0f);
    this.sequence = (this.sequence + 1) & 0x0f;

    const functionCode = enable
      ? DNP3FunctionCode.ENABLE_UNSOLICITED
      : DNP3FunctionCode.DISABLE_UNSOLICITED;

    buffers.push(Buffer.from([appControl, functionCode]));

    // Add class objects
    for (const cls of classes) {
      const header = Buffer.alloc(3);
      header.writeUInt8(DNP3ObjectGroup.CLASS_0, 0);
      header.writeUInt8(cls + 1, 1); // Variation = class + 1
      header.writeUInt8(0x06, 2); // Qualifier: all points
      buffers.push(header);
    }

    return Buffer.concat(buffers);
  }

  /**
   * Build confirmation message
   */
  buildConfirmation(sequence: number): Buffer {
    return Buffer.from([sequence & 0x0f, DNP3FunctionCode.CONFIRM]);
  }

  /**
   * Build object header
   */
  private buildObjectHeader(group: number, variation: number, range?: DNP3Range): Buffer {
    const header = Buffer.alloc(range ? 5 : 3);
    header.writeUInt8(group, 0);
    header.writeUInt8(variation, 1);

    if (range && range.startIndex !== undefined && range.stopIndex !== undefined) {
      header.writeUInt8(0x00, 2); // Qualifier: 8-bit start/stop
      header.writeUInt8(range.startIndex, 3);
      header.writeUInt8(range.stopIndex, 4);
    } else {
      header.writeUInt8(0x06, 2); // Qualifier: all points (no range)
    }

    return header;
  }

  /**
   * Parse application layer response
   */
  parseResponse(data: Buffer): DNP3ApplicationMessage | null {
    if (data.length < 4) return null;

    const appControl = data.readUInt8(0);
    const functionCode = data.readUInt8(1);
    const iin = data.readUInt16LE(2);

    const message: DNP3ApplicationMessage = {
      applicationControl: appControl,
      functionCode,
      internalIndications: iin,
      objects: [],
    };

    // Parse object headers
    let offset = 4;
    while (offset < data.length) {
      const objHeader = this.parseObjectHeader(data, offset);
      if (!objHeader) break;
      message.objects.push(objHeader.header);
      offset = objHeader.nextOffset;
    }

    return message;
  }

  /**
   * Parse object header from response
   */
  private parseObjectHeader(
    data: Buffer,
    offset: number
  ): { header: DNP3ObjectHeader; nextOffset: number } | null {
    if (offset + 3 > data.length) return null;

    const group = data.readUInt8(offset);
    const variation = data.readUInt8(offset + 1);
    const qualifier = data.readUInt8(offset + 2);

    let range: DNP3Range = {};
    let dataOffset = offset + 3;
    let dataLength = 0;

    // Parse qualifier-specific range
    switch (qualifier) {
      case 0x00: // 8-bit start/stop indexes
        if (dataOffset + 2 > data.length) return null;
        range.startIndex = data.readUInt8(dataOffset);
        range.stopIndex = data.readUInt8(dataOffset + 1);
        range.count = range.stopIndex - range.startIndex + 1;
        dataOffset += 2;
        break;
      case 0x01: // 16-bit start/stop indexes
        if (dataOffset + 4 > data.length) return null;
        range.startIndex = data.readUInt16LE(dataOffset);
        range.stopIndex = data.readUInt16LE(dataOffset + 2);
        range.count = range.stopIndex - range.startIndex + 1;
        dataOffset += 4;
        break;
      case 0x06: // No range, all points
        range.count = 0; // Variable
        break;
      case 0x07: // 8-bit count
        if (dataOffset + 1 > data.length) return null;
        range.count = data.readUInt8(dataOffset);
        dataOffset += 1;
        break;
      case 0x08: // 16-bit count
        if (dataOffset + 2 > data.length) return null;
        range.count = data.readUInt16LE(dataOffset);
        dataOffset += 2;
        break;
      case 0x17: // 8-bit index prefix
      case 0x28: // 8-bit index, 8-bit count
        if (dataOffset + 1 > data.length) return null;
        range.count = data.readUInt8(dataOffset);
        dataOffset += 1;
        break;
      default:
        // Unknown qualifier, try to skip
        range.count = 0;
        break;
    }

    // Calculate data length based on object type
    if (range.count !== undefined && range.count > 0) {
      dataLength = this.getObjectDataSize(group, variation) * range.count;
    }

    // Handle indexed objects
    if (qualifier === 0x17 || qualifier === 0x28) {
      // Each object includes its index
      dataLength =
        (1 + this.getObjectDataSize(group, variation)) * (range.count || 0);
    }

    const objectData = data.subarray(dataOffset, dataOffset + dataLength);

    return {
      header: {
        group,
        variation,
        qualifier,
        range,
        data: objectData,
      },
      nextOffset: dataOffset + dataLength,
    };
  }

  /**
   * Get data size for object type
   */
  private getObjectDataSize(group: number, variation: number): number {
    switch (group) {
      case DNP3ObjectGroup.BINARY_INPUT:
        return variation === 1 ? 0.125 : 1; // Packed or with flags
      case DNP3ObjectGroup.BINARY_OUTPUT:
        return variation === 1 ? 0.125 : 1;
      case DNP3ObjectGroup.ANALOG_INPUT:
        switch (variation) {
          case 1:
            return 5; // 32-bit + flags
          case 2:
            return 3; // 16-bit + flags
          case 3:
            return 4; // 32-bit no flags
          case 4:
            return 2; // 16-bit no flags
          case 5:
            return 5; // Float + flags
          case 6:
            return 9; // Double + flags
          default:
            return 5;
        }
      case DNP3ObjectGroup.ANALOG_OUTPUT_STATUS:
        switch (variation) {
          case 1:
            return 5;
          case 2:
            return 3;
          case 3:
            return 5;
          case 4:
            return 9;
          default:
            return 5;
        }
      case DNP3ObjectGroup.COUNTER:
        switch (variation) {
          case 1:
          case 3:
          case 5:
          case 7:
            return 5; // 32-bit
          case 2:
          case 4:
          case 6:
          case 8:
            return 3; // 16-bit
          default:
            return 5;
        }
      default:
        return 0;
    }
  }

  /**
   * Parse data points from object header
   */
  parseDataPoints(header: DNP3ObjectHeader): DNP3DataPoint[] {
    const points: DNP3DataPoint[] = [];
    const { group, variation, qualifier, range, data } = header;

    let offset = 0;
    let index = range.startIndex || 0;
    const count = range.count || 0;

    for (let i = 0; i < count && offset < data.length; i++) {
      // Handle indexed objects
      if (qualifier === 0x17 || qualifier === 0x28) {
        index = data.readUInt8(offset);
        offset += 1;
      }

      const point = this.parseDataPoint(group, variation, data, offset, index);
      if (point) {
        points.push(point);
        offset += this.getObjectDataSize(group, variation);
      }

      if (qualifier !== 0x17 && qualifier !== 0x28) {
        index++;
      }
    }

    return points;
  }

  /**
   * Parse a single data point
   */
  private parseDataPoint(
    group: number,
    variation: number,
    data: Buffer,
    offset: number,
    index: number
  ): DNP3DataPoint | null {
    if (offset >= data.length) return null;

    let pointType: DNP3PointType;
    let value: number | boolean;
    let quality = 0;

    switch (group) {
      case DNP3ObjectGroup.BINARY_INPUT:
      case DNP3ObjectGroup.BINARY_INPUT_EVENT:
        pointType = "BINARY_INPUT";
        if (variation === 1) {
          // Packed format
          const byteOffset = Math.floor(offset);
          const bitOffset = index % 8;
          value = ((data.readUInt8(byteOffset) >> bitOffset) & 0x01) === 1;
          quality = DNP3QualityFlag.ONLINE;
        } else {
          // With flags
          quality = data.readUInt8(offset);
          value = (quality & 0x80) !== 0;
          quality &= 0x7f;
        }
        break;

      case DNP3ObjectGroup.BINARY_OUTPUT:
      case DNP3ObjectGroup.BINARY_OUTPUT_EVENT:
        pointType = "BINARY_OUTPUT";
        if (variation === 1) {
          const byteOffset = Math.floor(offset);
          const bitOffset = index % 8;
          value = ((data.readUInt8(byteOffset) >> bitOffset) & 0x01) === 1;
          quality = DNP3QualityFlag.ONLINE;
        } else {
          quality = data.readUInt8(offset);
          value = (quality & 0x80) !== 0;
          quality &= 0x7f;
        }
        break;

      case DNP3ObjectGroup.ANALOG_INPUT:
      case DNP3ObjectGroup.ANALOG_INPUT_EVENT:
        pointType = "ANALOG_INPUT";
        switch (variation) {
          case 1:
            quality = data.readUInt8(offset);
            value = data.readInt32LE(offset + 1);
            break;
          case 2:
            quality = data.readUInt8(offset);
            value = data.readInt16LE(offset + 1);
            break;
          case 3:
            quality = DNP3QualityFlag.ONLINE;
            value = data.readInt32LE(offset);
            break;
          case 4:
            quality = DNP3QualityFlag.ONLINE;
            value = data.readInt16LE(offset);
            break;
          case 5:
            quality = data.readUInt8(offset);
            value = data.readFloatLE(offset + 1);
            break;
          case 6:
            quality = data.readUInt8(offset);
            value = data.readDoubleLE(offset + 1);
            break;
          default:
            return null;
        }
        break;

      case DNP3ObjectGroup.ANALOG_OUTPUT_STATUS:
        pointType = "ANALOG_OUTPUT";
        switch (variation) {
          case 1:
            quality = data.readUInt8(offset);
            value = data.readInt32LE(offset + 1);
            break;
          case 2:
            quality = data.readUInt8(offset);
            value = data.readInt16LE(offset + 1);
            break;
          case 3:
            quality = data.readUInt8(offset);
            value = data.readFloatLE(offset + 1);
            break;
          case 4:
            quality = data.readUInt8(offset);
            value = data.readDoubleLE(offset + 1);
            break;
          default:
            return null;
        }
        break;

      case DNP3ObjectGroup.COUNTER:
      case DNP3ObjectGroup.COUNTER_EVENT:
        pointType = "COUNTER";
        switch (variation) {
          case 1:
          case 3:
            quality = data.readUInt8(offset);
            value = data.readUInt32LE(offset + 1);
            break;
          case 2:
          case 4:
            quality = data.readUInt8(offset);
            value = data.readUInt16LE(offset + 1);
            break;
          case 5:
          case 7:
            quality = DNP3QualityFlag.ONLINE;
            value = data.readUInt32LE(offset);
            break;
          case 6:
          case 8:
            quality = DNP3QualityFlag.ONLINE;
            value = data.readUInt16LE(offset);
            break;
          default:
            return null;
        }
        break;

      case DNP3ObjectGroup.FROZEN_COUNTER:
      case DNP3ObjectGroup.FROZEN_COUNTER_EVENT:
        pointType = "FROZEN_COUNTER";
        switch (variation) {
          case 1:
          case 3:
            quality = data.readUInt8(offset);
            value = data.readUInt32LE(offset + 1);
            break;
          case 2:
          case 4:
            quality = data.readUInt8(offset);
            value = data.readUInt16LE(offset + 1);
            break;
          case 5:
          case 7:
            quality = DNP3QualityFlag.ONLINE;
            value = data.readUInt32LE(offset);
            break;
          case 6:
          case 8:
            quality = DNP3QualityFlag.ONLINE;
            value = data.readUInt16LE(offset);
            break;
          default:
            return null;
        }
        break;

      default:
        return null;
    }

    return {
      index,
      type: pointType,
      value,
      quality,
    };
  }
}

// =============================================================================
// DNP3 TCP DRIVER
// =============================================================================

/**
 * DNP3 TCP Driver
 * Full implementation of DNP3 over TCP
 */
export class DNP3TcpDriver extends EventEmitter implements ProtocolDriver {
  protocol = "DNP3_TCP" as const;

  private config: DNP3DriverConfig;
  private socket: net.Socket | null = null;
  private connected = false;
  private reconnecting = false;

  // Protocol layers
  private dataLinkLayer: DNP3DataLinkLayer;
  private transportLayer: DNP3TransportLayer;
  private applicationLayer: DNP3ApplicationLayer;

  // Data storage
  private dataPoints: Map<string, DNP3DataPoint> = new Map();
  private lastValues: Map<string, TagValue> = new Map();

  // Subscription handling
  private subscriptionCallback?: (values: TagValue[]) => void;
  private subscribedTags: TagDefinition[] = [];
  private classPollInterval?: NodeJS.Timeout;
  private integrityPollInterval?: NodeJS.Timeout;

  // Request tracking
  private pendingRequests: Map<
    number,
    {
      resolve: (value: DNP3ApplicationMessage) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  // Frame control
  private fcb = false; // Frame Count Bit

  constructor(config: Partial<DNP3DriverConfig> & { host: string }) {
    super();

    this.config = {
      port: 20000, // Default DNP3 TCP port
      masterAddress: 1,
      outstationAddress: 10,
      timeout: 5000,
      retryCount: 3,
      retryDelay: 1000,
      enableUnsolicited: true,
      pollInterval: 1000,
      integrityPollInterval: 60000,
      ...config,
    };

    this.dataLinkLayer = new DNP3DataLinkLayer(
      this.config.masterAddress,
      this.config.outstationAddress
    );
    this.transportLayer = new DNP3TransportLayer();
    this.applicationLayer = new DNP3ApplicationLayer();
  }

  // ===========================================================================
  // CONNECTION
  // ===========================================================================

  async connect(): Promise<void> {
    console.log(
      `[DNP3] Connecting to ${this.config.host}:${this.config.port}...`
    );

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      this.socket.on("connect", async () => {
        this.connected = true;
        console.log(
          `[DNP3] Connected to ${this.config.host}:${this.config.port}`
        );

        // Enable unsolicited responses if configured
        if (this.config.enableUnsolicited) {
          try {
            await this.enableUnsolicited();
            console.log(`[DNP3] Unsolicited responses enabled`);
          } catch (error) {
            console.warn(`[DNP3] Failed to enable unsolicited:`, error);
          }
        }

        // Perform initial integrity poll
        try {
          await this.integrityPoll();
          console.log(`[DNP3] Initial integrity poll complete`);
        } catch (error) {
          console.warn(`[DNP3] Initial integrity poll failed:`, error);
        }

        resolve();
      });

      this.socket.on("data", (data: Buffer) => {
        this.handleData(data);
      });

      this.socket.on("error", (error: Error) => {
        console.error(`[DNP3] Socket error:`, error);
        if (!this.connected) {
          reject(error);
        }
        this.handleDisconnect();
      });

      this.socket.on("close", () => {
        console.log(`[DNP3] Socket closed`);
        this.handleDisconnect();
      });

      this.socket.connect(this.config.port, this.config.host);
    });
  }

  async disconnect(): Promise<void> {
    this.stopPolling();

    if (this.config.enableUnsolicited) {
      try {
        await this.disableUnsolicited();
      } catch {
        // Ignore errors during disconnect
      }
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;
    console.log(`[DNP3] Disconnected`);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private handleDisconnect(): void {
    this.connected = false;
    this.stopPolling();

    // Reject all pending requests
    for (const [seq, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection lost"));
    }
    this.pendingRequests.clear();

    // Attempt reconnection
    if (!this.reconnecting) {
      this.reconnect();
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    for (let i = 0; i < this.config.retryCount; i++) {
      try {
        console.log(
          `[DNP3] Reconnect attempt ${i + 1}/${this.config.retryCount}...`
        );
        await this.connect();
        this.reconnecting = false;

        // Resume subscriptions
        if (this.subscribedTags.length > 0 && this.subscriptionCallback) {
          this.startPolling();
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, this.config.retryDelay));
      }
    }

    this.reconnecting = false;
    console.error(
      `[DNP3] Failed to reconnect after ${this.config.retryCount} attempts`
    );
  }

  // ===========================================================================
  // DATA HANDLING
  // ===========================================================================

  private handleData(data: Buffer): void {
    // Parse data link frames
    const frames = this.dataLinkLayer.parseData(data);

    for (const frame of frames) {
      if (!frame.userData) continue;

      // Process transport layer
      const message = this.transportLayer.processSegment(frame.userData);
      if (!message) continue;

      // Parse application layer
      const appMessage = this.applicationLayer.parseResponse(message);
      if (!appMessage) continue;

      // Handle message
      this.handleApplicationMessage(appMessage);
    }
  }

  private handleApplicationMessage(message: DNP3ApplicationMessage): void {
    const sequence = message.applicationControl & 0x0f;

    // Check for unsolicited response
    if (message.functionCode === DNP3FunctionCode.UNSOLICITED_RESPONSE) {
      this.handleUnsolicitedResponse(message);
      return;
    }

    // Check for pending request
    const pending = this.pendingRequests.get(sequence);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(sequence);
      pending.resolve(message);
    }

    // Process data objects
    this.processDataObjects(message.objects);
  }

  private handleUnsolicitedResponse(message: DNP3ApplicationMessage): void {
    console.log(`[DNP3] Received unsolicited response`);

    // Send confirmation
    const confirmData = this.applicationLayer.buildConfirmation(
      message.applicationControl & 0x0f
    );
    this.sendFrame(confirmData);

    // Process data objects
    this.processDataObjects(message.objects);

    // Emit event
    this.emit("unsolicited", message);
  }

  private processDataObjects(objects: DNP3ObjectHeader[]): void {
    const changedValues: TagValue[] = [];

    for (const objHeader of objects) {
      const points = this.applicationLayer.parseDataPoints(objHeader);

      for (const point of points) {
        const key = `${point.type}:${point.index}`;
        const oldPoint = this.dataPoints.get(key);

        // Store new value
        this.dataPoints.set(key, point);

        // Check if value changed
        if (!oldPoint || oldPoint.value !== point.value || oldPoint.quality !== point.quality) {
          const tagValue = this.convertToTagValue(point);
          this.lastValues.set(key, tagValue);
          changedValues.push(tagValue);
        }
      }
    }

    // Notify subscribers of changed values
    if (changedValues.length > 0 && this.subscriptionCallback) {
      this.subscriptionCallback(changedValues);
    }
  }

  private convertToTagValue(point: DNP3DataPoint): TagValue {
    const quality = this.convertQuality(point.quality);
    const address = `${this.getAddressPrefix(point.type)}:${point.index}`;

    return {
      tag: address,
      value: point.value,
      quality,
      timestamp: point.timestamp || new Date(),
    };
  }

  private getAddressPrefix(type: DNP3PointType): string {
    switch (type) {
      case "BINARY_INPUT":
        return "BI";
      case "BINARY_OUTPUT":
        return "BO";
      case "ANALOG_INPUT":
        return "AI";
      case "ANALOG_OUTPUT":
        return "AO";
      case "COUNTER":
        return "CT";
      case "FROZEN_COUNTER":
        return "FC";
    }
  }

  private convertQuality(dnp3Quality: number): "GOOD" | "BAD" | "UNCERTAIN" {
    if (!(dnp3Quality & DNP3QualityFlag.ONLINE)) {
      return "BAD";
    }
    if (
      dnp3Quality & DNP3QualityFlag.COMM_LOST ||
      dnp3Quality & DNP3QualityFlag.RESTART
    ) {
      return "BAD";
    }
    if (
      dnp3Quality & DNP3QualityFlag.OVER_RANGE ||
      dnp3Quality & DNP3QualityFlag.REFERENCE_ERR
    ) {
      return "UNCERTAIN";
    }
    if (
      dnp3Quality & DNP3QualityFlag.LOCAL_FORCED ||
      dnp3Quality & DNP3QualityFlag.REMOTE_FORCED
    ) {
      return "UNCERTAIN";
    }
    return "GOOD";
  }

  // ===========================================================================
  // REQUEST/RESPONSE
  // ===========================================================================

  private sendFrame(appData: Buffer): void {
    if (!this.socket || !this.connected) {
      throw new Error("Not connected");
    }

    // Segment through transport layer
    const segments = this.transportLayer.segmentData(appData);

    for (const segment of segments) {
      const transportData = this.transportLayer.buildSegment(segment);
      const frame = this.dataLinkLayer.buildFrame(
        transportData,
        "MASTER_TO_OUTSTATION",
        true,
        this.fcb,
        true
      );
      this.socket.write(frame);
    }

    // Toggle FCB
    this.fcb = !this.fcb;
  }

  private async sendRequest(appData: Buffer): Promise<DNP3ApplicationMessage> {
    return new Promise((resolve, reject) => {
      const sequence = appData.readUInt8(0) & 0x0f;

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(sequence);
        reject(new Error("Request timeout"));
      }, this.config.timeout);

      // Track pending request
      this.pendingRequests.set(sequence, { resolve, reject, timeout });

      // Send frame
      try {
        this.sendFrame(appData);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(sequence);
        reject(error);
      }
    });
  }

  // ===========================================================================
  // DNP3 OPERATIONS
  // ===========================================================================

  /**
   * Perform integrity poll (Class 0, 1, 2, 3)
   */
  async integrityPoll(): Promise<DNP3DataPoint[]> {
    const request = this.applicationLayer.buildIntegrityPollRequest();
    const response = await this.sendRequest(request);

    const points: DNP3DataPoint[] = [];
    for (const obj of response.objects) {
      points.push(...this.applicationLayer.parseDataPoints(obj));
    }

    return points;
  }

  /**
   * Perform class poll
   */
  async classPoll(classes: Array<1 | 2 | 3> = [1, 2, 3]): Promise<DNP3DataPoint[]> {
    const request = this.applicationLayer.buildClassPollRequest(classes);
    const response = await this.sendRequest(request);

    const points: DNP3DataPoint[] = [];
    for (const obj of response.objects) {
      points.push(...this.applicationLayer.parseDataPoints(obj));
    }

    return points;
  }

  /**
   * Enable unsolicited responses
   */
  async enableUnsolicited(): Promise<void> {
    const request = this.applicationLayer.buildUnsolicitedRequest(true);
    await this.sendRequest(request);
  }

  /**
   * Disable unsolicited responses
   */
  async disableUnsolicited(): Promise<void> {
    const request = this.applicationLayer.buildUnsolicitedRequest(false);
    await this.sendRequest(request);
  }

  // ===========================================================================
  // READ OPERATIONS
  // ===========================================================================

  async readTag(address: string): Promise<TagValue> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    const parsed = parseDNP3Address(address);
    const group = getObjectGroup(parsed.type);
    const variation = getDefaultVariation(parsed.type);

    const request = this.applicationLayer.buildReadRequest([
      {
        group,
        variation,
        range: { startIndex: parsed.index, stopIndex: parsed.index },
      },
    ]);

    try {
      const response = await this.sendRequest(request);

      for (const obj of response.objects) {
        const points = this.applicationLayer.parseDataPoints(obj);
        for (const point of points) {
          if (point.index === parsed.index) {
            return this.convertToTagValue(point);
          }
        }
      }

      throw new Error(`Point not found in response: ${address}`);
    } catch (error) {
      console.error(`[DNP3] Read error for ${address}:`, error);
      return {
        tag: address,
        value: 0,
        quality: "BAD",
        timestamp: new Date(),
      };
    }
  }

  async readTags(addresses: string[]): Promise<TagValue[]> {
    // Group addresses by type for efficient reading
    const byType = new Map<DNP3PointType, number[]>();

    for (const addr of addresses) {
      const parsed = parseDNP3Address(addr);
      const indexes = byType.get(parsed.type) || [];
      indexes.push(parsed.index);
      byType.set(parsed.type, indexes);
    }

    // Build requests for each type
    const results: TagValue[] = [];

    for (const [type, indexes] of byType) {
      const group = getObjectGroup(type);
      const variation = getDefaultVariation(type);
      const minIndex = Math.min(...indexes);
      const maxIndex = Math.max(...indexes);

      const request = this.applicationLayer.buildReadRequest([
        {
          group,
          variation,
          range: { startIndex: minIndex, stopIndex: maxIndex },
        },
      ]);

      try {
        const response = await this.sendRequest(request);

        for (const obj of response.objects) {
          const points = this.applicationLayer.parseDataPoints(obj);
          for (const point of points) {
            if (indexes.includes(point.index)) {
              results.push(this.convertToTagValue(point));
            }
          }
        }
      } catch (error) {
        console.error(`[DNP3] Batch read error for ${type}:`, error);
        // Add bad quality values for failed reads
        for (const index of indexes) {
          results.push({
            tag: `${this.getAddressPrefix(type)}:${index}`,
            value: 0,
            quality: "BAD",
            timestamp: new Date(),
          });
        }
      }
    }

    return results;
  }

  // ===========================================================================
  // WRITE OPERATIONS
  // ===========================================================================

  async writeTag(
    address: string,
    value: number | string | boolean
  ): Promise<boolean> {
    if (!this.connected) throw new Error("Not connected");

    const parsed = parseDNP3Address(address);

    try {
      if (parsed.type === "BINARY_OUTPUT") {
        // Use Control Relay Output Block for binary outputs
        const crob: DNP3ControlRelayOutputBlock = {
          controlCode: value ? 0x03 : 0x04, // Latch On or Latch Off
          count: 1,
          onTime: 0,
          offTime: 0,
          status: 0,
        };

        const request = this.applicationLayer.buildDirectOperateRequest(
          DNP3ObjectGroup.BINARY_OUTPUT_COMMAND,
          1, // CROB variation
          parsed.index,
          crob
        );

        const response = await this.sendRequest(request);

        // Check IIN for errors
        if (response.internalIndications) {
          if (
            response.internalIndications &
            (DNP3InternalIndication.OBJECT_UNKNOWN |
              DNP3InternalIndication.PARAMETER_ERROR)
          ) {
            return false;
          }
        }

        console.log(`[DNP3] Write ${address} = ${value}`);
        return true;
      } else if (parsed.type === "ANALOG_OUTPUT") {
        const request = this.applicationLayer.buildDirectOperateRequest(
          DNP3ObjectGroup.ANALOG_OUTPUT_COMMAND,
          1, // 32-bit variation
          parsed.index,
          Number(value)
        );

        const response = await this.sendRequest(request);

        if (response.internalIndications) {
          if (
            response.internalIndications &
            (DNP3InternalIndication.OBJECT_UNKNOWN |
              DNP3InternalIndication.PARAMETER_ERROR)
          ) {
            return false;
          }
        }

        console.log(`[DNP3] Write ${address} = ${value}`);
        return true;
      } else {
        throw new Error(`Cannot write to ${parsed.type} points`);
      }
    } catch (error) {
      console.error(`[DNP3] Write error for ${address}:`, error);
      return false;
    }
  }

  // ===========================================================================
  // SUBSCRIPTIONS
  // ===========================================================================

  subscribe(tags: TagDefinition[], callback: (values: TagValue[]) => void): void {
    this.subscribedTags = tags;
    this.subscriptionCallback = callback;

    console.log(`[DNP3] Subscribing to ${tags.length} tags`);

    // Start polling
    this.startPolling();
  }

  unsubscribe(): void {
    this.stopPolling();
    this.subscriptionCallback = undefined;
    this.subscribedTags = [];
    console.log(`[DNP3] Unsubscribed`);
  }

  private startPolling(): void {
    // Class poll (events)
    this.classPollInterval = setInterval(async () => {
      if (!this.connected) return;

      try {
        await this.classPoll([1, 2, 3]);
      } catch (error) {
        console.error(`[DNP3] Class poll error:`, error);
      }
    }, this.config.pollInterval);

    // Integrity poll (full state)
    this.integrityPollInterval = setInterval(async () => {
      if (!this.connected) return;

      try {
        await this.integrityPoll();
      } catch (error) {
        console.error(`[DNP3] Integrity poll error:`, error);
      }
    }, this.config.integrityPollInterval);
  }

  private stopPolling(): void {
    if (this.classPollInterval) {
      clearInterval(this.classPollInterval);
      this.classPollInterval = undefined;
    }
    if (this.integrityPollInterval) {
      clearInterval(this.integrityPollInterval);
      this.integrityPollInterval = undefined;
    }
  }

  // ===========================================================================
  // STATUS
  // ===========================================================================

  getStatus(): Record<string, unknown> {
    return {
      protocol: this.protocol,
      host: this.config.host,
      port: this.config.port,
      masterAddress: this.config.masterAddress,
      outstationAddress: this.config.outstationAddress,
      connected: this.connected,
      reconnecting: this.reconnecting,
      subscribedTags: this.subscribedTags.length,
      dataPointCount: this.dataPoints.size,
      unsolicitedEnabled: this.config.enableUnsolicited,
    };
  }

  /**
   * Get all cached data points
   */
  getAllDataPoints(): Map<string, DNP3DataPoint> {
    return new Map(this.dataPoints);
  }

  /**
   * Get internal indication status
   */
  getInternalIndications(iin: number): Record<string, boolean> {
    return {
      allStations: (iin & DNP3InternalIndication.ALL_STATIONS) !== 0,
      class1Events: (iin & DNP3InternalIndication.CLASS_1_EVENTS) !== 0,
      class2Events: (iin & DNP3InternalIndication.CLASS_2_EVENTS) !== 0,
      class3Events: (iin & DNP3InternalIndication.CLASS_3_EVENTS) !== 0,
      needTime: (iin & DNP3InternalIndication.NEED_TIME) !== 0,
      localControl: (iin & DNP3InternalIndication.LOCAL_CONTROL) !== 0,
      deviceTrouble: (iin & DNP3InternalIndication.DEVICE_TROUBLE) !== 0,
      deviceRestart: (iin & DNP3InternalIndication.DEVICE_RESTART) !== 0,
      noFuncCodeSupport: (iin & DNP3InternalIndication.NO_FUNC_CODE_SUPPORT) !== 0,
      objectUnknown: (iin & DNP3InternalIndication.OBJECT_UNKNOWN) !== 0,
      parameterError: (iin & DNP3InternalIndication.PARAMETER_ERROR) !== 0,
      eventBufferOverflow: (iin & DNP3InternalIndication.EVENT_BUFFER_OVERFLOW) !== 0,
      alreadyExecuting: (iin & DNP3InternalIndication.ALREADY_EXECUTING) !== 0,
      configCorrupt: (iin & DNP3InternalIndication.CONFIG_CORRUPT) !== 0,
    };
  }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a DNP3 TCP driver
 */
export function createDNP3Driver(
  host: string,
  port: number = 20000,
  masterAddress: number = 1,
  outstationAddress: number = 10
): DNP3TcpDriver {
  return new DNP3TcpDriver({ host, port, masterAddress, outstationAddress });
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  DNP3TcpDriver as DNP3Driver,
  DNP3DataLinkLayer,
  DNP3TransportLayer,
  DNP3ApplicationLayer,
};
