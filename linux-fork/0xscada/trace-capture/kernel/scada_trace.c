// SPDX-License-Identifier: GPL-2.0
/*
 * 0xSCADA Trace Capture - Main Kernel Module
 *
 * VERITY Phase α.2.1: Reality artifact capture from kernel space
 *
 * This module provides low-overhead kernel trace capture for industrial
 * control systems, storing captures as content-addressed LFS artifacts.
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/init.h>
#include <linux/slab.h>
#include <linux/percpu.h>
#include <linux/debugfs.h>
#include <linux/uaccess.h>
#include <linux/random.h>
#include <linux/crc32.h>
#include <linux/ktime.h>
#include <linux/smp.h>

#include "scada_trace.h"

/*
 * Global trace context
 */
static struct scada_trace_ctx *trace_ctx;

/*
 * Module parameters
 */
static unsigned int ring_size = SCADA_TRACE_RING_SIZE;
module_param(ring_size, uint, 0444);
MODULE_PARM_DESC(ring_size, "Per-CPU ring buffer size in bytes");

static bool auto_link = true;
module_param(auto_link, bool, 0644);
MODULE_PARM_DESC(auto_link, "Automatically link captures to git HEAD");

/*
 * Get global context
 */
struct scada_trace_ctx *scada_trace_get_ctx(void)
{
	return trace_ctx;
}
EXPORT_SYMBOL_GPL(scada_trace_get_ctx);

/*
 * CRC32 helper
 */
u32 scada_crc32(const void *data, size_t len)
{
	return crc32(0, data, len);
}
EXPORT_SYMBOL_GPL(scada_crc32);

/*
 * Fill replay metadata for deterministic replay
 */
void scada_replay_metadata_fill(struct scada_replay_metadata *meta)
{
	memset(meta, 0, sizeof(*meta));
	
	meta->capture_timestamp_ns = ktime_get_boottime_ns();
	meta->boot_id = trace_ctx->boot_id;
	meta->cpu_id = smp_processor_id();
	meta->sequence_number = atomic64_inc_return(&trace_ctx->sequence_number);
	meta->metadata_version = 1;
	
	/* Copy current git commit if set */
	strscpy(meta->git_commit, trace_ctx->git_commit,
		sizeof(meta->git_commit));
	
	/* Compute checksum over all fields except checksum itself */
	meta->checksum = scada_crc32(meta, offsetof(struct scada_replay_metadata,
						    checksum));
}
EXPORT_SYMBOL_GPL(scada_replay_metadata_fill);

/*
 * Verify replay metadata integrity
 */
int scada_replay_metadata_verify(const struct scada_replay_metadata *meta)
{
	u32 computed;
	
	if (meta->metadata_version != 1)
		return -EINVAL;
	
	computed = scada_crc32(meta, offsetof(struct scada_replay_metadata,
					      checksum));
	
	if (computed != meta->checksum)
		return -EILSEQ;
	
	return 0;
}
EXPORT_SYMBOL_GPL(scada_replay_metadata_verify);

/*
 * Set git commit for linking
 */
int scada_trace_set_commit(const char *commit_hash)
{
	if (!commit_hash)
		return -EINVAL;
	
	/* Validate format: 40 hex characters */
	if (strlen(commit_hash) != 40)
		return -EINVAL;
	
	for (int i = 0; i < 40; i++) {
		char c = commit_hash[i];
		if (!((c >= '0' && c <= '9') ||
		      (c >= 'a' && c <= 'f') ||
		      (c >= 'A' && c <= 'F')))
			return -EINVAL;
	}
	
	strscpy(trace_ctx->git_commit, commit_hash,
		sizeof(trace_ctx->git_commit));
	
	return 0;
}
EXPORT_SYMBOL_GPL(scada_trace_set_commit);

const char *scada_trace_get_commit(void)
{
	if (trace_ctx->git_commit[0] == '\0')
		return NULL;
	return trace_ctx->git_commit;
}
EXPORT_SYMBOL_GPL(scada_trace_get_commit);

