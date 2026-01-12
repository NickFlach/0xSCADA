#!/bin/bash
# 0xSCADA Linux Kernel Test Runner

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL_DIR="$(dirname "$SCRIPT_DIR")/.."

echo "==================================================="
echo "  0xSCADA Linux Kernel Test Suite"
echo "==================================================="
echo ""

TEST_TYPE="${1:-kunit}"

case "$TEST_TYPE" in
    kunit)
        echo "Running KUnit tests..."
        cd "$KERNEL_DIR"
        ./tools/testing/kunit/kunit.py run \
            --build_dir=.kunit \
            --alltests \
            --json > 0xscada/tests/kunit-results.json 2>&1 || true

        echo ""
        ./tools/testing/kunit/kunit.py run --build_dir=.kunit
        ;;

    crypto)
        echo "Running crypto subsystem tests..."
        cd "$KERNEL_DIR"
        ./tools/testing/kunit/kunit.py run \
            --build_dir=.kunit \
            --kunitconfig=crypto/.kunitconfig
        ;;

    selftests)
        echo "Running kernel selftests..."
        cd "$KERNEL_DIR"
        make -C tools/testing/selftests TARGETS="crypto net seccomp" run_tests
        ;;

    quick)
        echo "Running quick validation tests..."
        cd "$KERNEL_DIR"
        ./tools/testing/kunit/kunit.py run \
            --build_dir=.kunit \
            --kunitconfig=lib/kunit/.kunitconfig
        ;;

    all)
        echo "Running all test suites..."
        $0 kunit
        $0 selftests
        ;;

    *)
        echo "Unknown test type: $TEST_TYPE"
        echo "Usage: $0 [kunit|crypto|selftests|quick|all]"
        exit 1
        ;;
esac

echo ""
echo "==================================================="
echo "  Tests complete!"
echo "==================================================="
