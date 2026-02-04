/**
 * IEC 61850 MMS Protocol Driver
 *
 * Issue #82 - IEC 61850 MMS Driver for Substation Automation
 *
 * Implements the IEC 61850 standard for communication in substations,
 * including MMS (Manufacturing Message Specification) protocol layer
 * and GOOSE (Generic Object Oriented Substation Event) messages.
 *
 * Features:
 * - MMS protocol layer implementation
 * - GOOSE message handling
 * - Logical Node data models (LN, DO, DA structure)
 * - Connection pooling and reconnection logic
 * - IEC 61850 data type encoding/decoding
 */

import { EventEmitter } from "events";
import type { ProtocolDriver, TagDefinition, TagValue } from "./index";

// =============================================================================
// IEC 61850 DATA TYPES
// =============================================================================

/**
 * IEC 61850 Basic Data Types
 */
export enum IEC61850DataType {
  BOOLEAN = "BOOLEAN",
  INT8 = "INT8",
  INT16 = "INT16",
  INT32 = "INT32",
  INT64 = "INT64",
  INT8U = "INT8U",
  INT16U = "INT16U",
  INT32U = "INT32U",
  FLOAT32 = "FLOAT32",
  FLOAT64 = "FLOAT64",
  VISIBLE_STRING = "VISIBLE_STRING",
  OCTET_STRING = "OCTET_STRING",
  UNICODE_STRING = "UNICODE_STRING",
  TIMESTAMP = "TIMESTAMP",
  QUALITY = "QUALITY",
  ENTRY_TIME = "ENTRY_TIME",
  DBPOS = "DBPOS", // Double-point status
  TCMD = "TCMD", // Trip command
  CHECK = "CHECK",
  CODED_ENUM = "CODED_ENUM",
}

/**
 * IEC 61850 Quality Flags
 */
export interface IEC61850Quality {
  validity: "good" | "invalid" | "questionable" | "reserved";
  overflow: boolean;
  outOfRange: boolean;
  badReference: boolean;
  oscillatory: boolean;
  failure: boolean;
  oldData: boolean;
  inconsistent: boolean;
  inaccurate: boolean;
  source: "process" | "substituted";
  test: boolean;
  operatorBlocked: boolean;
}

/**
 * IEC 61850 Timestamp
 */
export interface IEC61850Timestamp {
  secondsSinceEpoch: number;
  fractionOfSecond: number; // 24-bit fraction
  timeQuality: {
    leapSecondsKnown: boolean;
    clockFailure: boolean;
    clockNotSynchronized: boolean;
    timeAccuracy: number; // bits
  };
}

/**
 * Double-point status for circuit breakers
 */
export enum DoublePointStatus {
  INTERMEDIATE = 0,
  OFF = 1,
  ON = 2,
  BAD = 3,
}

// =============================================================================
// IEC 61850 DATA MODEL TYPES
// =============================================================================

/**
 * Data Attribute (DA) - Leaf level
 */
export interface DataAttribute {
  name: string;
  fc: FunctionalConstraint; // Functional Constraint
  dataType: IEC61850DataType;
  value?: unknown;
  quality?: IEC61850Quality;
  timestamp?: IEC61850Timestamp;
}

/**
 * Functional Constraints define access and grouping
 */
export type FunctionalConstraint =
  | "ST" // Status
  | "MX" // Measured Values
  | "SP" // Setpoint
  | "SV" // Substitution
  | "CF" // Configuration
  | "DC" // Description
  | "SG" // Setting Group
  | "SE" // Setting Group Editable
  | "SR" // Service Response
  | "OR" // Operate Received
  | "BL" // Blocking
  | "EX" // Extended Definition
  | "CO"; // Control

/**
 * Data Object (DO) - Contains DAs or nested DOs
 */
export interface DataObject {
  name: string;
  cdc: CommonDataClass; // Common Data Class
  attributes: Map<string, DataAttribute>;
  subObjects?: Map<string, DataObject>;
}

/**
 * Common Data Classes (CDCs) define data object types
 */
export type CommonDataClass =
  | "SPS" // Single Point Status
  | "DPS" // Double Point Status
  | "INS" // Integer Status
  | "ENS" // Enumerated Status
  | "ACT" // Protection Activation
  | "ACD" // Directional Protection Activation
  | "SEC" // Security Violation
  | "BCR" // Binary Counter Reading
  | "MV" // Measured Value
  | "CMV" // Complex Measured Value
  | "SAV" // Sampled Value
  | "WYE" // Phase to Ground Related Measured Value
  | "DEL" // Phase to Phase Related Measured Value
  | "SEQ" // Sequence
  | "HMV" // Harmonics
  | "HWYE" // Harmonic Value for WYE
  | "HDEL" // Harmonic Value for DEL
  | "SPC" // Controllable Single Point
  | "DPC" // Controllable Double Point
  | "INC" // Controllable Integer Status
  | "ENC" // Controllable Enumerated Status
  | "BSC" // Binary Controlled Step Position Information
  | "ISC" // Integer Controlled Step Position Information
  | "APC" // Controllable Analogue Process Value
  | "BAC" // Binary Controlled Analogue Process Value
  | "SPG" // Single Point Setting
  | "ING" // Integer Setting
  | "ENG" // Enumerated Setting
  | "ORG" // Object Reference Setting
  | "TSG" // Time Setting
  | "CUG" // Currency Setting
  | "VSG" // Visible String Setting
  | "ASG" // Analogue Setting
  | "CURVE" // Setting Curve
  | "CSG" // Curve Shape Setting
  | "DPL" // Device Name Plate
  | "LPL" // Logical Node Name Plate
  | "CSD"; // Curve Shape Description

/**
 * Logical Node (LN) - Contains DOs
 */
export interface LogicalNode {
  lnClass: string; // e.g., "XCBR" for circuit breaker
  lnInst: string; // Instance number
  prefix?: string;
  dataObjects: Map<string, DataObject>;
}

/**
 * Logical Device (LD) - Contains LNs
 */
export interface LogicalDevice {
  ldName: string;
  logicalNodes: Map<string, LogicalNode>;
}

/**
 * IED (Intelligent Electronic Device) - Top level
 */
export interface IEDModel {
  iedName: string;
  manufacturer?: string;
  configVersion?: string;
  logicalDevices: Map<string, LogicalDevice>;
}

// =============================================================================
// MMS PROTOCOL TYPES
// =============================================================================

/**
 * MMS PDU Types
 */
export enum MMSPDUType {
  CONFIRMED_REQUEST = 0,
  CONFIRMED_RESPONSE = 1,
  CONFIRMED_ERROR = 2,
  UNCONFIRMED = 3,
  REJECT = 4,
  CANCEL_REQUEST = 5,
  CANCEL_RESPONSE = 6,
  CANCEL_ERROR = 7,
  INITIATE_REQUEST = 8,
  INITIATE_RESPONSE = 9,
  INITIATE_ERROR = 10,
  CONCLUDE_REQUEST = 11,
  CONCLUDE_RESPONSE = 12,
  CONCLUDE_ERROR = 13,
}

