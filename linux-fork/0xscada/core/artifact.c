// SPDX-License-Identifier: GPL-2.0-only
/*
 * 0xSCADA Artifact Capture Infrastructure
 *
 * This module provides the core infrastructure for creating, managing,
 * and verifying reality artifacts in the 0xSCADA ecosystem.
 *
 * Copyright (c) 2024 0xSCADA Project
 */

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/slab.h>
#include <linux/string.h>
#include <linux/timekeeping.h>
#include <crypto/hash.h>

#include "artifact.h"

#define SCADA_ARTIFACT_MAGIC	0x5CADA000
#define HASH_ALG		"sha256"

static struct crypto_shash *hash_tfm;
static DEFINE_SPINLOCK(artifact_lock);
static LIST_HEAD(artifact_list);
static atomic64_t artifact_count = ATOMIC64_INIT(0);

/**
 * scada_hash_data - Compute SHA-256 hash of data
 * @data: Input data
 * @len: Length of data
 * @out: Output buffer (must be SCADA_HASH_SIZE bytes)
 *
 * Returns 0 on success, negative error code on failure.
 */
int scada_hash_data(const void *data, size_t len, u8 *out)
{
	SHASH_DESC_ON_STACK(desc, hash_tfm);
	int ret;

	if (!hash_tfm)
		return -ENODEV;

	desc->tfm = hash_tfm;

	ret = crypto_shash_digest(desc, data, len, out);
	shash_desc_zero(desc);

	return ret;
}
EXPORT_SYMBOL_GPL(scada_hash_data);

/**
 * scada_hash_to_hex - Convert hash to hexadecimal string
 * @hash: Input hash (SCADA_HASH_SIZE bytes)
 * @hex: Output buffer (must be at least 65 bytes)
 * @hex_len: Size of hex buffer
 */
void scada_hash_to_hex(const u8 *hash, char *hex, size_t hex_len)
{
	int i;

	if (hex_len < SCADA_HASH_SIZE * 2 + 1)
		return;

	for (i = 0; i < SCADA_HASH_SIZE; i++)
		sprintf(hex + i * 2, "%02x", hash[i]);
	hex[SCADA_HASH_SIZE * 2] = '\0';
}
EXPORT_SYMBOL_GPL(scada_hash_to_hex);

/**
 * scada_artifact_create - Allocate and initialize a new artifact
 * @origin: Origin type (system/agent/fork)
 * @scope: Domain scope
 *
 * Returns pointer to new artifact or NULL on failure.
 * The artifact must be finalized before use and freed with scada_artifact_put().
 *
 * Note: Uses GFP_ATOMIC to allow calls from atomic context (e.g., netfilter hooks).
 */
struct scada_artifact *scada_artifact_create(enum scada_origin_type origin,
					     enum scada_scope scope)
{
	struct scada_artifact *art;

	art = kzalloc(sizeof(*art), GFP_ATOMIC);
	if (!art)
		return NULL;

	art->origin_type = origin;
	art->scope = scope;
	art->timestamp = ktime_get_real_ns();
	art->finalized = false;
	
	kref_init(&art->refcount);
	INIT_LIST_HEAD(&art->list);

	atomic64_inc(&artifact_count);
	
	pr_debug("0xscada: artifact created (origin=%d, scope=%d)\n",
		 origin, scope);

	return art;
}
EXPORT_SYMBOL_GPL(scada_artifact_create);

static void scada_artifact_release(struct kref *kref)
{
	struct scada_artifact *art = container_of(kref, struct scada_artifact,
						  refcount);
	unsigned long flags;

	spin_lock_irqsave(&artifact_lock, flags);
	list_del(&art->list);
	spin_unlock_irqrestore(&artifact_lock, flags);

	kfree(art->content);
	kfree(art);
	
	atomic64_dec(&artifact_count);
}

