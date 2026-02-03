/* SPDX-License-Identifier: GPL-2.0 WITH Linux-syscall-note */
/*
 * 0xSCADA Trace Capture - Userspace API
 *
 * UAPI header for scada-traced daemon and scada-trace CLI.
 * This file is shared between kernel and userspace.
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#ifndef _UAPI_SCADA_TRACE_H
#define _UAPI_SCADA_TRACE_H

#include <linux/types.h>

/*
 * Version and magic
 */
#define SCADA_TRACE_MAGIC		0x5CA0A7CE
#define SCADA_TRACE_VERSION		0x00010000  /* 0.1.0 */
#define SCADA_TRACE_GIT_HASH_LEN	41

/*
 * Trace event types
 */
#define SCADA_TRACE_FTRACE		0x01
#define SCADA_TRACE_EBPF		0x02
#define SCADA_TRACE_SENSOR		0x03
#define SCADA_TRACE_FIRMWARE		0x04
#define SCADA_TRACE_IO			0x05
#define SCADA_TRACE_PROTOCOL		0x06
#define SCADA_TRACE_CUSTOM		0xFF

/*
 * Trace event flags
 */
#define SCADA_TRACE_F_REALTIME		(1 << 0)
#define SCADA_TRACE_F_ATOMIC		(1 << 1)
#define SCADA_TRACE_F_OVERFLOW		(1 << 2)
#define SCADA_TRACE_F_COMPRESSED	(1 << 3)
#define SCADA_TRACE_F_LINKED		(1 << 4)

/*
 * Replay metadata for deterministic replay
 */
struct scada_replay_metadata {
	__u64 capture_timestamp_ns;
	__u64 boot_id;
	__u32 cpu_id;
	__u32 sequence_number;
	char git_commit[SCADA_TRACE_GIT_HASH_LEN];
	__u32 metadata_version;
	__u32 checksum;
} __attribute__((packed));

/*
 * Trace event header
 */
struct scada_trace_event {
	__u32 magic;
	__u16 type;
	__u16 flags;
	__u64 timestamp_ns;
	__u32 cpu;
	__u32 pid;
	__u32 data_len;
	__u32 reserved;
	/* Variable-length payload follows */
} __attribute__((packed));

/*
 * Snapshot header
 */
struct scada_snapshot_header {
	__u32 magic;
	__u32 version;
	__u64 snapshot_id;
	struct scada_replay_metadata replay;
	__u32 event_count;
	__u32 total_size;
	__u64 start_timestamp_ns;
	__u64 end_timestamp_ns;
	__u32 checksum;
	__u32 reserved[3];
} __attribute__((packed));

/*
 * Modbus register burst
 */
struct scada_modbus_burst {
	__u8 unit_id;
	__u8 function_code;
	__u16 start_register;
	__u16 register_count;
	__u16 reserved;
	__u64 timestamp_ns;
	/* Register values follow (2 bytes each) */
} __attribute__((packed));

/*
 * Firmware image metadata
 */
struct scada_firmware_meta {
	char device_id[32];
	char version[16];
	__u32 image_size;
	__u32 chunk_offset;
	__u32 chunk_size;
	__u8 sha256[32];
	__u64 extract_timestamp_ns;
} __attribute__((packed));

/*
 * ioctl definitions (for future /dev/scada_trace character device)
 */
#define SCADA_TRACE_IOC_MAGIC		'S'

/* Get current stats */
struct scada_trace_stats {
	__u64 boot_id;
	__u64 sequence_number;
	__u64 total_bytes;
	__u32 total_captures;
	__u32 total_snapshots;
	__u32 ring_size;
	__u32 overflow_count;
	char git_commit[SCADA_TRACE_GIT_HASH_LEN];
	__u8 enabled;
	__u8 reserved[3];
};

/* Capture configuration */
struct scada_capture_config {
	__u32 duration_ms;		/* Capture duration */
	__u32 max_events;		/* Max events to capture */
	__u16 type_mask;		/* Which event types */
	__u16 flags;			/* Capture flags */
	char commit[SCADA_TRACE_GIT_HASH_LEN];  /* Link to commit */
};

/* ioctl commands */
#define SCADA_TRACE_IOCTL_STATS		_IOR(SCADA_TRACE_IOC_MAGIC, 1, struct scada_trace_stats)
#define SCADA_TRACE_IOCTL_ENABLE	_IOW(SCADA_TRACE_IOC_MAGIC, 2, int)
#define SCADA_TRACE_IOCTL_COMMIT	_IOW(SCADA_TRACE_IOC_MAGIC, 3, char[SCADA_TRACE_GIT_HASH_LEN])
#define SCADA_TRACE_IOCTL_RESET		_IO(SCADA_TRACE_IOC_MAGIC, 4)
#define SCADA_TRACE_IOCTL_CAPTURE	_IOWR(SCADA_TRACE_IOC_MAGIC, 5, struct scada_capture_config)
#define SCADA_TRACE_IOCTL_SNAPSHOT	_IOR(SCADA_TRACE_IOC_MAGIC, 6, size_t)

/*
 * Artifact metadata for LFS storage
 * 
 * This structure is serialized as JSON for the RealityArtifact manifest
 */
struct scada_artifact_info {
	/* Content hash (SHA-256) */
	char content_hash[65];		/* 64 hex + null */
	
	/* Origin */
	char system[16];		/* "linux" */
	char device[64];		/* Device ID */
	char git_commit[SCADA_TRACE_GIT_HASH_LEN];
	
	/* Scope */
	char type[16];			/* trace/sensor/firmware */
	char site_id[64];
	char asset_id[64];
	
	/* Timing */
	__u64 timestamp_ns;
	
	/* Size */
	__u64 size;
	
	/* Dependencies (comma-separated hashes) */
	char dependencies[512];
};

/*
 * Debugfs paths
 */
#define SCADA_TRACE_DEBUGFS_ROOT	"/sys/kernel/debug/scada_trace"
#define SCADA_TRACE_DEBUGFS_STATS	SCADA_TRACE_DEBUGFS_ROOT "/stats"
#define SCADA_TRACE_DEBUGFS_COMMIT	SCADA_TRACE_DEBUGFS_ROOT "/commit"
#define SCADA_TRACE_DEBUGFS_ENABLE	SCADA_TRACE_DEBUGFS_ROOT "/enable"

#endif /* _UAPI_SCADA_TRACE_H */
