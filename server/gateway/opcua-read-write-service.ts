/**
 * OPC-UA Read/Write Value Service
 *
 * Issue #11 child: 6.1.3 - OPC-UA Read/Write Value Service
 *
 * Provides read/write operations for OPC-UA variable values with:
 * - Single and batch read/write operations
 * - Data type validation before writes
 * - Source and server timestamp support
 * - Status code handling and quality mapping
 * - Configurable batch sizes for efficiency
 */

// =============================================================================
// TYPES
// =============================================================================

export type OpcUaDataType =
  | "Boolean"
  | "Byte"
  | "Int16"
  | "UInt16"
  | "Int32"
  | "UInt32"
  | "Int64"
  | "UInt64"
  | "Float"
  | "Double"
  | "String"
  | "DateTime"
  | "ByteString"
  | "Null";

export type OpcUaQuality = "GOOD" | "BAD" | "UNCERTAIN";

export interface OpcUaStatusCode {
  value: number;
  name: string;
}

export interface ReadValueResult {
  nodeId: string;
  value: unknown;
  dataType: string;
  statusCode: OpcUaStatusCode;
  quality: OpcUaQuality;
  sourceTimestamp: Date | null;
  serverTimestamp: Date | null;
}

export interface WriteValueResult {
  nodeId: string;
  success: boolean;
  statusCode: OpcUaStatusCode;
}

export interface ReadRequest {
  nodeId: string;
  maxAge?: number;
  attributeId?: number;
}

export interface WriteRequest {
  nodeId: string;
  value: unknown;
  dataType: OpcUaDataType;
}

export interface BatchOptions {
  batchSize?: number;
}

/** Abstraction over an OPC-UA client session (e.g. node-opcua ClientSession) */
export interface OpcUaSession {
  read(nodesToRead: Array<Record<string, unknown>>): Promise<Array<{
    statusCode: OpcUaStatusCode;
    value: { value: unknown; dataType: string };
    sourceTimestamp: Date | null;
    serverTimestamp: Date | null;
  }>>;
  write(nodesToWrite: Array<Record<string, unknown>>): Promise<Array<OpcUaStatusCode>>;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Map an OPC-UA numeric status code to a quality string.
 *
 * OPC-UA status code ranges:
 *   0x00000000 – 0x3FFFFFFF  → Good
 *   0x40000000 – 0x7FFFFFFF  → Uncertain
 *   0x80000000 – 0xFFFFFFFF  → Bad
 */
export function mapStatusCode(code: number): OpcUaQuality {
  if (code >= 0x80000000) return "BAD";
  if (code >= 0x40000000) return "UNCERTAIN";
  return "GOOD";
}

/**
 * Validate that a value matches the expected OPC-UA data type.
 */
export function validateDataType(value: unknown, dataType: OpcUaDataType): boolean {
  switch (dataType) {
    case "Boolean":
      return typeof value === "boolean";

    case "Byte":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;

    case "Int16":
      return typeof value === "number" && Number.isInteger(value) && value >= -32768 && value <= 32767;

    case "UInt16":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535;

    case "Int32":
      return typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;

    case "UInt32":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4294967295;

    case "Int64":
    case "UInt64":
      // Simplified: accept numbers and bigints
      return typeof value === "number" || typeof value === "bigint";

    case "Float":
    case "Double":
      return typeof value === "number";

    case "String":
      return typeof value === "string";

    case "DateTime":
      return value instanceof Date || typeof value === "string";

    case "ByteString":
      return value instanceof Uint8Array || Buffer.isBuffer(value);

    case "Null":
      return value === null || value === undefined;

    default:
      return false;
  }
}

// =============================================================================
// SERVICE
// =============================================================================

const DEFAULT_BATCH_SIZE = 100;

export class OpcUaReadWriteService {
  private session: OpcUaSession;

  constructor(session: OpcUaSession) {
    this.session = session;
  }