/**
 * scada_artifact_get - Increment artifact reference count
 * @art: Artifact to reference
 *
 * Returns the artifact pointer for convenience.
 */
struct scada_artifact *scada_artifact_get(struct scada_artifact *art)
{
	if (art)
		kref_get(&art->refcount);
	return art;
}
EXPORT_SYMBOL_GPL(scada_artifact_get);

/**
 * scada_artifact_put - Decrement artifact reference count
 * @art: Artifact to dereference
 *
 * When count reaches zero, the artifact is freed.
 */
void scada_artifact_put(struct scada_artifact *art)
{
	if (art)
		kref_put(&art->refcount, scada_artifact_release);
}
EXPORT_SYMBOL_GPL(scada_artifact_put);

/**
 * scada_artifact_set_origin_id - Set the origin identifier
 * @art: Artifact to modify
 * @id: Origin identifier string
 *
 * Returns 0 on success, -EINVAL if already finalized.
 */
int scada_artifact_set_origin_id(struct scada_artifact *art, const char *id)
{
	if (art->finalized)
		return -EINVAL;

	strscpy(art->origin_id, id, sizeof(art->origin_id));
	return 0;
}
EXPORT_SYMBOL_GPL(scada_artifact_set_origin_id);

/**
 * scada_artifact_set_subsystem - Set the subsystem identifier
 * @art: Artifact to modify
 * @subsys: Subsystem string
 *
 * Returns 0 on success, -EINVAL if already finalized.
 */
int scada_artifact_set_subsystem(struct scada_artifact *art, const char *subsys)
{
	if (art->finalized)
		return -EINVAL;

	strscpy(art->subsystem, subsys, sizeof(art->subsystem));
	return 0;
}
EXPORT_SYMBOL_GPL(scada_artifact_set_subsystem);

/**
 * scada_artifact_set_content_type - Set the content type
 * @art: Artifact to modify
 * @type: Content type
 *
 * Returns 0 on success, -EINVAL if already finalized.
 */
int scada_artifact_set_content_type(struct scada_artifact *art,
				    enum scada_content_type type)
{
	if (art->finalized)
		return -EINVAL;

	art->content_type = type;
	return 0;
}
EXPORT_SYMBOL_GPL(scada_artifact_set_content_type);

/**
 * scada_artifact_set_content - Set artifact content
 * @art: Artifact to modify
 * @data: Content data (will be copied)
 * @len: Length of content
 *
 * Returns 0 on success, negative error code on failure.
 *
 * Note: Uses GFP_ATOMIC to allow calls from atomic context.
 */
int scada_artifact_set_content(struct scada_artifact *art,
			       const void *data, size_t len)
{
	void *new_content;

	if (art->finalized)
		return -EINVAL;

	new_content = kmemdup(data, len, GFP_ATOMIC);
	if (!new_content)
		return -ENOMEM;

	kfree(art->content);
	art->content = new_content;
	art->content_size = len;

	return scada_hash_data(data, len, art->content_hash);
}
EXPORT_SYMBOL_GPL(scada_artifact_set_content);

/**
 * scada_artifact_set_summary - Set human-readable summary
 * @art: Artifact to modify
 * @summary: Summary string
 *
 * Returns 0 on success, -EINVAL if already finalized.
 */
int scada_artifact_set_summary(struct scada_artifact *art, const char *summary)
{
	if (art->finalized)
		return -EINVAL;

	strscpy(art->summary, summary, sizeof(art->summary));
	return 0;
}
EXPORT_SYMBOL_GPL(scada_artifact_set_summary);

/**
 * scada_artifact_add_dependency - Add a dependency to the artifact
 * @art: Artifact to modify
 * @hash: SHA-256 hash of the dependency
 * @rel: Relationship type
 *
 * Returns 0 on success, -ENOSPC if max dependencies reached.
 */
int scada_artifact_add_dependency(struct scada_artifact *art,
				  const u8 *hash,
				  enum scada_dep_relationship rel)
{
	struct scada_dependency *dep;