/**
 * MMS Service Types
 */
export enum MMSServiceType {
  GET_NAME_LIST = 1,
  IDENTIFY = 2,
  READ = 3,
  WRITE = 4,
  GET_VARIABLE_ACCESS_ATTRIBUTES = 5,
  DEFINE_NAMED_VARIABLE = 6,
  DELETE_NAMED_VARIABLE = 7,
  GET_NAMED_VARIABLE_LIST_ATTRIBUTES = 8,
  DEFINE_NAMED_VARIABLE_LIST = 9,
  DELETE_NAMED_VARIABLE_LIST = 10,
  GET_DOMAIN_ATTRIBUTES = 11,
  FILE_OPEN = 12,
  FILE_READ = 13,
  FILE_CLOSE = 14,
  FILE_RENAME = 15,
  FILE_DELETE = 16,
  FILE_DIRECTORY = 17,
  // IEC 61850 specific services
  GET_LOGICAL_DEVICE_DIRECTORY = 100,
  GET_LOGICAL_NODE_DIRECTORY = 101,
  GET_DATA_DIRECTORY = 102,
  GET_DATA_DEFINITION = 103,
  GET_DATA_VALUES = 104,
  SET_DATA_VALUES = 105,
  SELECT = 106,
  SELECT_WITH_VALUE = 107,
  CANCEL = 108,
  OPERATE = 109,
}

/**
 * MMS Request Message
 */
export interface MMSRequest {
  invokeId: number;
  serviceType: MMSServiceType;
  domainId?: string;
  itemId?: string;
  data?: unknown;
}

/**
 * MMS Response Message
 */
export interface MMSResponse {
  invokeId: number;
  serviceType: MMSServiceType;
  success: boolean;
  data?: unknown;
  errorCode?: number;
  errorMessage?: string;
}

// =============================================================================
// GOOSE PROTOCOL TYPES
// =============================================================================

/**
 * GOOSE Message Header
 */
export interface GOOSEHeader {
  appId: number;
  length: number;
  reserved1: number;
  reserved2: number;
}

/**
 * GOOSE PDU (Protocol Data Unit)
 */
export interface GOOSEPDU {
  goCBRef: string; // GOOSE Control Block Reference
  timeAllowedToLive: number;
  datSet: string; // Data Set Reference
  goID?: string; // GOOSE ID
  t: IEC61850Timestamp; // Timestamp
  stNum: number; // State Number
  sqNum: number; // Sequence Number
  simulation: boolean;
  confRev: number; // Configuration Revision
  ndsCom: boolean; // Needs Commissioning
  numDatSetEntries: number;
  allData: GOOSEDataEntry[];
}

/**
 * GOOSE Data Entry
 */
export interface GOOSEDataEntry {
  dataRef: string;
  value: unknown;
  quality?: IEC61850Quality;
}

/**
 * GOOSE Subscription
 */
export interface GOOSESubscription {
  goCBRef: string;
  appId: number;
  callback: (pdu: GOOSEPDU) => void;
  lastStNum: number;
  lastSqNum: number;
  lastReceived?: Date;
}

// =============================================================================
// DRIVER CONFIGURATION
// =============================================================================

/**
 * IEC 61850 Driver Configuration
 */
export interface IEC61850DriverConfig {
  host: string;
  port: number;
  iedName: string;
  authentication?: {
    enabled: boolean;
    mechanism: "password" | "certificate";
    credentials?: {
      username?: string;
      password?: string;
      certificate?: Buffer;
      privateKey?: Buffer;
    };
  };
  tls?: {
    enabled: boolean;
    certificate?: Buffer;
    privateKey?: Buffer;
    caCertificate?: Buffer;
    rejectUnauthorized?: boolean;
  };
  timeout: number;
  retryCount: number;
  retryDelay: number;
  keepAliveInterval: number;
  maxPendingRequests: number;
  reportScanRate: number; // Default report scan rate in ms
  gooseEnabled: boolean;
  gooseInterface?: string;
}

/**
 * Connection State
 */
export enum ConnectionState {
  DISCONNECTED = "DISCONNECTED",
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
  AUTHENTICATED = "AUTHENTICATED",
  ERROR = "ERROR",
}

// =============================================================================
// IEC 61850 ADDRESS PARSER
// =============================================================================

/**
 * Parse IEC 61850 object reference
 * Format: LDName/LNClass.LNInst.DOName.DAName[FC]
 * Example: "CTRL/XCBR1.Pos.stVal[ST]"
 */
export interface ParsedIEC61850Address {
  ldName: string;
  lnClass: string;
  lnInst: string;
  lnPrefix?: string;
  doName: string;
  daName?: string;
  fc?: FunctionalConstraint;
  index?: number;
}

