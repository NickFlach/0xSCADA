/* SPDX-License-Identifier: GPL-2.0 */
/*
 * 0xSCADA Trace Capture - Kernel Module Header
 *
 * VERITY Phase α.2.1: Reality artifact capture from kernel space
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#ifndef _SCADA_TRACE_H
#define _SCADA_TRACE_H

#include <linux/types.h>
#include <linux/spinlock.h>
#include <linux/ktime.h>
#include <linux/workqueue.h>
#include <linux/fs.h>

/*
 * Version and constants
 */
#define SCADA_TRACE_VERSION_MAJOR	0
#define SCADA_TRACE_VERSION_MINOR	1
#define SCADA_TRACE_VERSION_PATCH	0

#define SCADA_TRACE_MAGIC		0x5CA0A7CE  /* SCADATCE */
#define SCADA_TRACE_RING_SIZE		(4 * 1024 * 1024)  /* 4MB default */
#define SCADA_TRACE_MAX_EVENTS		65536
#define SCADA_TRACE_GIT_HASH_LEN	41  /* 40 hex + null */

/*
 * Trace event types (matches userspace artifact types)
 */
enum scada_trace_type {
	SCADA_TRACE_FTRACE	= 0x01,	/* ftrace dump */
	SCADA_TRACE_EBPF	= 0x02,	/* eBPF capture */
	SCADA_TRACE_SENSOR	= 0x03,	/* Sensor/Modbus burst */
	SCADA_TRACE_FIRMWARE	= 0x04,	/* Firmware image */
	SCADA_TRACE_IO		= 0x05,	/* I/O operation */
	SCADA_TRACE_PROTOCOL	= 0x06,	/* Protocol event */
	SCADA_TRACE_CUSTOM	= 0xFF,	/* Custom event */
};

/*
 * Trace event flags
 */
#define SCADA_TRACE_F_REALTIME		(1 << 0)  /* RT context */
#define SCADA_TRACE_F_ATOMIC		(1 << 1)  /* Atomic capture */
#define SCADA_TRACE_F_OVERFLOW		(1 << 2)  /* Buffer overflow */
#define SCADA_TRACE_F_COMPRESSED	(1 << 3)  /* Data is compressed */
#define SCADA_TRACE_F_LINKED		(1 << 4)  /* Linked to commit */

/*
 * Replay metadata for deterministic replay
 */
struct scada_replay_metadata {
	u64 capture_timestamp_ns;	/* ktime_get_boottime_ns() */
	u64 boot_id;			/* Random boot ID */
	u32 cpu_id;			/* smp_processor_id() */
	u32 sequence_number;		/* Global monotonic seq */
	char git_commit[SCADA_TRACE_GIT_HASH_LEN];
	u32 metadata_version;		/* Format version */
	u32 checksum;			/* CRC32 of metadata */
} __packed;

/*
 * Individual trace event header
 */
struct scada_trace_event {
	u32 magic;			/* SCADA_TRACE_MAGIC */
	u16 type;			/* scada_trace_type */
	u16 flags;			/* Event flags */
	u64 timestamp_ns;		/* Capture timestamp */
	u32 cpu;			/* CPU ID */
	u32 pid;			/* Process ID */
	u32 data_len;			/* Payload length */
	u32 reserved;			/* Alignment padding */
	/* Variable-length payload follows */
} __packed;

/*
 * Snapshot header (wraps multiple events)
 */
struct scada_snapshot_header {
	u32 magic;			/* SCADA_TRACE_MAGIC */
	u32 version;			/* Snapshot format version */
	u64 snapshot_id;		/* Unique snapshot ID */
	struct scada_replay_metadata replay;
	u32 event_count;		/* Number of events */
	u32 total_size;			/* Total bytes including header */
	u64 start_timestamp_ns;		/* First event timestamp */
	u64 end_timestamp_ns;		/* Last event timestamp */
	u32 checksum;			/* CRC32 of entire snapshot */
	u32 reserved[3];		/* Future use */
} __packed;

