// SPDX-License-Identifier: GPL-2.0
/*
 * 0xSCADA Trace Capture - Atomic Snapshot
 *
 * Provides atomic capture of trace state across all CPUs,
 * creating a consistent snapshot for LFS artifact storage.
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#include <linux/slab.h>
#include <linux/smp.h>
#include <linux/cpu.h>
#include <linux/completion.h>
#include <linux/atomic.h>

#include "scada_trace.h"

/*
 * Per-CPU snapshot work data
 */
struct snapshot_work {
	struct completion done;
	struct scada_trace_ring *ring;
	void *buffer;
	size_t size;
	size_t captured;
	int result;
};

static DEFINE_PER_CPU(struct snapshot_work, snapshot_works);

/*
 * Per-CPU snapshot capture function (runs on target CPU via IPI)
 */
static void do_cpu_snapshot(void *info)
{
	struct snapshot_work *work = this_cpu_ptr(&snapshot_works);
	struct scada_trace_ring *ring = work->ring;
	unsigned long flags;
	size_t used;
	
	spin_lock_irqsave(&ring->lock, flags);
	
	used = scada_ring_used(ring);
	if (used > work->size) {
		work->result = -ENOSPC;
		work->captured = 0;
	} else {
		work->captured = scada_ring_read(ring, work->buffer, used);
		work->result = 0;
	}
	
	spin_unlock_irqrestore(&ring->lock, flags);
	
	complete(&work->done);
}

/*
 * Capture all per-CPU ring buffers atomically
 *
 * This function:
 * 1. Allocates buffers for each CPU
 * 2. Sends IPI to capture each ring
 * 3. Aggregates into a single snapshot
 * 4. Returns the combined data
 */
int scada_snapshot_capture_all(void **data, size_t *total_len)
{
	struct scada_trace_ctx *ctx = scada_trace_get_ctx();
	struct scada_snapshot_header *header;
	int cpu, online_cpus;
	size_t total_size = 0;
	size_t header_size;
	void *combined;
	int ret = 0;
	
	if (!ctx || !data || !total_len)
		return -EINVAL;
	
	/* Count online CPUs and allocate work buffers */
	online_cpus = 0;
	for_each_online_cpu(cpu) {
		struct snapshot_work *work = per_cpu_ptr(&snapshot_works, cpu);
		struct scada_trace_ring *ring = per_cpu_ptr(ctx->rings, cpu);
		
		init_completion(&work->done);
		work->ring = ring;
		work->size = ring->size;
		work->buffer = vmalloc(ring->size);
		if (!work->buffer) {
			ret = -ENOMEM;
			goto cleanup;
		}
		work->captured = 0;
		work->result = 0;
		online_cpus++;
	}
	
	/* Send IPIs to capture all CPUs */
	smp_call_function(do_cpu_snapshot, NULL, 0);
	/* Also capture on current CPU */
	do_cpu_snapshot(NULL);
	
	/* Wait for all completions */
	for_each_online_cpu(cpu) {
		struct snapshot_work *work = per_cpu_ptr(&snapshot_works, cpu);
		wait_for_completion(&work->done);
		
		if (work->result < 0) {
			ret = work->result;
			goto cleanup;
		}
		total_size += work->captured;
	}
	
	/* Allocate combined buffer */
	header_size = sizeof(struct scada_snapshot_header);
	combined = vmalloc(header_size + total_size);
	if (!combined) {
		ret = -ENOMEM;
		goto cleanup;
	}
	
	/* Build snapshot header */
	header = (struct scada_snapshot_header *)combined;
	memset(header, 0, header_size);
	header->magic = SCADA_TRACE_MAGIC;
	header->version = 1;
	header->snapshot_id = atomic64_inc_return(&ctx->sequence_number);
	scada_replay_metadata_fill(&header->replay);
	header->event_count = 0;  /* Will be counted during copy */
	header->total_size = header_size + total_size;
	header->start_timestamp_ns = ktime_get_boottime_ns();
	
	/* Copy per-CPU data into combined buffer */
	{
		size_t offset = header_size;
		for_each_online_cpu(cpu) {
			struct snapshot_work *work = per_cpu_ptr(&snapshot_works, cpu);
			
			if (work->captured > 0) {
				memcpy(combined + offset, work->buffer, work->captured);
				offset += work->captured;
				
				/* Count events (rough estimate) */
				header->event_count += work->ring->event_count;
			}
		}
	}
	
	header->end_timestamp_ns = ktime_get_boottime_ns();
	header->checksum = scada_crc32(combined, header->total_size - sizeof(u32));
	
	*data = combined;
	*total_len = header_size + total_size;
	
cleanup:
	/* Free per-CPU work buffers */
	for_each_online_cpu(cpu) {
		struct snapshot_work *work = per_cpu_ptr(&snapshot_works, cpu);
		if (work->buffer) {
			vfree(work->buffer);
			work->buffer = NULL;
		}
	}
	
	return ret;
}
EXPORT_SYMBOL_GPL(scada_snapshot_capture_all);