/*
 * Record a trace event
 */
int scada_trace_event(enum scada_trace_type type, u16 flags,
		      const void *data, size_t len)
{
	struct scada_trace_ring *ring;
	struct scada_trace_event event;
	int ret;
	unsigned long irq_flags;
	
	if (!trace_ctx)
		return -ENODEV;
	
	ring = this_cpu_ptr(trace_ctx->rings);
	if (!ring->enabled)
		return -EAGAIN;
	
	/* Build event header */
	event.magic = SCADA_TRACE_MAGIC;
	event.type = type;
	event.flags = flags;
	event.timestamp_ns = ktime_get_boottime_ns();
	event.cpu = smp_processor_id();
	event.pid = current->pid;
	event.data_len = len;
	event.reserved = 0;
	
	/* Add RT context flag if applicable */
	if (in_atomic() || irqs_disabled())
		event.flags |= SCADA_TRACE_F_REALTIME;
	
	spin_lock_irqsave(&ring->lock, irq_flags);
	
	/* Write header */
	ret = scada_ring_write(ring, &event, sizeof(event));
	if (ret < 0)
		goto out;
	
	/* Write payload */
	if (len > 0 && data) {
		ret = scada_ring_write(ring, data, len);
		if (ret < 0)
			goto out;
	}
	
	ring->event_count++;
	atomic_inc(&trace_ctx->total_captures);
	atomic64_add(sizeof(event) + len, &trace_ctx->total_bytes);
	ret = 0;
	
out:
	spin_unlock_irqrestore(&ring->lock, irq_flags);
	return ret;
}
EXPORT_SYMBOL_GPL(scada_trace_event);

/*
 * Record Modbus register burst
 */
int scada_trace_modbus_burst(const struct scada_modbus_burst *burst,
			     const u16 *registers)
{
	size_t reg_size;
	void *buf;
	int ret;
	
	if (!burst || !registers)
		return -EINVAL;
	
	reg_size = burst->register_count * sizeof(u16);
	buf = kmalloc(sizeof(*burst) + reg_size, GFP_ATOMIC);
	if (!buf)
		return -ENOMEM;
	
	memcpy(buf, burst, sizeof(*burst));
	memcpy(buf + sizeof(*burst), registers, reg_size);
	
	ret = scada_trace_event(SCADA_TRACE_SENSOR, 0,
				buf, sizeof(*burst) + reg_size);
	
	kfree(buf);
	return ret;
}
EXPORT_SYMBOL_GPL(scada_trace_modbus_burst);

/*
 * Record firmware chunk
 */
int scada_trace_firmware_chunk(const struct scada_firmware_meta *meta,
			       const void *data)
{
	void *buf;
	int ret;
	
	if (!meta || !data)
		return -EINVAL;
	
	buf = kmalloc(sizeof(*meta) + meta->chunk_size, GFP_KERNEL);
	if (!buf)
		return -ENOMEM;
	
	memcpy(buf, meta, sizeof(*meta));
	memcpy(buf + sizeof(*meta), data, meta->chunk_size);
	
	ret = scada_trace_event(SCADA_TRACE_FIRMWARE, 0,
				buf, sizeof(*meta) + meta->chunk_size);
	
	kfree(buf);
	return ret;
}
EXPORT_SYMBOL_GPL(scada_trace_firmware_chunk);

/*
 * Begin atomic snapshot
 */