	if (art->finalized)
		return -EINVAL;

	if (art->num_dependencies >= SCADA_MAX_DEPENDENCIES)
		return -ENOSPC;

	dep = &art->dependencies[art->num_dependencies++];
	memcpy(dep->hash, hash, SCADA_HASH_SIZE);
	dep->relationship = rel;

	return 0;
}
EXPORT_SYMBOL_GPL(scada_artifact_add_dependency);

/**
 * scada_artifact_finalize - Compute ID hash and make artifact immutable
 * @art: Artifact to finalize
 *
 * After finalization, the artifact cannot be modified.
 * Returns 0 on success, negative error code on failure.
 */
int scada_artifact_finalize(struct scada_artifact *art)
{
	SHASH_DESC_ON_STACK(desc, hash_tfm);
	unsigned long flags;
	int ret;

	if (art->finalized)
		return -EINVAL;

	if (!hash_tfm)
		return -ENODEV;

	desc->tfm = hash_tfm;

	ret = crypto_shash_init(desc);
	if (ret)
		goto out;

	/* Hash all artifact fields (excluding id) to compute id */
	ret = crypto_shash_update(desc, (u8 *)&art->timestamp,
				  sizeof(art->timestamp));
	if (ret)
		goto out;

	ret = crypto_shash_update(desc, (u8 *)&art->origin_type,
				  sizeof(art->origin_type));
	if (ret)
		goto out;

	ret = crypto_shash_update(desc, art->origin_id,
				  strlen(art->origin_id));
	if (ret)
		goto out;

	ret = crypto_shash_update(desc, (u8 *)&art->scope,
				  sizeof(art->scope));
	if (ret)
		goto out;

	ret = crypto_shash_update(desc, art->content_hash,
				  SCADA_HASH_SIZE);
	if (ret)
		goto out;

	ret = crypto_shash_final(desc, art->id);
	if (ret)
		goto out;

	art->finalized = true;

	/* Add to global artifact list */
	spin_lock_irqsave(&artifact_lock, flags);
	list_add_tail(&art->list, &artifact_list);
	spin_unlock_irqrestore(&artifact_lock, flags);

	pr_debug("0xscada: artifact finalized\n");

out:
	shash_desc_zero(desc);
	return ret;
}
EXPORT_SYMBOL_GPL(scada_artifact_finalize);

/**
 * scada_artifact_verify - Verify artifact integrity
 * @art: Artifact to verify
 *
 * Returns 0 if valid, negative error code if invalid.
 */
int scada_artifact_verify(const struct scada_artifact *art)
{
	int ret;

	if (!art->finalized)
		return -EINVAL;

	ret = scada_artifact_verify_content(art);
	if (ret)
		return ret;

	return scada_artifact_verify_id(art);
}
EXPORT_SYMBOL_GPL(scada_artifact_verify);

/**
 * scada_artifact_verify_content - Verify content hash
 * @art: Artifact to verify
 *
 * Returns 0 if content hash is valid, -EBADMSG if mismatch.
 */
int scada_artifact_verify_content(const struct scada_artifact *art)
{
	u8 computed[SCADA_HASH_SIZE];
	int ret;

	ret = scada_hash_data(art->content, art->content_size, computed);
	if (ret)
		return ret;

	if (memcmp(computed, art->content_hash, SCADA_HASH_SIZE) != 0) {
		pr_warn("0xscada: content hash mismatch\n");
		return -EBADMSG;
	}

	return 0;
}
EXPORT_SYMBOL_GPL(scada_artifact_verify_content);

/**
 * scada_artifact_dump - Print artifact details for debugging
 * @art: Artifact to dump
 */