/*
 * Modbus register burst capture
 */
struct scada_modbus_burst {
	u8 unit_id;			/* Modbus unit ID */
	u8 function_code;		/* Function code */
	u16 start_register;		/* Starting register address */
	u16 register_count;		/* Number of registers */
	u16 reserved;
	u64 timestamp_ns;		/* Capture time */
	/* Register values follow (2 bytes each) */
} __packed;

/*
 * Firmware image metadata
 */
struct scada_firmware_meta {
	char device_id[32];		/* Device identifier */
	char version[16];		/* Firmware version */
	u32 image_size;			/* Total image size */
	u32 chunk_offset;		/* Offset in image */
	u32 chunk_size;			/* This chunk size */
	u8 sha256[32];			/* Hash of full image */
	u64 extract_timestamp_ns;	/* When extracted */
} __packed;

/*
 * Ring buffer structure
 */
struct scada_trace_ring {
	spinlock_t lock;
	void *buffer;
	size_t size;
	size_t head;
	size_t tail;
	u32 event_count;
	u32 overflow_count;
	bool enabled;
};

/*
 * Global trace context
 */
struct scada_trace_ctx {
	/* Ring buffer per CPU */
	struct scada_trace_ring __percpu *rings;
	
	/* Global state */
	atomic64_t sequence_number;
	u64 boot_id;
	char git_commit[SCADA_TRACE_GIT_HASH_LEN];
	
	/* Snapshot state */
	spinlock_t snapshot_lock;
	struct scada_snapshot_header *current_snapshot;
	bool snapshot_in_progress;
	
	/* Work queue for async operations */
	struct workqueue_struct *wq;
	struct work_struct flush_work;
	
	/* Debugfs entries */
	struct dentry *debugfs_root;
	
	/* Statistics */
	atomic_t total_captures;
	atomic_t total_snapshots;
	atomic64_t total_bytes;
	
	/* Configuration */
	bool auto_link_commits;
	u32 ring_size;
	u32 max_snapshot_size;
};

/*
 * Global context accessor
 */
extern struct scada_trace_ctx *scada_trace_get_ctx(void);

/*
 * Ring buffer operations
 */
int scada_ring_init(struct scada_trace_ring *ring, size_t size);
void scada_ring_destroy(struct scada_trace_ring *ring);
int scada_ring_write(struct scada_trace_ring *ring, 
		     const void *data, size_t len);
int scada_ring_read(struct scada_trace_ring *ring,
		    void *data, size_t len);
size_t scada_ring_used(struct scada_trace_ring *ring);
void scada_ring_reset(struct scada_trace_ring *ring);

/*
 * Event capture operations
 */
int scada_trace_event(enum scada_trace_type type, u16 flags,
		      const void *data, size_t len);
int scada_trace_modbus_burst(const struct scada_modbus_burst *burst,
			     const u16 *registers);
int scada_trace_firmware_chunk(const struct scada_firmware_meta *meta,
			       const void *data);

/*
 * Snapshot operations
 */
int scada_snapshot_begin(void);
int scada_snapshot_add_event(struct scada_trace_event *event,
			     const void *data);
int scada_snapshot_commit(void __user *buf, size_t *len);
void scada_snapshot_abort(void);

/*
 * Git commit linkage
 */
int scada_trace_set_commit(const char *commit_hash);
const char *scada_trace_get_commit(void);

/*
 * Replay metadata
 */
void scada_replay_metadata_fill(struct scada_replay_metadata *meta);
int scada_replay_metadata_verify(const struct scada_replay_metadata *meta);

/*
 * Debugfs interface
 */
int scada_trace_debugfs_init(struct scada_trace_ctx *ctx);
void scada_trace_debugfs_cleanup(struct scada_trace_ctx *ctx);

/*
 * CRC32 helper (kernel uses different API)
 */
u32 scada_crc32(const void *data, size_t len);

#endif /* _SCADA_TRACE_H */