int scada_snapshot_begin(void)
{
	unsigned long flags;
	
	spin_lock_irqsave(&trace_ctx->snapshot_lock, flags);
	
	if (trace_ctx->snapshot_in_progress) {
		spin_unlock_irqrestore(&trace_ctx->snapshot_lock, flags);
		return -EBUSY;
	}
	
	trace_ctx->current_snapshot = kzalloc(trace_ctx->max_snapshot_size,
					      GFP_ATOMIC);
	if (!trace_ctx->current_snapshot) {
		spin_unlock_irqrestore(&trace_ctx->snapshot_lock, flags);
		return -ENOMEM;
	}
	
	trace_ctx->snapshot_in_progress = true;
	
	/* Initialize snapshot header */
	trace_ctx->current_snapshot->magic = SCADA_TRACE_MAGIC;
	trace_ctx->current_snapshot->version = 1;
	trace_ctx->current_snapshot->snapshot_id = 
		atomic64_inc_return(&trace_ctx->sequence_number);
	scada_replay_metadata_fill(&trace_ctx->current_snapshot->replay);
	trace_ctx->current_snapshot->start_timestamp_ns = ktime_get_boottime_ns();
	trace_ctx->current_snapshot->total_size = sizeof(struct scada_snapshot_header);
	
	spin_unlock_irqrestore(&trace_ctx->snapshot_lock, flags);
	
	return 0;
}
EXPORT_SYMBOL_GPL(scada_snapshot_begin);

/*
 * Commit snapshot to userspace
 */
int scada_snapshot_commit(void __user *buf, size_t *len)
{
	unsigned long flags;
	size_t snapshot_size;
	int ret = 0;
	
	spin_lock_irqsave(&trace_ctx->snapshot_lock, flags);
	
	if (!trace_ctx->snapshot_in_progress || !trace_ctx->current_snapshot) {
		spin_unlock_irqrestore(&trace_ctx->snapshot_lock, flags);
		return -EINVAL;
	}
	
	/* Finalize snapshot */
	trace_ctx->current_snapshot->end_timestamp_ns = ktime_get_boottime_ns();
	trace_ctx->current_snapshot->checksum = 
		scada_crc32(trace_ctx->current_snapshot,
			    trace_ctx->current_snapshot->total_size - sizeof(u32));
	
	snapshot_size = trace_ctx->current_snapshot->total_size;
	
	if (*len < snapshot_size) {
		*len = snapshot_size;  /* Tell caller needed size */
		ret = -ENOSPC;
		goto out;
	}
	
	if (copy_to_user(buf, trace_ctx->current_snapshot, snapshot_size)) {
		ret = -EFAULT;
		goto out;
	}
	
	*len = snapshot_size;
	atomic_inc(&trace_ctx->total_snapshots);
	
out:
	kfree(trace_ctx->current_snapshot);
	trace_ctx->current_snapshot = NULL;
	trace_ctx->snapshot_in_progress = false;
	spin_unlock_irqrestore(&trace_ctx->snapshot_lock, flags);
	
	return ret;
}
EXPORT_SYMBOL_GPL(scada_snapshot_commit);

/*
 * Abort in-progress snapshot
 */
void scada_snapshot_abort(void)
{
	unsigned long flags;
	
	spin_lock_irqsave(&trace_ctx->snapshot_lock, flags);
	
	if (trace_ctx->current_snapshot) {
		kfree(trace_ctx->current_snapshot);
		trace_ctx->current_snapshot = NULL;
	}
	trace_ctx->snapshot_in_progress = false;
	
	spin_unlock_irqrestore(&trace_ctx->snapshot_lock, flags);
}
EXPORT_SYMBOL_GPL(scada_snapshot_abort);

/*
 * Debugfs: Show statistics
 */
static int scada_trace_stats_show(struct seq_file *m, void *v)
{
	seq_printf(m, "0xSCADA Trace Capture v%d.%d.%d\n",
		   SCADA_TRACE_VERSION_MAJOR,
		   SCADA_TRACE_VERSION_MINOR,
		   SCADA_TRACE_VERSION_PATCH);
	seq_printf(m, "Boot ID: 0x%016llx\n", trace_ctx->boot_id);
	seq_printf(m, "Git Commit: %s\n",
		   trace_ctx->git_commit[0] ? trace_ctx->git_commit : "(none)");
	seq_printf(m, "Total Captures: %d\n", atomic_read(&trace_ctx->total_captures));
	seq_printf(m, "Total Snapshots: %d\n", atomic_read(&trace_ctx->total_snapshots));
	seq_printf(m, "Total Bytes: %lld\n", atomic64_read(&trace_ctx->total_bytes));
	seq_printf(m, "Current Sequence: %lld\n",
		   atomic64_read(&trace_ctx->sequence_number));
	seq_printf(m, "Ring Buffer Size: %u\n", trace_ctx->ring_size);
	seq_printf(m, "Auto Link Commits: %s\n",
		   trace_ctx->auto_link_commits ? "yes" : "no");
	
	return 0;
}
DEFINE_SHOW_ATTRIBUTE(scada_trace_stats);

