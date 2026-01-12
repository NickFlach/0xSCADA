// SPDX-License-Identifier: GPL-2.0
/*
 * 0xSCADA Custom KUnit Tests
 *
 * Tests for kernel functionality critical to industrial SCADA systems.
 */

#include <kunit/test.h>
#include <linux/crypto.h>
#include <crypto/hash.h>
#include <linux/scatterlist.h>
#include <linux/timekeeping.h>
#include <linux/slab.h>

/* ============================================================================
 * Crypto Hash Tests - Essential for blockchain event anchoring
 * ============================================================================ */

static void scada_sha256_basic_test(struct kunit *test)
{
	struct crypto_shash *tfm;
	struct shash_desc *desc;
	u8 digest[32];
	int ret;

	/* Known SHA256 test vector: SHA256("test") */
	const u8 expected[] = {
		0x9f, 0x86, 0xd0, 0x81, 0x88, 0x4c, 0x7d, 0x65,
		0x9a, 0x2f, 0xea, 0xa0, 0xc5, 0x5a, 0xd0, 0x15,
		0xa3, 0xbf, 0x4f, 0x1b, 0x2b, 0x0b, 0x82, 0x2c,
		0xd1, 0x5d, 0x6c, 0x15, 0xb0, 0xf0, 0x0a, 0x08
	};

	tfm = crypto_alloc_shash("sha256", 0, 0);
	KUNIT_ASSERT_FALSE_MSG(test, IS_ERR(tfm),
		"Failed to allocate sha256 transform");

	desc = kzalloc(sizeof(*desc) + crypto_shash_descsize(tfm), GFP_KERNEL);
	KUNIT_ASSERT_NOT_NULL(test, desc);

	desc->tfm = tfm;

	ret = crypto_shash_init(desc);
	KUNIT_EXPECT_EQ(test, ret, 0);

	ret = crypto_shash_update(desc, "test", 4);
	KUNIT_EXPECT_EQ(test, ret, 0);

	ret = crypto_shash_final(desc, digest);
	KUNIT_EXPECT_EQ(test, ret, 0);

	KUNIT_EXPECT_MEMEQ(test, digest, expected, 32);

	kfree(desc);
	crypto_free_shash(tfm);
}

static void scada_sha256_empty_test(struct kunit *test)
{
	struct crypto_shash *tfm;
	struct shash_desc *desc;
	u8 digest[32];
	int ret;

	/* SHA256 of empty string */
	const u8 expected[] = {
		0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14,
		0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9, 0x24,
		0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c,
		0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52, 0xb8, 0x55
	};

	tfm = crypto_alloc_shash("sha256", 0, 0);
	KUNIT_ASSERT_FALSE(test, IS_ERR(tfm));

	desc = kzalloc(sizeof(*desc) + crypto_shash_descsize(tfm), GFP_KERNEL);
	KUNIT_ASSERT_NOT_NULL(test, desc);

	desc->tfm = tfm;

	ret = crypto_shash_init(desc);
	KUNIT_EXPECT_EQ(test, ret, 0);

	ret = crypto_shash_final(desc, digest);
	KUNIT_EXPECT_EQ(test, ret, 0);

	KUNIT_EXPECT_MEMEQ(test, digest, expected, 32);

	kfree(desc);
	crypto_free_shash(tfm);
}

/* ============================================================================
 * Timer Resolution Tests - Critical for real-time industrial control
 * ============================================================================ */

static void scada_timer_resolution_test(struct kunit *test)
{
	ktime_t start, end, delta;
	s64 ns;

	start = ktime_get();
	/* Minimal work */
	end = ktime_get();

	delta = ktime_sub(end, start);
	ns = ktime_to_ns(delta);

	/* Timer should have nanosecond precision */
	KUNIT_EXPECT_GE(test, ns, 0);

	/* Should be less than 1ms for just getting time twice */
	KUNIT_EXPECT_LT(test, ns, 1000000);
}

static void scada_monotonic_clock_test(struct kunit *test)
{
	ktime_t t1, t2, t3;

	t1 = ktime_get();
	t2 = ktime_get();
	t3 = ktime_get();

	/* Monotonic clock must always increase */
	KUNIT_EXPECT_LE(test, ktime_to_ns(t1), ktime_to_ns(t2));
	KUNIT_EXPECT_LE(test, ktime_to_ns(t2), ktime_to_ns(t3));
}

/* ============================================================================
 * Memory Allocation Tests - Gateway reliability
 * ============================================================================ */

static void scada_kmalloc_basic_test(struct kunit *test)
{
	void *ptr;

	ptr = kmalloc(1024, GFP_KERNEL);
	KUNIT_ASSERT_NOT_NULL(test, ptr);

	/* Memory should be usable */
	memset(ptr, 0xAB, 1024);

	kfree(ptr);
}

static void scada_kzalloc_zeroed_test(struct kunit *test)
{
	u8 *ptr;
	int i;

	ptr = kzalloc(256, GFP_KERNEL);
	KUNIT_ASSERT_NOT_NULL(test, ptr);

	/* All bytes should be zero */
	for (i = 0; i < 256; i++) {
		KUNIT_EXPECT_EQ(test, ptr[i], 0);
	}

	kfree(ptr);
}

/* ============================================================================
 * Test Suite Registration
 * ============================================================================ */

static struct kunit_case scada_crypto_test_cases[] = {
	KUNIT_CASE(scada_sha256_basic_test),
	KUNIT_CASE(scada_sha256_empty_test),
	{}
};

static struct kunit_case scada_timer_test_cases[] = {
	KUNIT_CASE(scada_timer_resolution_test),
	KUNIT_CASE(scada_monotonic_clock_test),
	{}
};

static struct kunit_case scada_memory_test_cases[] = {
	KUNIT_CASE(scada_kmalloc_basic_test),
	KUNIT_CASE(scada_kzalloc_zeroed_test),
	{}
};

static struct kunit_suite scada_crypto_test_suite = {
	.name = "scada_crypto",
	.test_cases = scada_crypto_test_cases,
};

static struct kunit_suite scada_timer_test_suite = {
	.name = "scada_timer",
	.test_cases = scada_timer_test_cases,
};

static struct kunit_suite scada_memory_test_suite = {
	.name = "scada_memory",
	.test_cases = scada_memory_test_cases,
};

kunit_test_suites(&scada_crypto_test_suite,
		  &scada_timer_test_suite,
		  &scada_memory_test_suite);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("0xSCADA Team");
MODULE_DESCRIPTION("KUnit tests for 0xSCADA kernel functionality");