/*
 * Capture single CPU's ring buffer
 */
int scada_snapshot_capture_cpu(int cpu, void **data, size_t *len)
{
	struct scada_trace_ctx *ctx = scada_trace_get_ctx();
	struct scada_trace_ring *ring;
	struct scada_snapshot_header *header;
	void *buffer;
	size_t used;
	size_t total;
	unsigned long flags;
	
	if (!ctx || !data || !len)
		return -EINVAL;
	
	if (cpu < 0 || cpu >= nr_cpu_ids || !cpu_online(cpu))
		return -EINVAL;
	
	ring = per_cpu_ptr(ctx->rings, cpu);
	
	spin_lock_irqsave(&ring->lock, flags);
	used = scada_ring_used(ring);
	spin_unlock_irqrestore(&ring->lock, flags);
	
	if (used == 0) {
		*data = NULL;
		*len = 0;
		return 0;
	}
	
	total = sizeof(struct scada_snapshot_header) + used;
	buffer = vmalloc(total);
	if (!buffer)
		return -ENOMEM;
	
	/* Build header */
	header = (struct scada_snapshot_header *)buffer;
	memset(header, 0, sizeof(*header));
	header->magic = SCADA_TRACE_MAGIC;
	header->version = 1;
	header->snapshot_id = atomic64_inc_return(&ctx->sequence_number);
	scada_replay_metadata_fill(&header->replay);
	header->replay.cpu_id = cpu;
	header->start_timestamp_ns = ktime_get_boottime_ns();
	
	/* Copy ring data */
	spin_lock_irqsave(&ring->lock, flags);
	header->event_count = ring->event_count;
	scada_ring_read(ring, buffer + sizeof(*header), used);
	spin_unlock_irqrestore(&ring->lock, flags);
	
	header->total_size = total;
	header->end_timestamp_ns = ktime_get_boottime_ns();
	header->checksum = scada_crc32(buffer, total - sizeof(u32));
	
	*data = buffer;
	*len = total;
	
	return 0;
}
EXPORT_SYMBOL_GPL(scada_snapshot_capture_cpu);

/*
 * Free snapshot data
 */
void scada_snapshot_free(void *data)
{
	if (data)
		vfree(data);
}
EXPORT_SYMBOL_GPL(scada_snapshot_free);

/*
 * Validate snapshot integrity
 */
int scada_snapshot_validate(const void *data, size_t len)
{
	const struct scada_snapshot_header *header = data;
	u32 computed;
	
	if (!data || len < sizeof(struct scada_snapshot_header))
		return -EINVAL;
	
	if (header->magic != SCADA_TRACE_MAGIC)
		return -EINVAL;
	
	if (header->version != 1)
		return -EINVAL;
	
	if (header->total_size != len)
		return -EINVAL;
	
	/* Verify CRC */
	computed = scada_crc32(data, len - sizeof(u32));
	if (computed != header->checksum)
		return -EILSEQ;
	
	/* Verify replay metadata */
	return scada_replay_metadata_verify(&header->replay);
}
EXPORT_SYMBOL_GPL(scada_snapshot_validate);