/*
 * Debugfs: Set git commit
 */
static ssize_t scada_trace_commit_write(struct file *file,
					const char __user *buf,
					size_t count, loff_t *ppos)
{
	char commit[SCADA_TRACE_GIT_HASH_LEN];
	int ret;
	
	if (count < 40 || count > 41)  /* 40 chars + optional newline */
		return -EINVAL;
	
	memset(commit, 0, sizeof(commit));
	if (copy_from_user(commit, buf, 40))
		return -EFAULT;
	
	ret = scada_trace_set_commit(commit);
	if (ret < 0)
		return ret;
	
	return count;
}

static ssize_t scada_trace_commit_read(struct file *file, char __user *buf,
				       size_t count, loff_t *ppos)
{
	char commit[SCADA_TRACE_GIT_HASH_LEN + 1];
	size_t len;
	
	if (*ppos > 0)
		return 0;
	
	if (trace_ctx->git_commit[0] == '\0')
		snprintf(commit, sizeof(commit), "(none)\n");
	else
		snprintf(commit, sizeof(commit), "%s\n", trace_ctx->git_commit);
	
	len = strlen(commit);
	if (count < len)
		return -EINVAL;
	
	if (copy_to_user(buf, commit, len))
		return -EFAULT;
	
	*ppos = len;
	return len;
}

static const struct file_operations scada_trace_commit_fops = {
	.owner = THIS_MODULE,
	.read = scada_trace_commit_read,
	.write = scada_trace_commit_write,
};

/*
 * Debugfs: Enable/disable tracing
 */
static ssize_t scada_trace_enable_write(struct file *file,
					const char __user *buf,
					size_t count, loff_t *ppos)
{
	char val;
	int cpu;
	
	if (count < 1)
		return -EINVAL;
	
	if (get_user(val, buf))
		return -EFAULT;
	
	for_each_possible_cpu(cpu) {
		struct scada_trace_ring *ring = per_cpu_ptr(trace_ctx->rings, cpu);
		ring->enabled = (val == '1');
	}
	
	return count;
}

static ssize_t scada_trace_enable_read(struct file *file, char __user *buf,
				       size_t count, loff_t *ppos)
{
	struct scada_trace_ring *ring;
	char val[3];
	
	if (*ppos > 0)
		return 0;
	
	ring = per_cpu_ptr(trace_ctx->rings, 0);
	snprintf(val, sizeof(val), "%d\n", ring->enabled ? 1 : 0);
	
	if (copy_to_user(buf, val, 2))
		return -EFAULT;
	
	*ppos = 2;
	return 2;
}

static const struct file_operations scada_trace_enable_fops = {
	.owner = THIS_MODULE,
	.read = scada_trace_enable_read,
	.write = scada_trace_enable_write,
};

/*
 * Initialize debugfs interface
 */
int scada_trace_debugfs_init(struct scada_trace_ctx *ctx)
{
	ctx->debugfs_root = debugfs_create_dir("scada_trace", NULL);
	if (IS_ERR_OR_NULL(ctx->debugfs_root))
		return -ENODEV;
	
	debugfs_create_file("stats", 0444, ctx->debugfs_root, NULL,
			    &scada_trace_stats_fops);
	debugfs_create_file("commit", 0644, ctx->debugfs_root, NULL,
			    &scada_trace_commit_fops);
	debugfs_create_file("enable", 0644, ctx->debugfs_root, NULL,
			    &scada_trace_enable_fops);
	
	return 0;
}