  // ===========================================================================
  // READ
  // ===========================================================================

  /**
   * Read a single value by nodeId.
   */
  async readValue(nodeId: string): Promise<ReadValueResult> {
    const results = await this.session.read([{ nodeId }]);
    return this.mapReadResult(nodeId, results[0]);
  }

  /**
   * Read a single value with additional options (maxAge, attributeId).
   */
  async readValueWithOptions(request: ReadRequest): Promise<ReadValueResult> {
    const readItem: Record<string, unknown> = { nodeId: request.nodeId };
    if (request.maxAge !== undefined) readItem.maxAge = request.maxAge;
    if (request.attributeId !== undefined) readItem.attributeId = request.attributeId;

    const results = await this.session.read([readItem]);
    return this.mapReadResult(request.nodeId, results[0]);
  }

  /**
   * Read multiple values efficiently. Automatically splits into batches.
   */
  async readValues(
    nodeIds: string[],
    options?: BatchOptions
  ): Promise<ReadValueResult[]> {
    if (nodeIds.length === 0) return [];

    const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
    const allResults: ReadValueResult[] = [];

    for (let i = 0; i < nodeIds.length; i += batchSize) {
      const batch = nodeIds.slice(i, i + batchSize);
      const readItems = batch.map((nodeId) => ({ nodeId }));
      const results = await this.session.read(readItems);

      for (let j = 0; j < results.length; j++) {
        allResults.push(this.mapReadResult(batch[j], results[j]));
      }
    }

    return allResults;
  }

  private mapReadResult(
    nodeId: string,
    raw: {
      statusCode: OpcUaStatusCode;
      value: { value: unknown; dataType: string };
      sourceTimestamp: Date | null;
      serverTimestamp: Date | null;
    }
  ): ReadValueResult {
    return {
      nodeId,
      value: raw.value.value,
      dataType: raw.value.dataType,
      statusCode: raw.statusCode,
      quality: mapStatusCode(raw.statusCode.value),
      sourceTimestamp: raw.sourceTimestamp,
      serverTimestamp: raw.serverTimestamp,
    };
  }

  // ===========================================================================
  // WRITE
  // ===========================================================================

  /**
   * Write a single value with data type validation.
   */
  async writeValue(
    nodeId: string,
    value: unknown,
    dataType: OpcUaDataType
  ): Promise<WriteValueResult> {
    if (!validateDataType(value, dataType)) {
      throw new Error(
        `Data type validation failed: value ${JSON.stringify(value)} is not a valid ${dataType}`
      );
    }

    const results = await this.session.write([
      { nodeId, value: { value, dataType } },
    ]);

    const sc = results[0];
    return {
      nodeId,
      success: sc.value === 0,
      statusCode: sc,
    };
  }

  /**
   * Write multiple values efficiently. Validates all types before sending.
   * Automatically splits into batches.
   */
  async writeValues(
    requests: WriteRequest[],
    options?: BatchOptions
  ): Promise<WriteValueResult[]> {
    if (requests.length === 0) return [];

    // Validate all before sending any
    for (const req of requests) {
      if (!validateDataType(req.value, req.dataType)) {
        throw new Error(
          `Data type validation failed for ${req.nodeId}: value ${JSON.stringify(req.value)} is not a valid ${req.dataType}`
        );
      }
    }

    const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
    const allResults: WriteValueResult[] = [];

    for (let i = 0; i < requests.length; i += batchSize) {
      const batch = requests.slice(i, i + batchSize);
      const writeItems = batch.map((req) => ({
        nodeId: req.nodeId,
        value: { value: req.value, dataType: req.dataType },
      }));

      const results = await this.session.write(writeItems);

      for (let j = 0; j < results.length; j++) {
        const sc = results[j];
        allResults.push({
          nodeId: batch[j].nodeId,
          success: sc.value === 0,
          statusCode: sc,
        });
      }
    }

    return allResults;
  }
}
