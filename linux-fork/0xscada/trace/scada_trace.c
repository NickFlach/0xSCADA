// SPDX-License-Identifier: GPL-2.0-only
/*
 * 0xSCADA Trace Hooks
 *
 * SCADA-specific ftrace integration for capturing industrial control
 * system events as reality artifacts.
 *
 * Copyright (c) 2024 0xSCADA Project
 */

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/ftrace.h>
#include <linux/tracepoint.h>
#include <linux/sched.h>

#include "../core/artifact.h"

/* Trace categories */
#define SCADA_TRACE_SYSCALL	BIT(0)
#define SCADA_TRACE_IRQ		BIT(1)
#define SCADA_TRACE_TIMER	BIT(2)
#define SCADA_TRACE_IO		BIT(3)
#define SCADA_TRACE_NET		BIT(4)

static unsigned int trace_mask = SCADA_TRACE_SYSCALL | SCADA_TRACE_IO;
module_param(trace_mask, uint, 0644);
MODULE_PARM_DESC(trace_mask, "Bitmask of trace categories to capture");

static bool trace_enabled = true;
module_param(trace_enabled, bool, 0644);
MODULE_PARM_DESC(trace_enabled, "Enable/disable trace capture");

/* Per-CPU trace buffers */
static DEFINE_PER_CPU(struct scada_artifact *, pending_artifact);

/**
 * struct scada_trace_event - Trace event data
 * @timestamp: Event timestamp (ns)
 * @cpu: CPU where event occurred
 * @pid: Process ID
 * @comm: Process name
 * @event_type: Type of event
 * @data: Event-specific data
 * @data_len: Length of event data
 */
struct scada_trace_event {
	u64 timestamp;
	unsigned int cpu;
	pid_t pid;
	char comm[TASK_COMM_LEN];
	u32 event_type;
	u8 data[256];
	size_t data_len;
};

/**
 * scada_trace_create_artifact - Create an artifact from a trace event
 * @event: Trace event to capture
 *
 * Returns 0 on success, negative error on failure.
 */
static int scada_trace_create_artifact(struct scada_trace_event *event)
{
	struct scada_artifact *art;
	char summary[128];
	int ret;

	if (!trace_enabled)
		return 0;

	art = scada_artifact_create(SCADA_ORIGIN_SYSTEM, SCADA_SCOPE_LINUX);
	if (!art)
		return -ENOMEM;

	ret = scada_artifact_set_origin_id(art, "linux-fork/trace/scada_trace");
	if (ret)
		goto err;

	ret = scada_artifact_set_subsystem(art, "ftrace");
	if (ret)
		goto err;

	ret = scada_artifact_set_content_type(art, SCADA_CONTENT_TRACE);
	if (ret)
		goto err;

	ret = scada_artifact_set_content(art, event, sizeof(*event));
	if (ret)
		goto err;

	snprintf(summary, sizeof(summary),
		 "Trace event: type=%u cpu=%u pid=%d comm=%s",
		 event->event_type, event->cpu, event->pid, event->comm);
	ret = scada_artifact_set_summary(art, summary);
	if (ret)
		goto err;

	ret = scada_artifact_finalize(art);
	if (ret)
		goto err;

	/* Artifact is now in the global list, release our reference */
	scada_artifact_put(art);
	return 0;

err:
	scada_artifact_put(art);
	return ret;
}

/**
 * scada_trace_syscall - Trace a system call
 * @nr: System call number
 * @args: System call arguments
 */
void scada_trace_syscall(unsigned long nr, unsigned long *args)
{
	struct scada_trace_event event = {
		.timestamp = ktime_get_real_ns(),
		.cpu = raw_smp_processor_id(),
		.pid = current->pid,
		.event_type = SCADA_TRACE_SYSCALL,
	};

	if (!(trace_mask & SCADA_TRACE_SYSCALL))
		return;

	get_task_comm(event.comm, current);
	
	/* Store syscall number and first 4 args */
	((unsigned long *)event.data)[0] = nr;
	memcpy(event.data + sizeof(unsigned long), args,
	       4 * sizeof(unsigned long));
	event.data_len = 5 * sizeof(unsigned long);

	scada_trace_create_artifact(&event);
}
EXPORT_SYMBOL_GPL(scada_trace_syscall);

/**
 * scada_trace_io - Trace an I/O operation
 * @port: I/O port or address
 * @value: Value read/written
 * @is_write: True if write operation
 */
void scada_trace_io(unsigned long port, unsigned long value, bool is_write)
{
	struct scada_trace_event event = {
		.timestamp = ktime_get_real_ns(),
		.cpu = raw_smp_processor_id(),
		.pid = current->pid,
		.event_type = SCADA_TRACE_IO,
	};

	if (!(trace_mask & SCADA_TRACE_IO))
		return;

	get_task_comm(event.comm, current);
	
	/* Store I/O details */
	((unsigned long *)event.data)[0] = port;
	((unsigned long *)event.data)[1] = value;
	((unsigned long *)event.data)[2] = is_write ? 1 : 0;
	event.data_len = 3 * sizeof(unsigned long);

	scada_trace_create_artifact(&event);
}
EXPORT_SYMBOL_GPL(scada_trace_io);

/**
 * scada_trace_irq - Trace an interrupt
 * @irq: IRQ number
 * @handler: Handler name
 */
void scada_trace_irq(unsigned int irq, const char *handler)
{
	struct scada_trace_event event = {
		.timestamp = ktime_get_real_ns(),
		.cpu = raw_smp_processor_id(),
		.pid = current->pid,
		.event_type = SCADA_TRACE_IRQ,
	};

	if (!(trace_mask & SCADA_TRACE_IRQ))
		return;

	get_task_comm(event.comm, current);
	
	/* Store IRQ details */
	((unsigned int *)event.data)[0] = irq;
	strscpy((char *)event.data + sizeof(unsigned int), handler,
		sizeof(event.data) - sizeof(unsigned int));
	event.data_len = sizeof(unsigned int) + strlen(handler) + 1;

	scada_trace_create_artifact(&event);
}
EXPORT_SYMBOL_GPL(scada_trace_irq);

static int __init scada_trace_init(void)
{
	pr_info("0xscada: trace hooks initialized (mask=0x%x)\n", trace_mask);
	return 0;
}

static void __exit scada_trace_exit(void)
{
	pr_info("0xscada: trace hooks unloaded\n");
}

module_init(scada_trace_init);
module_exit(scada_trace_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("0xSCADA Project");
MODULE_DESCRIPTION("0xSCADA SCADA-specific ftrace hooks");
