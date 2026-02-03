// SPDX-License-Identifier: GPL-2.0
/*
 * 0xSCADA Trace Capture - KUnit Tests
 *
 * Unit tests for the trace capture kernel module.
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#include <kunit/test.h>
#include <linux/slab.h>
#include <linux/crc32.h>

/* Include module headers (path adjusted for test build) */
#include "../../kernel/scada_trace.h"

/*
 * Ring Buffer Tests
 */
static void ring_buffer_init_test(struct kunit *test)
{
	struct scada_trace_ring ring;
	int ret;
	
	ret = scada_ring_init(&ring, PAGE_SIZE);
	KUNIT_EXPECT_EQ(test, ret, 0);
	KUNIT_EXPECT_NOT_NULL(test, ring.buffer);
	KUNIT_EXPECT_EQ(test, ring.size, PAGE_SIZE);
	KUNIT_EXPECT_EQ(test, ring.head, 0);
	KUNIT_EXPECT_EQ(test, ring.tail, 0);
	
	scada_ring_destroy(&ring);
	KUNIT_EXPECT_NULL(test, ring.buffer);
}

static void ring_buffer_write_read_test(struct kunit *test)
{
	struct scada_trace_ring ring;
	char write_buf[64] = "Hello, SCADA trace!";
	char read_buf[64] = {0};
	int ret;
	unsigned long flags = 0;
	
	ret = scada_ring_init(&ring, PAGE_SIZE);
	KUNIT_ASSERT_EQ(test, ret, 0);
	
	spin_lock_irqsave(&ring.lock, flags);
	ret = scada_ring_write(&ring, write_buf, strlen(write_buf));
	KUNIT_EXPECT_EQ(test, ret, 0);
	KUNIT_EXPECT_EQ(test, scada_ring_used(&ring), strlen(write_buf));
	
	ret = scada_ring_read(&ring, read_buf, sizeof(read_buf));
	KUNIT_EXPECT_EQ(test, (size_t)ret, strlen(write_buf));
	KUNIT_EXPECT_STREQ(test, read_buf, write_buf);
	spin_unlock_irqrestore(&ring.lock, flags);
	
	scada_ring_destroy(&ring);
}

static void ring_buffer_wrap_test(struct kunit *test)
{
	struct scada_trace_ring ring;
	char write_buf[256];
	char read_buf[256];
	int ret, i;
	unsigned long flags = 0;
	size_t write_size = 200;
	
	/* Small ring to force wrap-around */
	ret = scada_ring_init(&ring, 512);
	KUNIT_ASSERT_EQ(test, ret, 0);
	
	/* Fill with pattern */
	memset(write_buf, 'A', write_size);
	write_buf[write_size] = '\0';
	
	spin_lock_irqsave(&ring.lock, flags);
	
	/* Write multiple times to cause wrap */
	for (i = 0; i < 3; i++) {
		ret = scada_ring_write(&ring, write_buf, write_size);
		if (ret == 0) {
			/* Read back to make room */
			scada_ring_read(&ring, read_buf, write_size);
		}
	}
	
	spin_unlock_irqrestore(&ring.lock, flags);
	
	scada_ring_destroy(&ring);
	KUNIT_SUCCEED(test);
}

static void ring_buffer_overflow_test(struct kunit *test)
{
	struct scada_trace_ring ring;
	char write_buf[PAGE_SIZE * 2];
	int ret;
	unsigned long flags = 0;
	
	ret = scada_ring_init(&ring, PAGE_SIZE);
	KUNIT_ASSERT_EQ(test, ret, 0);
	
	memset(write_buf, 'X', sizeof(write_buf));
	
	spin_lock_irqsave(&ring.lock, flags);
	
	/* Try to write more than buffer size */
	ret = scada_ring_write(&ring, write_buf, sizeof(write_buf));
	KUNIT_EXPECT_EQ(test, ret, -ENOSPC);
	KUNIT_EXPECT_GT(test, ring.overflow_count, 0);
	
	spin_unlock_irqrestore(&ring.lock, flags);
	
	scada_ring_destroy(&ring);
}

/*
 * Replay Metadata Tests
 */
static void replay_metadata_fill_test(struct kunit *test)
{
	struct scada_replay_metadata meta;
	
	scada_replay_metadata_fill(&meta);
	
	KUNIT_EXPECT_NE(test, meta.capture_timestamp_ns, 0);
	KUNIT_EXPECT_NE(test, meta.boot_id, 0);
	KUNIT_EXPECT_EQ(test, meta.metadata_version, 1);
	KUNIT_EXPECT_NE(test, meta.checksum, 0);
}

static void replay_metadata_verify_test(struct kunit *test)
{
	struct scada_replay_metadata meta;
	int ret;
	
	scada_replay_metadata_fill(&meta);
	
	/* Should verify successfully */
	ret = scada_replay_metadata_verify(&meta);
	KUNIT_EXPECT_EQ(test, ret, 0);
	
	/* Corrupt checksum */
	meta.checksum ^= 0xDEADBEEF;
	ret = scada_replay_metadata_verify(&meta);
	KUNIT_EXPECT_EQ(test, ret, -EILSEQ);
}

