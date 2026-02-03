// SPDX-License-Identifier: GPL-2.0
/*
 * 0xSCADA Latency Tracing eBPF Program
 *
 * Captures function latency for critical industrial control paths.
 * Designed for low-overhead tracing suitable for SCADA systems.
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

char LICENSE[] SEC("license") = "GPL";

#define MAX_ENTRIES 10000
#define SCADA_LATENCY_NS_THRESHOLD 100000  /* 100us */

/*
 * Latency event structure
 */
struct latency_event {
	u64 timestamp_ns;
	u64 duration_ns;
	u32 pid;
	u32 cpu;
	char comm[16];
	char func_name[32];
};

/*
 * Ring buffer for latency events
 */
struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);  /* 256KB */
} events SEC(".maps");

/*
 * Hash map for tracking function entry times
 */
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, MAX_ENTRIES);
	__type(key, u64);  /* pid_tgid */
	__type(value, u64);  /* entry timestamp */
} entry_times SEC(".maps");

/*
 * Histogram buckets for latency distribution
 */
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 32);  /* log2 buckets */
	__type(key, u32);
	__type(value, u64);
} latency_hist SEC(".maps");

/*
 * Statistics
 */
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 4);
	__type(key, u32);
	__type(value, u64);
} stats SEC(".maps");

#define STAT_CALLS 0
#define STAT_SLOW 1
#define STAT_ERRORS 2
#define STAT_DROPPED 3

/*
 * Helper: Increment stat counter
 */
static __always_inline void inc_stat(u32 stat)
{
	u64 *val = bpf_map_lookup_elem(&stats, &stat);
	if (val)
		__sync_fetch_and_add(val, 1);
}

/*
 * Helper: Record to histogram
 */
static __always_inline void record_histogram(u64 latency_ns)
{
	/* Find log2 bucket */
	u32 bucket = 0;
	u64 val = latency_ns;
	
	while (val > 1 && bucket < 31) {
		val >>= 1;
		bucket++;
	}
	
	u64 *count = bpf_map_lookup_elem(&latency_hist, &bucket);
	if (count)
		__sync_fetch_and_add(count, 1);
}

/*
 * Function entry probe
 */
SEC("fentry/scada_trace_event")
int BPF_PROG(trace_scada_entry)
{
	u64 pid_tgid = bpf_get_current_pid_tgid();
	u64 ts = bpf_ktime_get_ns();
	
	bpf_map_update_elem(&entry_times, &pid_tgid, &ts, BPF_ANY);
	inc_stat(STAT_CALLS);
	
	return 0;
}

/*
 * Function exit probe
 */
SEC("fexit/scada_trace_event")
int BPF_PROG(trace_scada_exit, int ret)
{
	u64 pid_tgid = bpf_get_current_pid_tgid();
	u64 *entry_ts;
	u64 exit_ts = bpf_ktime_get_ns();
	u64 duration_ns;
	struct latency_event *e;
	
	entry_ts = bpf_map_lookup_elem(&entry_times, &pid_tgid);
	if (!entry_ts)
		return 0;
	
	duration_ns = exit_ts - *entry_ts;
	bpf_map_delete_elem(&entry_times, &pid_tgid);
	
	/* Record histogram */
	record_histogram(duration_ns);
	
	/* Only emit event if latency exceeds threshold */
	if (duration_ns < SCADA_LATENCY_NS_THRESHOLD)
		return 0;
	
	inc_stat(STAT_SLOW);
	
	/* Reserve ring buffer space */
	e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		inc_stat(STAT_DROPPED);
		return 0;
	}
	
	e->timestamp_ns = exit_ts;
	e->duration_ns = duration_ns;
	e->pid = pid_tgid >> 32;
	e->cpu = bpf_get_smp_processor_id();
	bpf_get_current_comm(&e->comm, sizeof(e->comm));
	__builtin_memcpy(e->func_name, "scada_trace_event", 18);
	
	bpf_ringbuf_submit(e, 0);
	
	return 0;
}

/*
 * Modbus I/O tracing (placeholder)
 */
SEC("kprobe/tcp_sendmsg")
int BPF_KPROBE(trace_tcp_send, struct sock *sk)
{
	u16 dport;
	
	/* Read destination port */
	bpf_probe_read_kernel(&dport, sizeof(dport), &sk->__sk_common.skc_dport);
	dport = __builtin_bswap16(dport);
	
	/* Only trace Modbus TCP (port 502) */
	if (dport != 502)
		return 0;
	
	/* Record entry time for latency tracking */
	u64 pid_tgid = bpf_get_current_pid_tgid();
	u64 ts = bpf_ktime_get_ns();
	bpf_map_update_elem(&entry_times, &pid_tgid, &ts, BPF_ANY);
	
	return 0;
}

/*
 * I/O latency tracing
 */
SEC("kprobe/blk_account_io_done")
int BPF_KPROBE(trace_io_done, struct request *req)
{
	struct latency_event *e;
	u64 duration_ns;
	
	/* Get I/O duration from request */
	u64 start = BPF_CORE_READ(req, io_start_time_ns);
	u64 now = bpf_ktime_get_ns();
	duration_ns = now - start;
	
	/* Skip fast I/O */
	if (duration_ns < SCADA_LATENCY_NS_THRESHOLD)
		return 0;
	
	e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return 0;
	
	e->timestamp_ns = now;
	e->duration_ns = duration_ns;
	e->pid = bpf_get_current_pid_tgid() >> 32;
	e->cpu = bpf_get_smp_processor_id();
	bpf_get_current_comm(&e->comm, sizeof(e->comm));
	__builtin_memcpy(e->func_name, "blk_io_done", 12);
	
	bpf_ringbuf_submit(e, 0);
	
	return 0;
}