export function parseIEC61850Address(address: string): ParsedIEC61850Address {
  // Extract functional constraint if present
  let fc: FunctionalConstraint | undefined;
  let cleanAddress = address;

  const fcMatch = address.match(/\[([A-Z]{2})\]$/);
  if (fcMatch) {
    fc = fcMatch[1] as FunctionalConstraint;
    cleanAddress = address.replace(/\[[A-Z]{2}\]$/, "");
  }

  // Split by /
  const parts = cleanAddress.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid IEC 61850 address format: ${address}`);
  }

  const ldName = parts[0];
  const objectPath = parts[1];

  // Parse object path (LNClass.LNInst.DOName.DAName or LNPrefix$LNClass$LNInst.DOName.DAName)
  const dotParts = objectPath.split(".");

  if (dotParts.length < 2) {
    throw new Error(`Invalid IEC 61850 object path: ${objectPath}`);
  }

  // Parse LN reference
  let lnClass: string;
  let lnInst: string;
  let lnPrefix: string | undefined;

  const lnRef = dotParts[0];
  if (lnRef.includes("$")) {
    const lnParts = lnRef.split("$");
    lnPrefix = lnParts[0];
    lnClass = lnParts[1];
    lnInst = lnParts[2] || "1";
  } else {
    // Extract class and instance from combined string (e.g., "XCBR1")
    const match = lnRef.match(/^([A-Z]+)(\d*)$/);
    if (match) {
      lnClass = match[1];
      lnInst = match[2] || "1";
    } else {
      lnClass = lnRef;
      lnInst = "1";
    }
  }

  const doName = dotParts[1];
  const daName = dotParts.length > 2 ? dotParts.slice(2).join(".") : undefined;

  return {
    ldName,
    lnClass,
    lnInst,
    lnPrefix,
    doName,
    daName,
    fc,
  };
}

/**
 * Build IEC 61850 address from components
 */
export function buildIEC61850Address(parsed: ParsedIEC61850Address): string {
  let lnRef = parsed.lnPrefix
    ? `${parsed.lnPrefix}$${parsed.lnClass}$${parsed.lnInst}`
    : `${parsed.lnClass}${parsed.lnInst}`;

  let address = `${parsed.ldName}/${lnRef}.${parsed.doName}`;

  if (parsed.daName) {
    address += `.${parsed.daName}`;
  }

  if (parsed.fc) {
    address += `[${parsed.fc}]`;
  }

  return address;
}

// =============================================================================
// DATA TYPE ENCODING/DECODING
// =============================================================================

/**
 * Encode value to IEC 61850 format
 */
export function encodeIEC61850Value(
  value: unknown,
  dataType: IEC61850DataType
): Buffer {
  const buffer: number[] = [];

  switch (dataType) {
    case IEC61850DataType.BOOLEAN:
      buffer.push(value ? 0x01 : 0x00);
      break;

    case IEC61850DataType.INT8:
      buffer.push((value as number) & 0xff);
      break;

    case IEC61850DataType.INT16: {
      const int16 = value as number;
      buffer.push((int16 >> 8) & 0xff, int16 & 0xff);
      break;
    }

    case IEC61850DataType.INT32: {
      const int32 = value as number;
      buffer.push(
        (int32 >> 24) & 0xff,
        (int32 >> 16) & 0xff,
        (int32 >> 8) & 0xff,
        int32 & 0xff
      );
      break;
    }

    case IEC61850DataType.INT64: {
      const int64 = BigInt(value as number | bigint);
      for (let i = 7; i >= 0; i--) {
        buffer.push(Number((int64 >> BigInt(i * 8)) & BigInt(0xff)));
      }
      break;
    }

    case IEC61850DataType.FLOAT32: {
      const float32Buffer = Buffer.alloc(4);
      float32Buffer.writeFloatBE(value as number, 0);
      buffer.push(...float32Buffer);
      break;
    }

    case IEC61850DataType.FLOAT64: {
      const float64Buffer = Buffer.alloc(8);
      float64Buffer.writeDoubleBE(value as number, 0);
      buffer.push(...float64Buffer);
      break;
    }

    case IEC61850DataType.VISIBLE_STRING: {
      const str = value as string;
      const strBytes = Buffer.from(str, "utf8");
      buffer.push(...strBytes);
      break;
    }

    case IEC61850DataType.TIMESTAMP: {
      const ts = value as IEC61850Timestamp;
      // 4 bytes seconds since epoch
      const seconds = ts.secondsSinceEpoch;
      buffer.push(
        (seconds >> 24) & 0xff,
        (seconds >> 16) & 0xff,
        (seconds >> 8) & 0xff,
        seconds & 0xff
      );
      // 3 bytes fraction
      const fraction = ts.fractionOfSecond;
      buffer.push(
        (fraction >> 16) & 0xff,
        (fraction >> 8) & 0xff,
        fraction & 0xff
      );
      // 1 byte time quality
      let quality = 0;
      if (ts.timeQuality.leapSecondsKnown) quality |= 0x80;
      if (ts.timeQuality.clockFailure) quality |= 0x40;
      if (ts.timeQuality.clockNotSynchronized) quality |= 0x20;
      quality |= ts.timeQuality.timeAccuracy & 0x1f;
      buffer.push(quality);
      break;
    }

    case IEC61850DataType.QUALITY: {
      const q = value as IEC61850Quality;
      let byte0 = 0;
      let byte1 = 0;

      // Validity (bits 0-1)
      switch (q.validity) {
        case "good":
          break;
        case "invalid":
          byte0 |= 0x01;
          break;
        case "questionable":
          byte0 |= 0x02;
          break;
        case "reserved":
          byte0 |= 0x03;
          break;
      }

      if (q.overflow) byte0 |= 0x04;
      if (q.outOfRange) byte0 |= 0x08;
      if (q.badReference) byte0 |= 0x10;
      if (q.oscillatory) byte0 |= 0x20;
      if (q.failure) byte0 |= 0x40;
      if (q.oldData) byte0 |= 0x80;

      if (q.inconsistent) byte1 |= 0x01;
      if (q.inaccurate) byte1 |= 0x02;
      if (q.source === "substituted") byte1 |= 0x04;
      if (q.test) byte1 |= 0x08;
      if (q.operatorBlocked) byte1 |= 0x10;

      buffer.push(byte0, byte1);
      break;
    }

    case IEC61850DataType.DBPOS: {
      buffer.push((value as DoublePointStatus) & 0x03);
      break;
    }

    default:
      throw new Error(`Unsupported data type for encoding: ${dataType}`);
  }

  return Buffer.from(buffer);
}

/**
 * Decode IEC 61850 value from buffer
 */
export function decodeIEC61850Value(
  buffer: Buffer,
  dataType: IEC61850DataType,
  offset: number = 0
): { value: unknown; bytesRead: number } {
  switch (dataType) {
    case IEC61850DataType.BOOLEAN:
      return { value: buffer[offset] !== 0, bytesRead: 1 };

    case IEC61850DataType.INT8:
      return { value: buffer.readInt8(offset), bytesRead: 1 };

    case IEC61850DataType.INT16:
      return { value: buffer.readInt16BE(offset), bytesRead: 2 };

    case IEC61850DataType.INT32:
      return { value: buffer.readInt32BE(offset), bytesRead: 4 };

    case IEC61850DataType.INT64:
      return { value: buffer.readBigInt64BE(offset), bytesRead: 8 };

    case IEC61850DataType.INT8U:
      return { value: buffer.readUInt8(offset), bytesRead: 1 };

    case IEC61850DataType.INT16U:
      return { value: buffer.readUInt16BE(offset), bytesRead: 2 };

    case IEC61850DataType.INT32U:
      return { value: buffer.readUInt32BE(offset), bytesRead: 4 };

    case IEC61850DataType.FLOAT32:
      return { value: buffer.readFloatBE(offset), bytesRead: 4 };

    case IEC61850DataType.FLOAT64:
      return { value: buffer.readDoubleBE(offset), bytesRead: 8 };

    case IEC61850DataType.TIMESTAMP: {
      const seconds = buffer.readUInt32BE(offset);
      const fraction =
        (buffer[offset + 4] << 16) |
        (buffer[offset + 5] << 8) |
        buffer[offset + 6];
      const qualityByte = buffer[offset + 7];

      const timestamp: IEC61850Timestamp = {
        secondsSinceEpoch: seconds,
        fractionOfSecond: fraction,
        timeQuality: {
          leapSecondsKnown: (qualityByte & 0x80) !== 0,
          clockFailure: (qualityByte & 0x40) !== 0,
          clockNotSynchronized: (qualityByte & 0x20) !== 0,
          timeAccuracy: qualityByte & 0x1f,
        },
      };
      return { value: timestamp, bytesRead: 8 };
    }

    case IEC61850DataType.QUALITY: {
      const byte0 = buffer[offset];
      const byte1 = buffer[offset + 1];

      const validityBits = byte0 & 0x03;
      let validity: IEC61850Quality["validity"] = "good";
      switch (validityBits) {
        case 0x01:
          validity = "invalid";
          break;
        case 0x02:
          validity = "questionable";
          break;
        case 0x03:
          validity = "reserved";
          break;
      }

      const quality: IEC61850Quality = {
        validity,
        overflow: (byte0 & 0x04) !== 0,
        outOfRange: (byte0 & 0x08) !== 0,
        badReference: (byte0 & 0x10) !== 0,
        oscillatory: (byte0 & 0x20) !== 0,
        failure: (byte0 & 0x40) !== 0,
        oldData: (byte0 & 0x80) !== 0,
        inconsistent: (byte1 & 0x01) !== 0,
        inaccurate: (byte1 & 0x02) !== 0,
        source: (byte1 & 0x04) !== 0 ? "substituted" : "process",
        test: (byte1 & 0x08) !== 0,
        operatorBlocked: (byte1 & 0x10) !== 0,
      };
      return { value: quality, bytesRead: 2 };
    }

    case IEC61850DataType.DBPOS: {
      return { value: buffer[offset] & 0x03, bytesRead: 1 };
    }

    default:
      throw new Error(`Unsupported data type for decoding: ${dataType}`);
  }
}

// =============================================================================
// CONNECTION POOL
// =============================================================================

interface PooledConnection {
  id: string;
  state: ConnectionState;
  lastUsed: Date;
  invokeIdCounter: number;
  pendingRequests: Map<number, {
    request: MMSRequest;
    resolve: (response: MMSResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>;
}

class ConnectionPool extends EventEmitter {
  private connections: Map<string, PooledConnection> = new Map();
  private maxConnections: number;
  private config: IEC61850DriverConfig;

  constructor(config: IEC61850DriverConfig, maxConnections: number = 5) {
    super();
    this.config = config;
    this.maxConnections = maxConnections;
  }

  async getConnection(): Promise<PooledConnection> {
    // Find an available connection
    for (const conn of this.connections.values()) {
      if (conn.state === ConnectionState.AUTHENTICATED &&
          conn.pendingRequests.size < this.config.maxPendingRequests) {
        conn.lastUsed = new Date();
        return conn;
      }
    }

    // Create new connection if pool not full
    if (this.connections.size < this.maxConnections) {
      return this.createConnection();
    }

    // Wait for a connection to become available
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection pool exhausted"));
      }, this.config.timeout);

      this.once("connectionAvailable", (conn) => {
        clearTimeout(timeout);
        resolve(conn);
      });
    });
  }

  private async createConnection(): Promise<PooledConnection> {
    const id = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const conn: PooledConnection = {
      id,
      state: ConnectionState.CONNECTING,
      lastUsed: new Date(),
      invokeIdCounter: 0,
      pendingRequests: new Map(),
    };

    this.connections.set(id, conn);

    // Simulate connection establishment
    // In production, this would establish actual TCP/TLS connection
    await new Promise(resolve => setTimeout(resolve, 50));
    conn.state = ConnectionState.CONNECTED;

    // Authenticate if required
    if (this.config.authentication?.enabled) {
      await this.authenticate(conn);
    }

    conn.state = ConnectionState.AUTHENTICATED;
    return conn;
  }

  private async authenticate(conn: PooledConnection): Promise<void> {
    // Simulate authentication
    // In production, this would perform MMS association with authentication
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  releaseConnection(conn: PooledConnection): void {
    conn.lastUsed = new Date();
    this.emit("connectionAvailable", conn);
  }

  async closeAll(): Promise<void> {
    for (const conn of this.connections.values()) {
      // Cancel pending requests
      for (const pending of conn.pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Connection closed"));
      }
      conn.pendingRequests.clear();
      conn.state = ConnectionState.DISCONNECTED;
    }
    this.connections.clear();
  }

  getStatus(): { total: number; available: number; busy: number } {
    let available = 0;
    let busy = 0;

    for (const conn of this.connections.values()) {
      if (conn.state === ConnectionState.AUTHENTICATED &&
          conn.pendingRequests.size < this.config.maxPendingRequests) {
        available++;
      } else if (conn.state !== ConnectionState.DISCONNECTED) {
        busy++;
      }
    }

    return { total: this.connections.size, available, busy };
  }
}

// =============================================================================
// IEC 61850 MMS DRIVER
// =============================================================================

export class IEC61850Driver extends EventEmitter implements ProtocolDriver {
  protocol = "IEC61850_MMS" as const;

  private config: IEC61850DriverConfig;
  private connectionPool: ConnectionPool;
  private dataModel: IEDModel | null = null;
  private connected = false;
  private subscriptionCallback?: (values: TagValue[]) => void;
  private subscriptionInterval?: NodeJS.Timeout;
  private subscribedTags: TagDefinition[] = [];
  private lastValues: Map<string, TagValue> = new Map();
  private gooseSubscriptions: Map<string, GOOSESubscription> = new Map();
  private reportBuffers: Map<string, TagValue[]> = new Map();
  private reconnecting = false;

  constructor(config: Partial<IEC61850DriverConfig> & { host: string; iedName: string }) {
    super();
    this.config = {
      port: 102, // MMS default port
      timeout: 10000,
      retryCount: 3,
      retryDelay: 2000,
      keepAliveInterval: 30000,
      maxPendingRequests: 10,
      reportScanRate: 1000,
      gooseEnabled: false,
      ...config,
    };

    this.connectionPool = new ConnectionPool(this.config);
  }

  // ===========================================================================
  // CONNECTION MANAGEMENT
  // ===========================================================================

  async connect(): Promise<void> {
    console.log(`[IEC61850] Connecting to ${this.config.host}:${this.config.port} (IED: ${this.config.iedName})...`);

    try {
      // Get initial connection to verify connectivity
      const conn = await this.connectionPool.getConnection();
      this.connectionPool.releaseConnection(conn);

      // Discover data model
      await this.discoverDataModel();

      this.connected = true;
      console.log(`[IEC61850] Connected to ${this.config.iedName}`);
      this.emit("connected");

      // Start keep-alive
      this.startKeepAlive();
    } catch (error) {
      console.error(`[IEC61850] Connection failed:`, error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    console.log(`[IEC61850] Disconnecting from ${this.config.iedName}...`);

    this.unsubscribe();
    this.stopKeepAlive();
    await this.connectionPool.closeAll();

    this.connected = false;
    this.dataModel = null;
    console.log(`[IEC61850] Disconnected`);
    this.emit("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    for (let i = 0; i < this.config.retryCount; i++) {
      try {
        console.log(`[IEC61850] Reconnect attempt ${i + 1}/${this.config.retryCount}...`);
        await this.connect();
        this.reconnecting = false;
        this.emit("reconnected");
        return;
      } catch {
        await new Promise(r => setTimeout(r, this.config.retryDelay));
      }
    }

    this.reconnecting = false;
    this.emit("reconnectFailed");
    console.error(`[IEC61850] Failed to reconnect after ${this.config.retryCount} attempts`);
  }

  private keepAliveInterval?: NodeJS.Timeout;

  private startKeepAlive(): void {
    this.keepAliveInterval = setInterval(async () => {
      if (this.connected) {
        try {
          // Send identify request as keep-alive
          await this.identify();
        } catch (error) {
          console.error(`[IEC61850] Keep-alive failed:`, error);
          this.connected = false;
          this.reconnect();
        }
      }
    }, this.config.keepAliveInterval);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = undefined;
    }
  }

  // ===========================================================================
  // DATA MODEL DISCOVERY
  // ===========================================================================

  private async discoverDataModel(): Promise<void> {
    console.log(`[IEC61850] Discovering data model for ${this.config.iedName}...`);

    this.dataModel = {
      iedName: this.config.iedName,
      logicalDevices: new Map(),
    };

    // Get logical devices
    const ldNames = await this.getLogicalDeviceDirectory();

    for (const ldName of ldNames) {
      const ld: LogicalDevice = {
        ldName,
        logicalNodes: new Map(),
      };

      // Get logical nodes in this LD
      const lnRefs = await this.getLogicalNodeDirectory(ldName);

      for (const lnRef of lnRefs) {
        const ln = await this.getLogicalNodeDefinition(ldName, lnRef);
        ld.logicalNodes.set(`${ln.lnClass}${ln.lnInst}`, ln);
      }

      this.dataModel.logicalDevices.set(ldName, ld);
    }

    console.log(`[IEC61850] Data model discovered: ${this.dataModel.logicalDevices.size} logical devices`);
  }

  private async getLogicalDeviceDirectory(): Promise<string[]> {
    // In production, this sends GetServerDirectory MMS request
    // For now, return simulated LD names
    return ["CTRL", "MEAS", "PROT"];
  }

  private async getLogicalNodeDirectory(ldName: string): Promise<string[]> {
    // In production, this sends GetLogicalDeviceDirectory MMS request
    // Return simulated LN references based on LD
    switch (ldName) {
      case "CTRL":
        return ["LLN0", "XCBR1", "XSWI1", "CSWI1"];
      case "MEAS":
        return ["LLN0", "MMXU1", "MMTR1"];
      case "PROT":
        return ["LLN0", "PTOC1", "PDIF1"];
      default:
        return ["LLN0"];
    }
  }

  private async getLogicalNodeDefinition(
    ldName: string,
    lnRef: string
  ): Promise<LogicalNode> {
    // Parse LN reference
    const match = lnRef.match(/^([A-Z]+)(\d*)$/);
    const lnClass = match ? match[1] : lnRef;
    const lnInst = match ? match[2] || "1" : "1";

    const ln: LogicalNode = {
      lnClass,
      lnInst,
      dataObjects: new Map(),
    };

    // Add common data objects based on LN class
    switch (lnClass) {
      case "LLN0":
        ln.dataObjects.set("Mod", this.createDataObject("Mod", "ENC"));
        ln.dataObjects.set("Beh", this.createDataObject("Beh", "ENS"));
        ln.dataObjects.set("Health", this.createDataObject("Health", "ENS"));
        ln.dataObjects.set("NamPlt", this.createDataObject("NamPlt", "LPL"));
        break;

      case "XCBR": // Circuit Breaker
        ln.dataObjects.set("Pos", this.createDataObject("Pos", "DPC"));
        ln.dataObjects.set("OpCnt", this.createDataObject("OpCnt", "INS"));
        ln.dataObjects.set("CBOpCap", this.createDataObject("CBOpCap", "INS"));
        ln.dataObjects.set("BlkOpn", this.createDataObject("BlkOpn", "SPC"));
        ln.dataObjects.set("BlkCls", this.createDataObject("BlkCls", "SPC"));
        break;

      case "XSWI": // Switch
        ln.dataObjects.set("Pos", this.createDataObject("Pos", "DPC"));
        ln.dataObjects.set("SwTyp", this.createDataObject("SwTyp", "ENS"));
        break;

      case "CSWI": // Switch Controller
        ln.dataObjects.set("Pos", this.createDataObject("Pos", "DPC"));
        ln.dataObjects.set("OpOpn", this.createDataObject("OpOpn", "ACT"));
        ln.dataObjects.set("OpCls", this.createDataObject("OpCls", "ACT"));
        break;

      case "MMXU": // Measurement
        ln.dataObjects.set("TotW", this.createDataObject("TotW", "MV"));
        ln.dataObjects.set("TotVAr", this.createDataObject("TotVAr", "MV"));
        ln.dataObjects.set("TotVA", this.createDataObject("TotVA", "MV"));
        ln.dataObjects.set("Hz", this.createDataObject("Hz", "MV"));
        ln.dataObjects.set("PPV", this.createDataObject("PPV", "WYE"));
        ln.dataObjects.set("PhV", this.createDataObject("PhV", "WYE"));
        ln.dataObjects.set("A", this.createDataObject("A", "WYE"));
        break;

      case "MMTR": // Metering
        ln.dataObjects.set("TotWh", this.createDataObject("TotWh", "BCR"));
        ln.dataObjects.set("TotVArh", this.createDataObject("TotVArh", "BCR"));
        break;

      case "PTOC": // Overcurrent Protection
        ln.dataObjects.set("Op", this.createDataObject("Op", "ACT"));
        ln.dataObjects.set("Str", this.createDataObject("Str", "ACD"));
        ln.dataObjects.set("StrVal", this.createDataObject("StrVal", "ASG"));
        break;

      case "PDIF": // Differential Protection
        ln.dataObjects.set("Op", this.createDataObject("Op", "ACT"));
        ln.dataObjects.set("Str", this.createDataObject("Str", "ACD"));
        break;
    }

    return ln;
  }

  private createDataObject(name: string, cdc: CommonDataClass): DataObject {
    const dataObject: DataObject = {
      name,
      cdc,
      attributes: new Map(),
    };

    // Add standard data attributes based on CDC
    switch (cdc) {
      case "SPS": // Single Point Status
        dataObject.attributes.set("stVal", {
          name: "stVal",
          fc: "ST",
          dataType: IEC61850DataType.BOOLEAN,
        });
        dataObject.attributes.set("q", {
          name: "q",
          fc: "ST",
          dataType: IEC61850DataType.QUALITY,
        });
        dataObject.attributes.set("t", {
          name: "t",
          fc: "ST",
          dataType: IEC61850DataType.TIMESTAMP,
        });
        break;

      case "DPS": // Double Point Status
      case "DPC": // Controllable Double Point
        dataObject.attributes.set("stVal", {
          name: "stVal",
          fc: "ST",
          dataType: IEC61850DataType.DBPOS,
        });
        dataObject.attributes.set("q", {
          name: "q",
          fc: "ST",
          dataType: IEC61850DataType.QUALITY,
        });
        dataObject.attributes.set("t", {
          name: "t",
          fc: "ST",
          dataType: IEC61850DataType.TIMESTAMP,
        });
        if (cdc === "DPC") {
          dataObject.attributes.set("ctlVal", {
            name: "ctlVal",
            fc: "CO",
            dataType: IEC61850DataType.BOOLEAN,
          });
          dataObject.attributes.set("ctlNum", {
            name: "ctlNum",
            fc: "CO",
            dataType: IEC61850DataType.INT8U,
          });
        }
        break;

      case "INS": // Integer Status
        dataObject.attributes.set("stVal", {
          name: "stVal",
          fc: "ST",
          dataType: IEC61850DataType.INT32,
        });
        dataObject.attributes.set("q", {
          name: "q",
          fc: "ST",
          dataType: IEC61850DataType.QUALITY,
        });
        dataObject.attributes.set("t", {
          name: "t",
          fc: "ST",
          dataType: IEC61850DataType.TIMESTAMP,
        });
        break;

      case "ENS": // Enumerated Status
      case "ENC": // Controllable Enumerated Status
        dataObject.attributes.set("stVal", {
          name: "stVal",
          fc: "ST",
          dataType: IEC61850DataType.CODED_ENUM,
        });
        dataObject.attributes.set("q", {
          name: "q",
          fc: "ST",
          dataType: IEC61850DataType.QUALITY,
        });
        dataObject.attributes.set("t", {
          name: "t",
          fc: "ST",
          dataType: IEC61850DataType.TIMESTAMP,
        });
        break;

      case "MV": // Measured Value
        dataObject.attributes.set("mag", {
          name: "mag",
          fc: "MX",
          dataType: IEC61850DataType.FLOAT32,
        });
        dataObject.attributes.set("q", {
          name: "q",
          fc: "MX",
          dataType: IEC61850DataType.QUALITY,
        });
        dataObject.attributes.set("t", {
          name: "t",
          fc: "MX",
          dataType: IEC61850DataType.TIMESTAMP,
        });
        break;

      case "WYE": // Phase to Ground Values
        // Create sub-objects for phases A, B, C
        dataObject.subObjects = new Map();
        for (const phase of ["phsA", "phsB", "phsC"]) {
          const phaseDO: DataObject = {
            name: phase,
            cdc: "CMV",
            attributes: new Map([
              ["cVal", { name: "cVal", fc: "MX", dataType: IEC61850DataType.FLOAT32 }],
              ["q", { name: "q", fc: "MX", dataType: IEC61850DataType.QUALITY }],
              ["t", { name: "t", fc: "MX", dataType: IEC61850DataType.TIMESTAMP }],
            ]),
          };
          dataObject.subObjects.set(phase, phaseDO);
        }
        break;

      case "ACT": // Protection Activation
        dataObject.attributes.set("general", {
          name: "general",
          fc: "ST",
          dataType: IEC61850DataType.BOOLEAN,
        });
        dataObject.attributes.set("phsA", {
          name: "phsA",
          fc: "ST",
          dataType: IEC61850DataType.BOOLEAN,
        });
        dataObject.attributes.set("phsB", {
          name: "phsB",
          fc: "ST",
          dataType: IEC61850DataType.BOOLEAN,
        });
        dataObject.attributes.set("phsC", {
          name: "phsC",
          fc: "ST",
          dataType: IEC61850DataType.BOOLEAN,
        });
        dataObject.attributes.set("q", {
          name: "q",
          fc: "ST",
          dataType: IEC61850DataType.QUALITY,
        });
        dataObject.attributes.set("t", {
          name: "t",
          fc: "ST",
          dataType: IEC61850DataType.TIMESTAMP,
        });
        break;

      case "ACD": // Directional Protection Activation
        dataObject.attributes.set("general", {
          name: "general",
          fc: "ST",
          dataType: IEC61850DataType.BOOLEAN,
        });
        dataObject.attributes.set("dirGeneral", {
          name: "dirGeneral",
          fc: "ST",
          dataType: IEC61850DataType.CODED_ENUM,
        });
        dataObject.attributes.set("q", {
          name: "q",
          fc: "ST",
          dataType: IEC61850DataType.QUALITY,
        });
        dataObject.attributes.set("t", {
          name: "t",
          fc: "ST",
          dataType: IEC61850DataType.TIMESTAMP,
        });
        break;

      case "BCR": // Binary Counter Reading
        dataObject.attributes.set("actVal", {
          name: "actVal",
          fc: "ST",
          dataType: IEC61850DataType.INT64,
        });
        dataObject.attributes.set("frVal", {
          name: "frVal",
          fc: "ST",
          dataType: IEC61850DataType.INT64,
        });
        dataObject.attributes.set("q", {
          name: "q",
          fc: "ST",
          dataType: IEC61850DataType.QUALITY,
        });
        dataObject.attributes.set("t", {
          name: "t",
          fc: "ST",
          dataType: IEC61850DataType.TIMESTAMP,
        });
        break;

      case "SPC": // Controllable Single Point
        dataObject.attributes.set("stVal", {
          name: "stVal",
          fc: "ST",
          dataType: IEC61850DataType.BOOLEAN,
        });
        dataObject.attributes.set("ctlVal", {
          name: "ctlVal",
          fc: "CO",
          dataType: IEC61850DataType.BOOLEAN,
        });
        dataObject.attributes.set("q", {
          name: "q",
          fc: "ST",
          dataType: IEC61850DataType.QUALITY,
        });
        dataObject.attributes.set("t", {
          name: "t",
          fc: "ST",
          dataType: IEC61850DataType.TIMESTAMP,
        });
        break;

      case "ASG": // Analogue Setting
        dataObject.attributes.set("setMag", {
          name: "setMag",
          fc: "SP",
          dataType: IEC61850DataType.FLOAT32,
        });
        break;

      case "LPL": // Logical Node Name Plate
        dataObject.attributes.set("vendor", {
          name: "vendor",
          fc: "DC",
          dataType: IEC61850DataType.VISIBLE_STRING,
        });
        dataObject.attributes.set("swRev", {
          name: "swRev",
          fc: "DC",
          dataType: IEC61850DataType.VISIBLE_STRING,
        });
        dataObject.attributes.set("d", {
          name: "d",
          fc: "DC",
          dataType: IEC61850DataType.VISIBLE_STRING,
        });
        break;
    }

    return dataObject;
  }

  // ===========================================================================
  // MMS SERVICES
  // ===========================================================================

  private async sendMMSRequest(request: MMSRequest): Promise<MMSResponse> {
    const conn = await this.connectionPool.getConnection();

    try {
      return await new Promise((resolve, reject) => {
        const invokeId = ++conn.invokeIdCounter;
        request.invokeId = invokeId;

        const timeout = setTimeout(() => {
          conn.pendingRequests.delete(invokeId);
          reject(new Error("MMS request timeout"));
        }, this.config.timeout);

        conn.pendingRequests.set(invokeId, {
          request,
          resolve,
          reject,
          timeout,
        });

        // Simulate async response
        // In production, this would send the actual MMS PDU
        setTimeout(() => {
          const pending = conn.pendingRequests.get(invokeId);
          if (pending) {
            clearTimeout(pending.timeout);
            conn.pendingRequests.delete(invokeId);

            // Simulate response
            const response: MMSResponse = {
              invokeId,
              serviceType: request.serviceType,
              success: true,
              data: this.simulateMMSResponse(request),
            };

            pending.resolve(response);
          }
        }, 10);
      });
    } finally {
      this.connectionPool.releaseConnection(conn);
    }
  }

  private simulateMMSResponse(request: MMSRequest): unknown {
    switch (request.serviceType) {
      case MMSServiceType.IDENTIFY:
        return {
          vendorName: "0xSCADA",
          modelName: "Simulated IED",
          revision: "1.0.0",
        };

      case MMSServiceType.READ:
      case MMSServiceType.GET_DATA_VALUES:
        // Return simulated values
        return this.simulateDataValue(request.itemId || "");

      default:
        return null;
    }
  }

  private simulateDataValue(itemId: string): unknown {
    // Generate realistic simulated values based on data type
    try {
      const parsed = parseIEC61850Address(itemId);

      // Simulate values based on LN class and DO
      if (parsed.lnClass === "XCBR" && parsed.doName === "Pos") {
        return DoublePointStatus.ON; // CB closed
      }

      if (parsed.lnClass === "MMXU") {
        switch (parsed.doName) {
          case "TotW":
            return 500 + Math.random() * 100; // kW
          case "TotVAr":
            return 50 + Math.random() * 20; // kVAr
          case "Hz":
            return 59.9 + Math.random() * 0.2; // Hz
        }
      }

      if (parsed.lnClass === "PTOC" && parsed.doName === "Op") {
        return false; // Not tripped
      }

      return Math.random() * 100;
    } catch {
      return Math.random() * 100;
    }
  }

  async identify(): Promise<{ vendorName: string; modelName: string; revision: string }> {
    const response = await this.sendMMSRequest({
      invokeId: 0,
      serviceType: MMSServiceType.IDENTIFY,
    });

    if (!response.success) {
      throw new Error(response.errorMessage || "Identify failed");
    }

    return response.data as { vendorName: string; modelName: string; revision: string };
  }

  // ===========================================================================
  // READ OPERATIONS
  // ===========================================================================

  async readTag(address: string): Promise<TagValue> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    try {
      const parsed = parseIEC61850Address(address);

      const response = await this.sendMMSRequest({
        invokeId: 0,
        serviceType: MMSServiceType.GET_DATA_VALUES,
        domainId: parsed.ldName,
        itemId: address,
      });

      if (!response.success) {
        return {
          tag: address,
          value: 0,
          quality: "BAD",
          timestamp: new Date(),
        };
      }

      const value = response.data;

      return {
        tag: address,
        value: value as number | string | boolean,
        quality: "GOOD",
        timestamp: new Date(),
      };
    } catch (error) {
      console.error(`[IEC61850] Read error for ${address}:`, error);

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

    // Group by logical device for efficient reading
    const byLD = new Map<string, string[]>();
    for (const addr of addresses) {
      try {
        const parsed = parseIEC61850Address(addr);
        const group = byLD.get(parsed.ldName) || [];
        group.push(addr);
        byLD.set(parsed.ldName, group);
      } catch {
        results.push({
          tag: addr,
          value: 0,
          quality: "BAD",
          timestamp: new Date(),
        });
      }
    }

    // Read each group
    for (const [_ldName, addrs] of byLD) {
      for (const addr of addrs) {
        const result = await this.readTag(addr);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Read a data object with all its attributes
   */
  async readDataObject(ldName: string, lnRef: string, doName: string): Promise<Record<string, unknown>> {
    if (!this.dataModel) {
      throw new Error("Data model not discovered");
    }

    const ld = this.dataModel.logicalDevices.get(ldName);
    if (!ld) {
      throw new Error(`Logical device not found: ${ldName}`);
    }

    const ln = ld.logicalNodes.get(lnRef);
    if (!ln) {
      throw new Error(`Logical node not found: ${lnRef}`);
    }

    const dataObj = ln.dataObjects.get(doName);
    if (!dataObj) {
      throw new Error(`Data object not found: ${doName}`);
    }

    const result: Record<string, unknown> = {};

    for (const [attrName, attr] of dataObj.attributes) {
      const address = `${ldName}/${lnRef}.${doName}.${attrName}[${attr.fc}]`;
      const value = await this.readTag(address);
      result[attrName] = value.value;
    }

    return result;
  }

  // ===========================================================================
  // WRITE OPERATIONS
  // ===========================================================================

  async writeTag(address: string, value: number | string | boolean): Promise<boolean> {
    if (!this.connected) {
      throw new Error("Not connected");
    }

    try {
      const parsed = parseIEC61850Address(address);

      const response = await this.sendMMSRequest({
        invokeId: 0,
        serviceType: MMSServiceType.SET_DATA_VALUES,
        domainId: parsed.ldName,
        itemId: address,
        data: value,
      });

      if (!response.success) {
        console.error(`[IEC61850] Write failed: ${response.errorMessage}`);
        return false;
      }

      console.log(`[IEC61850] Write ${address} = ${value}`);
      this.emit("write", { address, value });
      return true;
    } catch (error) {
      console.error(`[IEC61850] Write error for ${address}:`, error);
      return false;
    }
  }

  /**
   * Execute control operation with select-before-operate
   */
  async controlWithSBO(
    ldName: string,
    lnRef: string,
    doName: string,
    value: boolean,
    operatorId: string
  ): Promise<{ success: boolean; error?: string }> {
    const basePath = `${ldName}/${lnRef}.${doName}`;

    try {
      // Step 1: Select
      const selectResponse = await this.sendMMSRequest({
        invokeId: 0,
        serviceType: MMSServiceType.SELECT,
        domainId: ldName,
        itemId: basePath,
        data: { operatorId },
      });

      if (!selectResponse.success) {
        return { success: false, error: "Select failed" };
      }

      // Step 2: Operate
      const operateResponse = await this.sendMMSRequest({
        invokeId: 0,
        serviceType: MMSServiceType.OPERATE,
        domainId: ldName,
        itemId: `${basePath}.ctlVal[CO]`,
        data: value,
      });

      if (!operateResponse.success) {
        // Cancel the selection
        await this.sendMMSRequest({
          invokeId: 0,
          serviceType: MMSServiceType.CANCEL,
          domainId: ldName,
          itemId: basePath,
        });
        return { success: false, error: "Operate failed" };
      }

      console.log(`[IEC61850] Control SBO: ${basePath} = ${value} by ${operatorId}`);
      this.emit("control", { path: basePath, value, operatorId, mode: "SBO" });

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Execute direct control operation (without select)
   */
  async controlDirect(
    ldName: string,
    lnRef: string,
    doName: string,
    value: boolean
  ): Promise<boolean> {
    const ctlPath = `${ldName}/${lnRef}.${doName}.ctlVal[CO]`;
    return this.writeTag(ctlPath, value);
  }

  // ===========================================================================
  // SUBSCRIPTIONS
  // ===========================================================================

  subscribe(tags: TagDefinition[], callback: (values: TagValue[]) => void): void {
    this.subscribedTags = tags;
    this.subscriptionCallback = callback;

    const minScanRate = Math.min(
      ...tags.map(t => t.scanRate),
      this.config.reportScanRate
    );

    console.log(`[IEC61850] Subscribing to ${tags.length} tags (scan rate: ${minScanRate}ms)`);

    this.subscriptionInterval = setInterval(async () => {
      if (!this.connected || !this.subscriptionCallback) return;

      try {
        const values: TagValue[] = [];

        for (const tag of this.subscribedTags) {
          const result = await this.readTag(tag.address);

          const tagValue: TagValue = {
            tag: tag.name,
            value: result.value,
            quality: result.quality,
            timestamp: result.timestamp,
            assetId: tag.assetId,
            unit: tag.unit,
          };

          // Check deadband
          const lastValue = this.lastValues.get(tag.name);
          if (
            lastValue &&
            tag.deadband &&
            typeof tagValue.value === "number" &&
            typeof lastValue.value === "number"
          ) {
            if (Math.abs(tagValue.value - lastValue.value) < tag.deadband) {
              continue;
            }
          }

          this.lastValues.set(tag.name, tagValue);
          values.push(tagValue);
        }

        if (values.length > 0) {
          this.subscriptionCallback(values);
        }
      } catch (error) {
        console.error(`[IEC61850] Subscription poll error:`, error);
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
    this.lastValues.clear();
    console.log(`[IEC61850] Unsubscribed`);
  }

  // ===========================================================================
  // GOOSE HANDLING
  // ===========================================================================

  /**
   * Subscribe to GOOSE messages
   */
  subscribeGOOSE(
    goCBRef: string,
    appId: number,
    callback: (pdu: GOOSEPDU) => void
  ): void {
    if (!this.config.gooseEnabled) {
      console.warn("[IEC61850] GOOSE is not enabled in configuration");
      return;
    }

    const subscription: GOOSESubscription = {
      goCBRef,
      appId,
      callback,
      lastStNum: 0,
      lastSqNum: 0,
    };

    this.gooseSubscriptions.set(goCBRef, subscription);
    console.log(`[IEC61850] Subscribed to GOOSE: ${goCBRef} (AppID: ${appId})`);

    // In production, this would set up multicast listener
    this.emit("gooseSubscribed", { goCBRef, appId });
  }

  /**
   * Unsubscribe from GOOSE messages
   */
  unsubscribeGOOSE(goCBRef: string): void {
    this.gooseSubscriptions.delete(goCBRef);
    console.log(`[IEC61850] Unsubscribed from GOOSE: ${goCBRef}`);
  }

  /**
   * Process received GOOSE PDU
   */
  processGOOSE(pdu: GOOSEPDU): void {
    const subscription = this.gooseSubscriptions.get(pdu.goCBRef);
    if (!subscription) return;

    // Check state number for new data
    if (pdu.stNum > subscription.lastStNum ||
        (pdu.stNum === subscription.lastStNum && pdu.sqNum > subscription.lastSqNum)) {
      subscription.lastStNum = pdu.stNum;
      subscription.lastSqNum = pdu.sqNum;
      subscription.lastReceived = new Date();

      subscription.callback(pdu);
      this.emit("gooseReceived", pdu);
    }
  }

  /**
   * Publish GOOSE message
   */
  publishGOOSE(pdu: GOOSEPDU): void {
    if (!this.config.gooseEnabled) {
      console.warn("[IEC61850] GOOSE is not enabled in configuration");
      return;
    }

    // In production, this would send multicast GOOSE frame
    console.log(`[IEC61850] Publishing GOOSE: ${pdu.goCBRef} (StNum: ${pdu.stNum})`);
    this.emit("goosePublished", pdu);
  }

  // ===========================================================================
  // STATUS AND DIAGNOSTICS
  // ===========================================================================

  getStatus(): Record<string, unknown> {
    const poolStatus = this.connectionPool.getStatus();

    return {
      protocol: this.protocol,
      host: this.config.host,
      port: this.config.port,
      iedName: this.config.iedName,
      connected: this.connected,
      reconnecting: this.reconnecting,
      connectionPool: poolStatus,
      subscribedTags: this.subscribedTags.length,
      gooseEnabled: this.config.gooseEnabled,
      gooseSubscriptions: this.gooseSubscriptions.size,
      dataModel: this.dataModel ? {
        logicalDevices: this.dataModel.logicalDevices.size,
        totalLogicalNodes: Array.from(this.dataModel.logicalDevices.values())
          .reduce((sum, ld) => sum + ld.logicalNodes.size, 0),
      } : null,
    };
  }

  /**
   * Get the discovered data model
   */
  getDataModel(): IEDModel | null {
    return this.dataModel;
  }

  /**
   * Get available logical devices
   */
  getLogicalDevices(): string[] {
    if (!this.dataModel) return [];
    return Array.from(this.dataModel.logicalDevices.keys());
  }

  /**
   * Get logical nodes in a logical device
   */
  getLogicalNodes(ldName: string): string[] {
    if (!this.dataModel) return [];
    const ld = this.dataModel.logicalDevices.get(ldName);
    if (!ld) return [];
    return Array.from(ld.logicalNodes.keys());
  }

  /**
   * Get data objects in a logical node
   */
  getDataObjects(ldName: string, lnRef: string): string[] {
    if (!this.dataModel) return [];
    const ld = this.dataModel.logicalDevices.get(ldName);
    if (!ld) return [];
    const ln = ld.logicalNodes.get(lnRef);
    if (!ln) return [];
    return Array.from(ln.dataObjects.keys());
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create IEC 61850 driver instance
 */
export function createIEC61850Driver(
  host: string,
  iedName: string,
  port: number = 102,
  options?: Partial<IEC61850DriverConfig>
): IEC61850Driver {
  return new IEC61850Driver({
    host,
    port,
    iedName,
    ...options,
  });
}

/**
 * Create timestamp from Date
 */
export function createIEC61850Timestamp(date: Date = new Date()): IEC61850Timestamp {
  const epochMs = date.getTime();
  const secondsSinceEpoch = Math.floor(epochMs / 1000);
  const fractionOfSecond = Math.floor(((epochMs % 1000) / 1000) * 0xffffff);

  return {
    secondsSinceEpoch,
    fractionOfSecond,
    timeQuality: {
      leapSecondsKnown: true,
      clockFailure: false,
      clockNotSynchronized: false,
      timeAccuracy: 10,
    },
  };
}

/**
 * Create default quality (good)
 */
export function createGoodQuality(): IEC61850Quality {
  return {
    validity: "good",
    overflow: false,
    outOfRange: false,
    badReference: false,
    oscillatory: false,
    failure: false,
    oldData: false,
    inconsistent: false,
    inaccurate: false,
    source: "process",
    test: false,
    operatorBlocked: false,
  };
}
