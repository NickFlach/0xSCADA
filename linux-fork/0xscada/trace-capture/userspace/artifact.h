/* SPDX-License-Identifier: GPL-2.0 */
/*
 * 0xSCADA Trace Capture - Artifact Storage Interface
 *
 * Interface for storing trace captures as LFS reality artifacts.
 * This abstracts the storage layer for both local and remote storage.
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#ifndef _ARTIFACT_H
#define _ARTIFACT_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "../include/scada_trace_api.h"

/*
 * Artifact origin systems
 */
typedef enum {
	ORIGIN_LINUX = 0,
	ORIGIN_ETHEREUM = 1,
	ORIGIN_AGENTIC_QE = 2,
} artifact_origin_t;

/*
 * Artifact types (matches shared/artifact.ts)
 */
typedef enum {
	/* Linux Fork */
	ARTIFACT_TRACE = 0,
	ARTIFACT_SENSOR,
	ARTIFACT_FIRMWARE,
	
	/* Ethereum Fork */
	ARTIFACT_PROOF,
	ARTIFACT_SNAPSHOT,
	ARTIFACT_MERKLE,
	
	/* Agentic-QE Fork */
	ARTIFACT_MODEL,
	ARTIFACT_DECISION,
	ARTIFACT_EMBEDDING,
	
	/* Cross-fork */
	ARTIFACT_TWIN,
	
	/* Generic */
	ARTIFACT_BLOB,
	ARTIFACT_CONFIG,
	ARTIFACT_LOG,
} artifact_type_t;

/*
 * LFS Pointer (matches shared/artifact.ts LFSPointer)
 */
typedef struct {
	char version[8];		/* "v1" */
	char oid[65];			/* SHA-256 hex */
	uint64_t size;
	char mime_type[64];
	char filename[256];
} lfs_pointer_t;

/*
 * Artifact Origin
 */
typedef struct {
	artifact_origin_t system;
	char agent[64];			/* Optional agent ID */
	char fork[41];			/* Git commit */
	char device[64];		/* Device ID */
} artifact_origin_info_t;

/*
 * Artifact Scope
 */
typedef struct {
	artifact_type_t type;
	char site_id[64];
	char asset_id[64];
	char tags[512];			/* Comma-separated */
} artifact_scope_t;

/*
 * Crypto Signature (optional attestation)
 */
typedef struct {
	char algorithm[32];		/* hmac-sha256, ed25519, secp256k1 */
	char key_id[64];
	char value[256];		/* Hex-encoded signature */
	char signed_at[32];		/* ISO8601 timestamp */
} crypto_signature_t;

/*
 * Reality Artifact (matches shared/artifact.ts RealityArtifact)
 */
typedef struct {
	char id[65];			/* Content hash (SHA-256 hex) */
	char timestamp[32];		/* ISO8601 */
	artifact_origin_info_t origin;
	artifact_scope_t scope;
	char dependencies[4096];	/* JSON array of hashes */
	crypto_signature_t *signature;	/* Optional */
	char summary[256];		/* Human-readable */
	lfs_pointer_t content;
} reality_artifact_t;

/*
 * Artifact creation input
 */
typedef struct {
	artifact_origin_info_t origin;
	artifact_scope_t scope;
	const char *summary;
	const void *data;		/* Raw content */
	size_t data_size;
	const char *mime_type;
	const char *filename;
	const char *dependencies;	/* JSON array or NULL */
} artifact_create_input_t;

/*
 * Artifact query
 */
typedef struct {
	artifact_origin_t *system;	/* NULL = any */
	artifact_type_t *type;		/* NULL = any */
	const char *agent_id;
	const char *site_id;
	const char *asset_id;
	const char *tags;		/* Comma-separated, all must match */
	const char *depends_on;		/* Content hash */
	const char *from_timestamp;	/* ISO8601 */
	const char *to_timestamp;	/* ISO8601 */
	size_t offset;
	size_t limit;
} artifact_query_t;

/*
 * Storage backend interface
 *
 * Implementations:
 * - Local filesystem (default)
 * - Git LFS
 * - S3-compatible
 * - IPFS
 */
typedef struct artifact_storage artifact_storage_t;