void scada_artifact_dump(const struct scada_artifact *art)
{
	char hex[SCADA_HASH_SIZE * 2 + 1];

	scada_hash_to_hex(art->id, hex, sizeof(hex));
	pr_info("0xscada: Artifact ID: %s\n", hex);
	pr_info("0xscada:   Timestamp: %llu\n", art->timestamp);
	pr_info("0xscada:   Origin: %d (%s)\n", art->origin_type, art->origin_id);
	pr_info("0xscada:   Scope: %d\n", art->scope);
	pr_info("0xscada:   Content size: %zu\n", art->content_size);
	pr_info("0xscada:   Summary: %s\n", art->summary);
	pr_info("0xscada:   Finalized: %s\n", art->finalized ? "yes" : "no");
}
EXPORT_SYMBOL_GPL(scada_artifact_dump);

/**
 * scada_artifact_destroy - Alias for scada_artifact_put
 * @art: Artifact to destroy
 *
 * Provided for API completeness. Equivalent to scada_artifact_put().
 */
void scada_artifact_destroy(struct scada_artifact *art)
{
	scada_artifact_put(art);
}
EXPORT_SYMBOL_GPL(scada_artifact_destroy);

/**
 * scada_artifact_is_finalized - Check if artifact is finalized
 * @art: Artifact to check
 *
 * Returns true if the artifact is finalized and immutable.
 */
bool scada_artifact_is_finalized(const struct scada_artifact *art)
{
	return art->finalized;
}
EXPORT_SYMBOL_GPL(scada_artifact_is_finalized);

/**
 * scada_artifact_verify_id - Verify artifact ID hash
 * @art: Artifact to verify
 *
 * Recomputes the ID hash and compares with stored value.
 * Returns 0 if valid, -EBADMSG if mismatch, negative error on failure.
 */
int scada_artifact_verify_id(const struct scada_artifact *art)
{
	SHASH_DESC_ON_STACK(desc, hash_tfm);
	u8 computed_id[SCADA_HASH_SIZE];
	int ret;

	if (!art->finalized)
		return -EINVAL;

	if (!hash_tfm)
		return -ENODEV;

	desc->tfm = hash_tfm;

	ret = crypto_shash_init(desc);
	if (ret)
		goto out;

	ret = crypto_shash_update(desc, (u8 *)&art->timestamp,
				  sizeof(art->timestamp));
	if (ret)
		goto out;

	ret = crypto_shash_update(desc, (u8 *)&art->origin_type,
				  sizeof(art->origin_type));
	if (ret)
		goto out;

	ret = crypto_shash_update(desc, art->origin_id,
				  strlen(art->origin_id));
	if (ret)
		goto out;

	ret = crypto_shash_update(desc, (u8 *)&art->scope,
				  sizeof(art->scope));
	if (ret)
		goto out;

	ret = crypto_shash_update(desc, art->content_hash,
				  SCADA_HASH_SIZE);
	if (ret)
		goto out;

	ret = crypto_shash_final(desc, computed_id);
	if (ret)
		goto out;

	if (memcmp(computed_id, art->id, SCADA_HASH_SIZE) != 0) {
		pr_warn("0xscada: artifact ID hash mismatch\n");
		ret = -EBADMSG;
	}

out:
	shash_desc_zero(desc);
	return ret;
}
EXPORT_SYMBOL_GPL(scada_artifact_verify_id);

/**
 * scada_artifact_get_id - Get artifact ID
 * @art: Artifact to query
 *
 * Returns pointer to the artifact's ID hash (SCADA_HASH_SIZE bytes).
 */
const u8 *scada_artifact_get_id(const struct scada_artifact *art)
{
	return art->id;
}
EXPORT_SYMBOL_GPL(scada_artifact_get_id);

/**
 * scada_artifact_get_timestamp - Get artifact timestamp
 * @art: Artifact to query
 *
 * Returns the artifact's creation timestamp in nanoseconds.
 */
u64 scada_artifact_get_timestamp(const struct scada_artifact *art)
{
	return art->timestamp;
}
EXPORT_SYMBOL_GPL(scada_artifact_get_timestamp);