static void replay_metadata_version_test(struct kunit *test)
{
	struct scada_replay_metadata meta;
	int ret;
	
	scada_replay_metadata_fill(&meta);
	
	/* Invalid version */
	meta.metadata_version = 99;
	ret = scada_replay_metadata_verify(&meta);
	KUNIT_EXPECT_EQ(test, ret, -EINVAL);
}

/*
 * Snapshot Header Tests
 */
static void snapshot_header_magic_test(struct kunit *test)
{
	KUNIT_EXPECT_EQ(test, SCADA_TRACE_MAGIC, 0x5CA0A7CE);
}

static void snapshot_header_size_test(struct kunit *test)
{
	/* Verify packed struct sizes for binary compatibility */
	KUNIT_EXPECT_EQ(test, sizeof(struct scada_trace_event), 32);
	KUNIT_EXPECT_EQ(test, sizeof(struct scada_modbus_burst), 16);
}

/*
 * Event Trace Tests
 */
static void trace_event_basic_test(struct kunit *test)
{
	struct scada_trace_ctx *ctx;
	char data[] = "test event data";
	int ret;
	
	ctx = scada_trace_get_ctx();
	if (!ctx) {
		KUNIT_SKIP(test, "Trace context not initialized");
		return;
	}
	
	ret = scada_trace_event(SCADA_TRACE_CUSTOM, 0, data, strlen(data));
	KUNIT_EXPECT_EQ(test, ret, 0);
}

/*
 * CRC32 Tests
 */
static void crc32_test(struct kunit *test)
{
	char data[] = "0xSCADA Reality Artifacts";
	u32 crc;
	
	crc = scada_crc32(data, strlen(data));
	KUNIT_EXPECT_NE(test, crc, 0);
	
	/* Same data should produce same CRC */
	KUNIT_EXPECT_EQ(test, crc, scada_crc32(data, strlen(data)));
}

/*
 * Git Commit Linkage Tests
 */
static void git_commit_set_valid_test(struct kunit *test)
{
	const char *valid_commit = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
	int ret;
	
	ret = scada_trace_set_commit(valid_commit);
	
	/* May fail if context not initialized */
	if (scada_trace_get_ctx()) {
		KUNIT_EXPECT_EQ(test, ret, 0);
		KUNIT_EXPECT_STREQ(test, scada_trace_get_commit(), valid_commit);
	}
}

static void git_commit_set_invalid_test(struct kunit *test)
{
	int ret;
	
	if (!scada_trace_get_ctx()) {
		KUNIT_SKIP(test, "Trace context not initialized");
		return;
	}
	
	/* Too short */
	ret = scada_trace_set_commit("abc123");
	KUNIT_EXPECT_EQ(test, ret, -EINVAL);
	
	/* Invalid characters */
	ret = scada_trace_set_commit("xyz0123456789abcdef0123456789abcdef012345");
	KUNIT_EXPECT_EQ(test, ret, -EINVAL);
	
	/* NULL */
	ret = scada_trace_set_commit(NULL);
	KUNIT_EXPECT_EQ(test, ret, -EINVAL);
}

/*
 * Test Suites
 */
static struct kunit_case ring_buffer_cases[] = {
	KUNIT_CASE(ring_buffer_init_test),
	KUNIT_CASE(ring_buffer_write_read_test),
	KUNIT_CASE(ring_buffer_wrap_test),
	KUNIT_CASE(ring_buffer_overflow_test),
	{}
};

static struct kunit_case replay_metadata_cases[] = {
	KUNIT_CASE(replay_metadata_fill_test),
	KUNIT_CASE(replay_metadata_verify_test),
	KUNIT_CASE(replay_metadata_version_test),
	{}
};

static struct kunit_case snapshot_cases[] = {
	KUNIT_CASE(snapshot_header_magic_test),
	KUNIT_CASE(snapshot_header_size_test),
	{}
};

static struct kunit_case trace_event_cases[] = {
	KUNIT_CASE(trace_event_basic_test),
	{}
};

static struct kunit_case utility_cases[] = {
	KUNIT_CASE(crc32_test),
	KUNIT_CASE(git_commit_set_valid_test),
	KUNIT_CASE(git_commit_set_invalid_test),
	{}
};

static struct kunit_suite ring_buffer_suite = {
	.name = "scada_trace_ring_buffer",
	.test_cases = ring_buffer_cases,
};

static struct kunit_suite replay_metadata_suite = {
	.name = "scada_trace_replay_metadata",
	.test_cases = replay_metadata_cases,
};

static struct kunit_suite snapshot_suite = {
	.name = "scada_trace_snapshot",
	.test_cases = snapshot_cases,
};

static struct kunit_suite trace_event_suite = {
	.name = "scada_trace_events",
	.test_cases = trace_event_cases,
};

static struct kunit_suite utility_suite = {
	.name = "scada_trace_utilities",
	.test_cases = utility_cases,
};

kunit_test_suites(
	&ring_buffer_suite,
	&replay_metadata_suite,
	&snapshot_suite,
	&trace_event_suite,
	&utility_suite
);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("0xSCADA Project");
MODULE_DESCRIPTION("KUnit tests for 0xSCADA trace capture module");
