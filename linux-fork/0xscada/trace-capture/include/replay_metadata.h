/* SPDX-License-Identifier: GPL-2.0 WITH Linux-syscall-note */
/*
 * 0xSCADA Trace Capture - Deterministic Replay Metadata
 *
 * Defines the metadata format for enabling deterministic replay
 * of industrial control system traces.
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#ifndef _REPLAY_METADATA_H
#define _REPLAY_METADATA_H

#include "scada_trace_api.h"

/*
 * Replay context - complete state for replay
 */
struct replay_context {
	/* Identity */
	__u64 boot_id;			/* Original boot ID */
	__u64 replay_id;		/* Replay session ID */
	
	/* Timing */
	__u64 capture_start_ns;		/* Original capture start */
	__u64 capture_end_ns;		/* Original capture end */
	__u64 replay_start_ns;		/* Replay session start */
	
	/* Sequencing */
	__u32 expected_sequence;	/* Next expected seq num */
	__u32 events_replayed;		/* Events processed */
	__u32 events_total;		/* Total events in capture */
	
	/* Git context */
	char original_commit[SCADA_TRACE_GIT_HASH_LEN];
	char current_commit[SCADA_TRACE_GIT_HASH_LEN];
	
	/* Verification */
	__u32 checksum_mismatches;	/* Data integrity errors */
	__u32 sequence_errors;		/* Out-of-order events */
	__u32 timing_drift_us;		/* Max timing deviation */
	
	/* Flags */
	__u32 flags;
#define REPLAY_F_STRICT		(1 << 0)  /* Fail on any mismatch */
#define REPLAY_F_TIMING		(1 << 1)  /* Preserve timing */
#define REPLAY_F_VERIFY		(1 << 2)  /* Verify checksums */
#define REPLAY_F_CONTINUE	(1 << 3)  /* Continue on error */
};

/*
 * Replay verification result
 */
struct replay_verification {
	/* Overall status */
	int result;			/* 0 = success */
	
	/* Counts */
	__u32 events_verified;		/* Events successfully verified */
	__u32 events_failed;		/* Verification failures */
	
	/* Timing analysis */
	__u64 min_latency_ns;		/* Minimum event latency */
	__u64 max_latency_ns;		/* Maximum event latency */
	__u64 avg_latency_ns;		/* Average event latency */
	__u64 total_duration_ns;	/* Total replay duration */
	
	/* Fidelity */
	__u32 checksum_ok;		/* Checksum matches */
	__u32 checksum_fail;		/* Checksum mismatches */
	
	/* Deviation from original */
	__u64 timing_deviation_ns;	/* Max timing difference */
	__u32 sequence_gaps;		/* Missing sequence numbers */
	__u32 duplicate_events;		/* Duplicate events */
};

/*
 * Replay event callback
 *
 * Called for each event during replay.
 * Return 0 to continue, negative to abort.
 */
typedef int (*replay_event_cb)(
	const struct scada_trace_event *event,
	const void *data,
	void *user_data
);

/*
 * Replay verifier callback
 *
 * Called to verify an event matches expected state.
 */
typedef int (*replay_verify_cb)(
	const struct scada_trace_event *original,
	const struct scada_trace_event *replayed,
	void *user_data
);

/*
 * Replay configuration
 */
struct replay_config {
	/* Source */
	const void *snapshot_data;
	size_t snapshot_size;
	
	/* Callbacks */
	replay_event_cb on_event;
	replay_verify_cb on_verify;
	void *user_data;
	
	/* Options */
	__u32 flags;			/* REPLAY_F_* */
	__u64 time_scale;		/* 1000 = 1x, 500 = 0.5x */
	__u64 max_events;		/* 0 = unlimited */
	
	/* Filtering */
	__u16 type_mask;		/* Event types to replay */
	__u32 start_sequence;		/* Start from sequence */
	__u32 end_sequence;		/* End at sequence */
};

/*
 * LFS artifact linkage
 *
 * Maps a capture to its LFS storage location
 */
struct artifact_link {
	/* Content address */
	char content_hash[65];		/* SHA-256 hex */
	
	/* LFS location */
	char lfs_oid[65];		/* LFS object ID */
	__u64 lfs_size;			/* Object size */
	
	/* Git context */
	char git_commit[SCADA_TRACE_GIT_HASH_LEN];
	char git_tree[SCADA_TRACE_GIT_HASH_LEN];
	
	/* Timestamps */
	__u64 created_at_ns;		/* When linked */
	__u64 captured_at_ns;		/* Original capture time */
	
	/* Chain */
	char prev_artifact[65];		/* Previous in chain */
	char next_artifact[65];		/* Next in chain (if known) */
	
	/* Verification */
	__u32 verified;			/* Has been verified */
	__u32 verify_result;		/* Last verify result */
};

/*
 * Replay state machine states
 */
enum replay_state {
	REPLAY_IDLE = 0,
	REPLAY_LOADING,
	REPLAY_VALIDATING,
	REPLAY_READY,
	REPLAY_RUNNING,
	REPLAY_PAUSED,
	REPLAY_COMPLETE,
	REPLAY_ERROR,
};

/*
 * Helper macros
 */

/* Check if replay metadata is valid */
#define REPLAY_META_VALID(m) \
	((m)->metadata_version == 1 && (m)->boot_id != 0)

/* Check if captures are from same boot */
#define SAME_BOOT(a, b) \
	((a)->replay.boot_id == (b)->replay.boot_id)

/* Check if capture B follows capture A in sequence */
#define FOLLOWS(a, b) \
	(SAME_BOOT(a, b) && \
	 (b)->replay.sequence_number == (a)->replay.sequence_number + 1)

/* Timing helpers */
#define NS_TO_US(ns)	((ns) / 1000)
#define NS_TO_MS(ns)	((ns) / 1000000)
#define NS_TO_S(ns)	((ns) / 1000000000)
#define US_TO_NS(us)	((us) * 1000)
#define MS_TO_NS(ms)	((ms) * 1000000)
#define S_TO_NS(s)	((s) * 1000000000ULL)

#endif /* _REPLAY_METADATA_H */
