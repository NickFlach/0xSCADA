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
 */
struct scada_artifact *scada_artifact_create(enum scada_origin_type origin,
					     enum scada_scope scope)
{
	struct scada_artifact *art;

	art = kzalloc(sizeof(*art), GFP_KERNEL);
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
 */
int scada_artifact_set_content(struct scada_artifact *art,
			       const void *data, size_t len)
{
	void *new_content;

	if (art->finalized)
		return -EINVAL;

	new_content = kmemdup(data, len, GFP_KERNEL);
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
	struct crypto_shash *tfm;
	SHASH_DESC_ON_STACK(desc, tfm);
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