/**
 * scada_artifact_get_summary - Get artifact summary
 * @art: Artifact to query
 *
 * Returns pointer to the artifact's human-readable summary.
 */
const char *scada_artifact_get_summary(const struct scada_artifact *art)
{
	return art->summary;
}
EXPORT_SYMBOL_GPL(scada_artifact_get_summary);

/**
 * scada_hex_to_hash - Convert hexadecimal string to hash
 * @hex: Input hex string (must be at least 64 characters)
 * @hash: Output buffer (must be SCADA_HASH_SIZE bytes)
 *
 * Returns 0 on success, -EINVAL on invalid input.
 */
int scada_hex_to_hash(const char *hex, u8 *hash)
{
	int i;
	unsigned int byte;

	if (strlen(hex) < SCADA_HASH_SIZE * 2)
		return -EINVAL;

	for (i = 0; i < SCADA_HASH_SIZE; i++) {
		if (sscanf(hex + i * 2, "%2x", &byte) != 1)
			return -EINVAL;
		hash[i] = (u8)byte;
	}

	return 0;
}
EXPORT_SYMBOL_GPL(scada_hex_to_hash);

/**
 * scada_artifact_serialize - Serialize artifact to buffer
 * @art: Artifact to serialize
 * @buf: Output buffer (NULL to query required size)
 * @len: Size of output buffer
 *
 * Returns number of bytes written, or required size if buf is NULL.
 * Returns negative error code on failure.
 */
ssize_t scada_artifact_serialize(const struct scada_artifact *art,
				 void *buf, size_t len)
{
	size_t required;
	u8 *p = buf;

	if (!art->finalized)
		return -EINVAL;

	/* Calculate required size: fixed fields + content */
	required = sizeof(art->id) +
		   sizeof(art->timestamp) +
		   sizeof(art->origin_type) +
		   sizeof(art->origin_id) +
		   sizeof(art->scope) +
		   sizeof(art->subsystem) +
		   sizeof(art->content_type) +
		   sizeof(art->content_size) +
		   sizeof(art->content_hash) +
		   sizeof(art->summary) +
		   sizeof(art->num_dependencies) +
		   (art->num_dependencies * sizeof(struct scada_dependency)) +
		   art->content_size;

	if (!buf)
		return required;

	if (len < required)
		return -ENOSPC;

	/* Serialize fixed fields */
	memcpy(p, art->id, sizeof(art->id));
	p += sizeof(art->id);

	memcpy(p, &art->timestamp, sizeof(art->timestamp));
	p += sizeof(art->timestamp);

	memcpy(p, &art->origin_type, sizeof(art->origin_type));
	p += sizeof(art->origin_type);

	memcpy(p, art->origin_id, sizeof(art->origin_id));
	p += sizeof(art->origin_id);

	memcpy(p, &art->scope, sizeof(art->scope));
	p += sizeof(art->scope);

	memcpy(p, art->subsystem, sizeof(art->subsystem));
	p += sizeof(art->subsystem);

	memcpy(p, &art->content_type, sizeof(art->content_type));
	p += sizeof(art->content_type);

	memcpy(p, &art->content_size, sizeof(art->content_size));
	p += sizeof(art->content_size);

	memcpy(p, art->content_hash, sizeof(art->content_hash));
	p += sizeof(art->content_hash);

	memcpy(p, art->summary, sizeof(art->summary));
	p += sizeof(art->summary);

	memcpy(p, &art->num_dependencies, sizeof(art->num_dependencies));
	p += sizeof(art->num_dependencies);

	if (art->num_dependencies > 0) {
		size_t deps_size = art->num_dependencies * sizeof(struct scada_dependency);
		memcpy(p, art->dependencies, deps_size);
		p += deps_size;
	}

	/* Serialize content */
	if (art->content && art->content_size > 0) {
		memcpy(p, art->content, art->content_size);
		p += art->content_size;
	}

	return (ssize_t)(p - (u8 *)buf);
}
EXPORT_SYMBOL_GPL(scada_artifact_serialize);

