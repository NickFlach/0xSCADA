// SPDX-License-Identifier: GPL-2.0
/*
 * 0xSCADA Trace Capture - Lock-free Ring Buffer
 *
 * Simple ring buffer for trace event storage.
 * Designed for single-producer (per-CPU) usage with low overhead.
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#include <linux/slab.h>
#include <linux/vmalloc.h>
#include <linux/mm.h>

#include "scada_trace.h"

/*
 * Initialize ring buffer
 */
int scada_ring_init(struct scada_trace_ring *ring, size_t size)
{
	if (!ring || size < PAGE_SIZE)
		return -EINVAL;
	
	/* Align to page size */
	size = PAGE_ALIGN(size);
	
	spin_lock_init(&ring->lock);
	
	/* Use vmalloc for large allocations */
	if (size > (128 * 1024))
		ring->buffer = vmalloc(size);
	else
		ring->buffer = kmalloc(size, GFP_KERNEL);
	
	if (!ring->buffer)
		return -ENOMEM;
	
	ring->size = size;
	ring->head = 0;
	ring->tail = 0;
	ring->event_count = 0;
	ring->overflow_count = 0;
	ring->enabled = false;
	
	return 0;
}
EXPORT_SYMBOL_GPL(scada_ring_init);

/*
 * Destroy ring buffer
 */
void scada_ring_destroy(struct scada_trace_ring *ring)
{
	if (!ring)
		return;
	
	if (ring->buffer) {
		if (is_vmalloc_addr(ring->buffer))
			vfree(ring->buffer);
		else
			kfree(ring->buffer);
		ring->buffer = NULL;
	}
	
	ring->size = 0;
	ring->head = 0;
	ring->tail = 0;
}
EXPORT_SYMBOL_GPL(scada_ring_destroy);

/*
 * Get available space for writing
 */
static inline size_t scada_ring_avail(struct scada_trace_ring *ring)
{
	size_t head = ring->head;
	size_t tail = ring->tail;
	
	if (head >= tail)
		return ring->size - (head - tail) - 1;
	else
		return tail - head - 1;
}

/*
 * Get used space for reading
 */
size_t scada_ring_used(struct scada_trace_ring *ring)
{
	size_t head = ring->head;
	size_t tail = ring->tail;
	
	if (head >= tail)
		return head - tail;
	else
		return ring->size - tail + head;
}
EXPORT_SYMBOL_GPL(scada_ring_used);

/*
 * Write data to ring buffer
 * 
 * Caller must hold ring->lock
 * Returns 0 on success, -ENOSPC if insufficient space
 */
int scada_ring_write(struct scada_trace_ring *ring,
		     const void *data, size_t len)
{
	size_t avail;
	size_t first_chunk;
	const u8 *src = data;
	u8 *dst;
	
	if (!ring || !ring->buffer || !data || len == 0)
		return -EINVAL;
	
	avail = scada_ring_avail(ring);
	if (avail < len) {
		ring->overflow_count++;
		return -ENOSPC;
	}
	
	dst = ring->buffer;
	
	/* Handle wrap-around */
	if (ring->head + len <= ring->size) {
		/* No wrap needed */
		memcpy(dst + ring->head, src, len);
	} else {
		/* Split write */
		first_chunk = ring->size - ring->head;
		memcpy(dst + ring->head, src, first_chunk);
		memcpy(dst, src + first_chunk, len - first_chunk);
	}
	
	ring->head = (ring->head + len) % ring->size;
	
	return 0;
}
EXPORT_SYMBOL_GPL(scada_ring_write);

/*
 * Read data from ring buffer
 *
 * Caller must hold ring->lock
 * Returns number of bytes read, or negative error
 */
int scada_ring_read(struct scada_trace_ring *ring,
		    void *data, size_t len)
{
	size_t used;
	size_t first_chunk;
	size_t to_read;
	u8 *dst = data;
	u8 *src;
	
	if (!ring || !ring->buffer || !data)
		return -EINVAL;
	
	used = scada_ring_used(ring);
	if (used == 0)
		return 0;
	
	to_read = min(len, used);
	src = ring->buffer;
	
	/* Handle wrap-around */
	if (ring->tail + to_read <= ring->size) {
		/* No wrap needed */
		memcpy(dst, src + ring->tail, to_read);
	} else {
		/* Split read */
		first_chunk = ring->size - ring->tail;
		memcpy(dst, src + ring->tail, first_chunk);
		memcpy(dst + first_chunk, src, to_read - first_chunk);
	}
	
	ring->tail = (ring->tail + to_read) % ring->size;
	
	return to_read;
}
EXPORT_SYMBOL_GPL(scada_ring_read);

/*
 * Reset ring buffer to empty state
 */
void scada_ring_reset(struct scada_trace_ring *ring)
{
	if (!ring)
		return;
	
	ring->head = 0;
	ring->tail = 0;
	ring->event_count = 0;
}
EXPORT_SYMBOL_GPL(scada_ring_reset);

/*
 * Peek at data without consuming
 */
int scada_ring_peek(struct scada_trace_ring *ring,
		    void *data, size_t len, size_t offset)
{
	size_t used;
	size_t first_chunk;
	size_t actual_tail;
	size_t to_read;
	u8 *dst = data;
	u8 *src;
	
	if (!ring || !ring->buffer || !data)
		return -EINVAL;
	
	used = scada_ring_used(ring);
	if (offset >= used)
		return 0;
	
	to_read = min(len, used - offset);
	src = ring->buffer;
	actual_tail = (ring->tail + offset) % ring->size;
	
	if (actual_tail + to_read <= ring->size) {
		memcpy(dst, src + actual_tail, to_read);
	} else {
		first_chunk = ring->size - actual_tail;
		memcpy(dst, src + actual_tail, first_chunk);
		memcpy(dst + first_chunk, src, to_read - first_chunk);
	}
	
	return to_read;
}
EXPORT_SYMBOL_GPL(scada_ring_peek);

/*
 * Drop bytes from ring buffer (consume without reading)
 */
void scada_ring_drop(struct scada_trace_ring *ring, size_t len)
{
	size_t used;
	
	if (!ring)
		return;
	
	used = scada_ring_used(ring);
	if (len > used)
		len = used;
	
	ring->tail = (ring->tail + len) % ring->size;
}
EXPORT_SYMBOL_GPL(scada_ring_drop);