typedef struct {
	/* Initialize storage backend */
	int (*init)(artifact_storage_t *storage, const char *config);
	
	/* Cleanup */
	void (*destroy)(artifact_storage_t *storage);
	
	/* Store artifact content, returns content hash */
	int (*store)(artifact_storage_t *storage,
		     const void *data, size_t size,
		     char *hash_out);
	
	/* Retrieve artifact content by hash */
	int (*retrieve)(artifact_storage_t *storage,
			const char *hash,
			void **data_out, size_t *size_out);
	
	/* Check if artifact exists */
	bool (*exists)(artifact_storage_t *storage, const char *hash);
	
	/* Get artifact metadata (JSON) */
	int (*get_metadata)(artifact_storage_t *storage,
			    const char *hash,
			    char **json_out);
	
	/* Store artifact metadata */
	int (*store_metadata)(artifact_storage_t *storage,
			      const char *hash,
			      const char *json);
	
	/* Query artifacts */
	int (*query)(artifact_storage_t *storage,
		     const artifact_query_t *query,
		     char ***hashes_out,
		     size_t *count_out);
	
	/* Link artifact to git commit */
	int (*link_commit)(artifact_storage_t *storage,
			   const char *hash,
			   const char *commit);
	
	/* Get storage stats */
	int (*stats)(artifact_storage_t *storage,
		     uint64_t *total_count,
		     uint64_t *total_size);
} artifact_storage_ops_t;

struct artifact_storage {
	const artifact_storage_ops_t *ops;
	void *private_data;
	char root_path[4096];
};

/*
 * API Functions
 */

/* Create artifact storage with given backend */
artifact_storage_t *artifact_storage_create(
	const char *backend,	/* "local", "lfs", "s3", "ipfs" */
	const char *config	/* Backend-specific config */
);

/* Destroy artifact storage */
void artifact_storage_destroy(artifact_storage_t *storage);

/* Create a new reality artifact from raw data */
int artifact_create(
	artifact_storage_t *storage,
	const artifact_create_input_t *input,
	reality_artifact_t *artifact_out
);

/* Get artifact by content hash */
int artifact_get(
	artifact_storage_t *storage,
	const char *hash,
	reality_artifact_t *artifact_out
);

/* Get artifact content */
int artifact_get_content(
	artifact_storage_t *storage,
	const char *hash,
	void **data_out,
	size_t *size_out
);

/* Query artifacts */
int artifact_query(
	artifact_storage_t *storage,
	const artifact_query_t *query,
	reality_artifact_t **artifacts_out,
	size_t *count_out
);

/* Link artifact to git commit */
int artifact_link_commit(
	artifact_storage_t *storage,
	const char *hash,
	const char *commit
);

/* Compute SHA-256 hash of data */
int artifact_hash(
	const void *data,
	size_t size,
	char *hash_out  /* Must be at least 65 bytes */
);

/* Serialize artifact to JSON */
int artifact_to_json(
	const reality_artifact_t *artifact,
	char **json_out
);

/* Deserialize artifact from JSON */
int artifact_from_json(
	const char *json,
	reality_artifact_t *artifact_out
);

/* Free artifact memory */
void artifact_free(reality_artifact_t *artifact);

/* Free artifact array */
void artifact_array_free(reality_artifact_t *artifacts, size_t count);

/*
 * Convenience functions
 */

/* Create trace artifact from snapshot */
int artifact_from_snapshot(
	artifact_storage_t *storage,
	const struct scada_snapshot_header *snapshot,
	const void *data,
	size_t data_size,
	const char *device_id,
	const char *site_id,
	reality_artifact_t *artifact_out
);

/* Create sensor artifact from Modbus burst */
int artifact_from_modbus(
	artifact_storage_t *storage,
	const struct scada_modbus_burst *burst,
	const uint16_t *registers,
	const char *device_id,
	const char *site_id,
	reality_artifact_t *artifact_out
);

/* Create firmware artifact from image */
int artifact_from_firmware(
	artifact_storage_t *storage,
	const struct scada_firmware_meta *meta,
	const void *image,
	reality_artifact_t *artifact_out
);

/* Get artifact chain (dependencies) */
int artifact_get_chain(
	artifact_storage_t *storage,
	const char *hash,
	reality_artifact_t **chain_out,
	size_t *count_out
);

/* Verify artifact integrity */
int artifact_verify(
	artifact_storage_t *storage,
	const char *hash
);

#endif /* _ARTIFACT_H */