void scada_trace_debugfs_cleanup(struct scada_trace_ctx *ctx)
{
	debugfs_remove_recursive(ctx->debugfs_root);
}

/*
 * Module initialization
 */
static int __init scada_trace_init(void)
{
	int cpu, ret;
	
	pr_info("0xSCADA Trace Capture v%d.%d.%d initializing\n",
		SCADA_TRACE_VERSION_MAJOR,
		SCADA_TRACE_VERSION_MINOR,
		SCADA_TRACE_VERSION_PATCH);
	
	/* Allocate global context */
	trace_ctx = kzalloc(sizeof(*trace_ctx), GFP_KERNEL);
	if (!trace_ctx)
		return -ENOMEM;
	
	/* Initialize state */
	atomic64_set(&trace_ctx->sequence_number, 0);
	get_random_bytes(&trace_ctx->boot_id, sizeof(trace_ctx->boot_id));
	spin_lock_init(&trace_ctx->snapshot_lock);
	atomic_set(&trace_ctx->total_captures, 0);
	atomic_set(&trace_ctx->total_snapshots, 0);
	atomic64_set(&trace_ctx->total_bytes, 0);
	trace_ctx->auto_link_commits = auto_link;
	trace_ctx->ring_size = ring_size;
	trace_ctx->max_snapshot_size = ring_size * 2;  /* Allow larger snapshots */
	
	/* Allocate per-CPU ring buffers */
	trace_ctx->rings = alloc_percpu(struct scada_trace_ring);
	if (!trace_ctx->rings) {
		ret = -ENOMEM;
		goto err_free_ctx;
	}
	
	for_each_possible_cpu(cpu) {
		struct scada_trace_ring *ring = per_cpu_ptr(trace_ctx->rings, cpu);
		ret = scada_ring_init(ring, ring_size);
		if (ret < 0)
			goto err_free_rings;
		ring->enabled = true;
	}
	
	/* Create workqueue */
	trace_ctx->wq = create_singlethread_workqueue("scada_trace");
	if (!trace_ctx->wq) {
		ret = -ENOMEM;
		goto err_free_rings;
	}
	
	/* Setup debugfs */
	ret = scada_trace_debugfs_init(trace_ctx);
	if (ret < 0)
		pr_warn("scada_trace: debugfs init failed, continuing\n");
	
	pr_info("scada_trace: Boot ID 0x%016llx, ring size %u bytes\n",
		trace_ctx->boot_id, ring_size);
	
	return 0;

err_free_rings:
	for_each_possible_cpu(cpu) {
		struct scada_trace_ring *ring = per_cpu_ptr(trace_ctx->rings, cpu);
		scada_ring_destroy(ring);
	}
	free_percpu(trace_ctx->rings);
err_free_ctx:
	kfree(trace_ctx);
	trace_ctx = NULL;
	return ret;
}

static void __exit scada_trace_exit(void)
{
	int cpu;
	
	pr_info("scada_trace: unloading\n");
	
	if (trace_ctx) {
		scada_trace_debugfs_cleanup(trace_ctx);
		
		if (trace_ctx->wq)
			destroy_workqueue(trace_ctx->wq);
		
		scada_snapshot_abort();
		
		if (trace_ctx->rings) {
			for_each_possible_cpu(cpu) {
				struct scada_trace_ring *ring = 
					per_cpu_ptr(trace_ctx->rings, cpu);
				scada_ring_destroy(ring);
			}
			free_percpu(trace_ctx->rings);
		}
		
		kfree(trace_ctx);
		trace_ctx = NULL;
	}
}

module_init(scada_trace_init);
module_exit(scada_trace_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("0xSCADA Project");
MODULE_DESCRIPTION("Reality artifact trace capture for industrial control");
MODULE_VERSION("0.1.0");