/**
 * scada_artifact_deserialize - Deserialize artifact from buffer
 * @buf: Input buffer
 * @len: Size of input buffer
 *
 * Returns pointer to new artifact or NULL on failure.
 * Caller must free with scada_artifact_put().
 */
struct scada_artifact *scada_artifact_deserialize(const void *buf, size_t len)
{
	struct scada_artifact *art;
	const u8 *p = buf;
	size_t content_size;
	unsigned int num_deps;

	/* Basic sanity check - at least need the fixed fields */
	if (len < sizeof(art->id) + sizeof(art->timestamp))
		return NULL;

	art = kzalloc(sizeof(*art), GFP_ATOMIC);
	if (!art)
		return NULL;

	kref_init(&art->refcount);
	INIT_LIST_HEAD(&art->list);

	/* Deserialize fixed fields */
	memcpy(art->id, p, sizeof(art->id));
	p += sizeof(art->id);

	memcpy(&art->timestamp, p, sizeof(art->timestamp));
	p += sizeof(art->timestamp);

	memcpy(&art->origin_type, p, sizeof(art->origin_type));
	p += sizeof(art->origin_type);

	memcpy(art->origin_id, p, sizeof(art->origin_id));
	p += sizeof(art->origin_id);

	memcpy(&art->scope, p, sizeof(art->scope));
	p += sizeof(art->scope);

	memcpy(art->subsystem, p, sizeof(art->subsystem));
	p += sizeof(art->subsystem);

	memcpy(&art->content_type, p, sizeof(art->content_type));
	p += sizeof(art->content_type);

	memcpy(&content_size, p, sizeof(content_size));
	art->content_size = content_size;
	p += sizeof(content_size);

	memcpy(art->content_hash, p, sizeof(art->content_hash));
	p += sizeof(art->content_hash);

	memcpy(art->summary, p, sizeof(art->summary));
	p += sizeof(art->summary);

	memcpy(&num_deps, p, sizeof(num_deps));
	p += sizeof(num_deps);

	if (num_deps > SCADA_MAX_DEPENDENCIES) {
		kfree(art);
		return NULL;
	}
	art->num_dependencies = num_deps;

	if (num_deps > 0) {
		size_t deps_size = num_deps * sizeof(struct scada_dependency);
		memcpy(art->dependencies, p, deps_size);
		p += deps_size;
	}

	/* Deserialize content */
	if (content_size > 0) {
		art->content = kmemdup(p, content_size, GFP_ATOMIC);
		if (!art->content) {
			kfree(art);
			return NULL;
		}
	}

	art->finalized = true;
	atomic64_inc(&artifact_count);

	return art;
}
EXPORT_SYMBOL_GPL(scada_artifact_deserialize);

static int __init scada_artifact_init(void)
{
	hash_tfm = crypto_alloc_shash(HASH_ALG, 0, 0);
	if (IS_ERR(hash_tfm)) {
		pr_err("0xscada: failed to allocate %s hash\n", HASH_ALG);
		return PTR_ERR(hash_tfm);
	}

	pr_info("0xscada: artifact subsystem initialized (version %s)\n",
		SCADA_ARTIFACT_VERSION);
	return 0;
}

static void __exit scada_artifact_exit(void)
{
	crypto_free_shash(hash_tfm);
	pr_info("0xscada: artifact subsystem unloaded (%lld artifacts created)\n",
		atomic64_read(&artifact_count));
}

module_init(scada_artifact_init);
module_exit(scada_artifact_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("0xSCADA Project");
MODULE_DESCRIPTION("0xSCADA Artifact Capture Infrastructure");
MODULE_VERSION(SCADA_ARTIFACT_VERSION);
