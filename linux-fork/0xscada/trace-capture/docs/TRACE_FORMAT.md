# 0xSCADA Trace Format Specification

**Version**: 1.0  
**Status**: Draft  
**Updated**: 2026-02-02

## Overview

This document specifies the binary format for 0xSCADA kernel trace captures.
The format is designed for:

- **Deterministic replay**: All metadata needed to exactly reproduce execution
- **Content addressing**: SHA-256 hashing for LFS artifact storage
- **Cross-platform**: Big-endian encoding, packed structures
- **Extensibility**: Version field and reserved bytes for future use

## Snapshot Structure

A complete snapshot consists of:

```
┌─────────────────────────────────────────────────────────────┐
│                    SNAPSHOT HEADER                          │
│                    (128 bytes, fixed)                       │
├─────────────────────────────────────────────────────────────┤
│                    EVENT 1                                  │
│                    (32 bytes header + variable payload)     │
├─────────────────────────────────────────────────────────────┤
│                    EVENT 2                                  │
│                    ...                                      │
├─────────────────────────────────────────────────────────────┤
│                    EVENT N                                  │
├─────────────────────────────────────────────────────────────┤
│                    CRC32 (in header)                        │
└─────────────────────────────────────────────────────────────┘
```

## Snapshot Header (128 bytes)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0x00 | 4 | magic | 0x5CA0A7CE ("SCADATCE") |
| 0x04 | 4 | version | Format version (currently 1) |
| 0x08 | 8 | snapshot_id | Unique monotonic ID |
| 0x10 | 80 | replay | Replay metadata (see below) |
| 0x60 | 4 | event_count | Number of events |
| 0x64 | 4 | total_size | Total snapshot size in bytes |
| 0x68 | 8 | start_timestamp_ns | First event timestamp |
| 0x70 | 8 | end_timestamp_ns | Last event timestamp |
| 0x78 | 4 | checksum | CRC32 of entire snapshot |
| 0x7C | 12 | reserved | Future use (zeroed) |

**Total**: 128 bytes

## Replay Metadata (80 bytes)

Embedded in snapshot header at offset 0x10:

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0x00 | 8 | capture_timestamp_ns | Boot-relative capture time |
| 0x08 | 8 | boot_id | Random 64-bit boot identifier |
| 0x10 | 4 | cpu_id | Capturing CPU number |
| 0x14 | 4 | sequence_number | Global monotonic sequence |
| 0x18 | 41 | git_commit | Git commit hash (40 hex + null) |
| 0x41 | 3 | padding | Alignment (zeroed) |
| 0x44 | 4 | metadata_version | Metadata format version (1) |
| 0x48 | 4 | checksum | CRC32 of metadata fields |
| 0x4C | 4 | padding | Alignment to 80 bytes |

**Total**: 80 bytes

## Event Header (32 bytes)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0x00 | 4 | magic | 0x5CA0A7CE |
| 0x04 | 2 | type | Event type (see below) |
| 0x06 | 2 | flags | Event flags |
| 0x08 | 8 | timestamp_ns | Boot-relative timestamp |
| 0x10 | 4 | cpu | CPU that recorded event |
| 0x14 | 4 | pid | Process ID |
| 0x18 | 4 | data_len | Payload length |
| 0x1C | 4 | reserved | Future use |

**Total**: 32 bytes

### Event Types

| Value | Name | Description |
|-------|------|-------------|
| 0x01 | FTRACE | ftrace dump |
| 0x02 | EBPF | eBPF program capture |
| 0x03 | SENSOR | Sensor/Modbus burst |
| 0x04 | FIRMWARE | Firmware image chunk |
| 0x05 | IO | I/O operation |
| 0x06 | PROTOCOL | Protocol event |
| 0xFF | CUSTOM | User-defined event |

### Event Flags

| Bit | Name | Description |
|-----|------|-------------|
| 0 | REALTIME | Captured in RT context |
| 1 | ATOMIC | Part of atomic snapshot |
| 2 | OVERFLOW | Buffer overflow occurred |
| 3 | COMPRESSED | Payload is compressed |
| 4 | LINKED | Linked to git commit |
| 5-15 | Reserved | |

## Modbus Burst Payload (16 bytes + registers)

When event type is SENSOR (0x03):

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0x00 | 1 | unit_id | Modbus unit ID |
| 0x01 | 1 | function_code | Modbus function code |
| 0x02 | 2 | start_register | Starting register address |
| 0x04 | 2 | register_count | Number of registers |
| 0x06 | 2 | reserved | |
| 0x08 | 8 | timestamp_ns | Register read time |
| 0x10 | 2*N | registers | Register values (big-endian) |

## Firmware Chunk Payload (72 bytes + data)

When event type is FIRMWARE (0x04):

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0x00 | 32 | device_id | Device identifier |
| 0x20 | 16 | version | Firmware version string |
| 0x30 | 4 | image_size | Total image size |
| 0x34 | 4 | chunk_offset | Offset in image |
| 0x38 | 4 | chunk_size | This chunk size |
| 0x3C | 32 | sha256 | Hash of full image |
| 0x5C | 8 | extract_timestamp | When extracted |
| 0x64 | N | data | Firmware chunk data |

## Checksums

### CRC32 Calculation

All CRC32 values use the standard polynomial (0xEDB88320) with:
- Initial value: 0x00000000
- Final XOR: 0x00000000
- Input/output bit reflection: Yes

### Content Hash (SHA-256)

The artifact content hash is computed over the entire snapshot including:
1. Snapshot header (with checksum field zeroed)
2. All event data
3. Final 4 bytes contain the CRC32

## Compression

When the COMPRESSED flag is set:
- Payload is compressed with LZ4 or ZSTD
- First 4 bytes of payload indicate uncompressed size
- Remaining bytes are compressed data

## Versioning

- **Version 1**: Initial specification (this document)
- Incompatible changes increment major version
- New fields use reserved bytes when possible

## Examples

### Minimal Snapshot (no events)

```
00000000  ce a7 a0 5c 01 00 00 00  00 00 00 00 00 00 00 01  |...\............|
00000010  [replay metadata - 80 bytes]                       |
00000060  00 00 00 00 00 00 00 80  [timestamps]              |
00000078  [crc32]    00 00 00 00  00 00 00 00 00 00 00 00   |................|
```

### Single ftrace Event

```
[snapshot header - 128 bytes]
00000080  ce a7 a0 5c 01 00 00 00  [timestamp 8 bytes]       | Event header
00000090  00 00 00 00 00 00 04 d2  00 00 00 40 00 00 00 00   | cpu, pid, len
000000a0  [ftrace data - 64 bytes]                           | Payload
```

## Related Documents

- [REPLAY_GUIDE.md](./REPLAY_GUIDE.md) - How to replay captures
- [scada_trace_api.h](../include/scada_trace_api.h) - UAPI definitions
- [REALITY_ARTIFACT_ARCHITECTURE.md](../../../docs/REALITY_ARTIFACT_ARCHITECTURE.md)
