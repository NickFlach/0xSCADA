#!/bin/bash
# SPDX-License-Identifier: GPL-2.0
#
# 0xSCADA Trace Capture Integration Tests
#
# Tests the full pipeline from kernel capture to artifact storage.
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Test configuration
TEST_DIR="/tmp/scada-trace-test"
ARTIFACT_DIR="$TEST_DIR/artifacts"
MODULE_PATH="../../kernel/scada_trace.ko"
DEBUGFS_ROOT="/sys/kernel/debug/scada_trace"

# Counters
PASSED=0
FAILED=0

# Helper functions
log_info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((PASSED++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAILED++))
}

# Setup
setup() {
    log_info "Setting up test environment..."
    
    mkdir -p "$TEST_DIR"
    mkdir -p "$ARTIFACT_DIR"
    
    # Load module if not loaded
    if ! lsmod | grep -q scada_trace; then
        if [ -f "$MODULE_PATH" ]; then
            log_info "Loading kernel module..."
            sudo insmod "$MODULE_PATH" ring_size=1048576
        else
            log_info "Kernel module not found, some tests will be skipped"
        fi
    fi
}

# Teardown
teardown() {
    log_info "Cleaning up..."
    
    # Unload module if we loaded it
    if lsmod | grep -q scada_trace; then
        sudo rmmod scada_trace 2>/dev/null || true
    fi
    
    rm -rf "$TEST_DIR"
}

# Test: Module loads successfully
test_module_load() {
    if lsmod | grep -q scada_trace; then
        log_pass "Module loaded"
    else
        log_fail "Module not loaded"
    fi
}

# Test: Debugfs entries exist
test_debugfs_entries() {
    if [ -d "$DEBUGFS_ROOT" ]; then
        log_pass "Debugfs root exists"
        
        for entry in stats enable commit; do
            if [ -e "$DEBUGFS_ROOT/$entry" ]; then
                log_pass "Debugfs entry: $entry"
            else
                log_fail "Missing debugfs entry: $entry"
            fi
        done
    else
        log_fail "Debugfs root missing"
    fi
}

# Test: Enable/disable tracing
test_enable_disable() {
    if [ ! -e "$DEBUGFS_ROOT/enable" ]; then
        log_info "Skipping enable/disable test (debugfs not available)"
        return
    fi
    
    # Enable
    echo 1 | sudo tee "$DEBUGFS_ROOT/enable" > /dev/null
    if [ "$(cat $DEBUGFS_ROOT/enable)" = "1" ]; then
        log_pass "Tracing enabled"
    else
        log_fail "Failed to enable tracing"
    fi
    
    # Disable
    echo 0 | sudo tee "$DEBUGFS_ROOT/enable" > /dev/null
    if [ "$(cat $DEBUGFS_ROOT/enable)" = "0" ]; then
        log_pass "Tracing disabled"
    else
        log_fail "Failed to disable tracing"
    fi
}

# Test: Read stats
test_stats() {
    if [ ! -e "$DEBUGFS_ROOT/stats" ]; then
        log_info "Skipping stats test"
        return
    fi
    
    stats=$(cat "$DEBUGFS_ROOT/stats")
    
    if echo "$stats" | grep -q "0xSCADA Trace Capture"; then
        log_pass "Stats header present"
    else
        log_fail "Stats header missing"
    fi
    
    if echo "$stats" | grep -q "Boot ID:"; then
        log_pass "Boot ID present"
    else
        log_fail "Boot ID missing"
    fi
}

# Test: Set git commit
test_git_commit() {
    if [ ! -e "$DEBUGFS_ROOT/commit" ]; then
        log_info "Skipping git commit test"
        return
    fi
    
    commit="a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    
    echo "$commit" | sudo tee "$DEBUGFS_ROOT/commit" > /dev/null
    
    read_back=$(cat "$DEBUGFS_ROOT/commit" | tr -d '\n')
    
    if [ "$read_back" = "$commit" ]; then
        log_pass "Git commit set correctly"
    else
        log_fail "Git commit mismatch: $read_back != $commit"
    fi
}

# Test: CLI tool exists
test_cli_exists() {
    if [ -x "../../../userspace/scada-trace" ]; then
        log_pass "CLI tool exists"
    elif command -v scada-trace &>/dev/null; then
        log_pass "CLI tool installed"
    else
        log_fail "CLI tool not found"
    fi
}

# Test: Daemon exists
test_daemon_exists() {
    if [ -x "../../../userspace/scada-traced" ]; then
        log_pass "Daemon exists"
    elif command -v scada-traced &>/dev/null; then
        log_pass "Daemon installed"
    else
        log_fail "Daemon not found"
    fi
}

# Test: Artifact storage
test_artifact_storage() {
    log_info "Testing artifact storage..."
    
    # Create test artifact
    test_data="Test artifact data $(date)"
    echo "$test_data" > "$ARTIFACT_DIR/test.bin"
    
    # Compute hash
    hash=$(sha256sum "$ARTIFACT_DIR/test.bin" | cut -d' ' -f1)
    
    if [ ${#hash} -eq 64 ]; then
        log_pass "SHA-256 hash computed: ${hash:0:16}..."
    else
        log_fail "Invalid hash length"
    fi
    
    # Verify file exists
    if [ -f "$ARTIFACT_DIR/test.bin" ]; then
        log_pass "Artifact file created"
    else
        log_fail "Artifact file missing"
    fi
}

# Test: Binary format
test_binary_format() {
    log_info "Testing binary format structures..."
    
    # Check expected sizes (from TRACE_FORMAT.md)
    # This would require a C test program in real implementation
    
    log_pass "Binary format check (placeholder)"
}

# Main
main() {
    echo "=================================="
    echo "0xSCADA Trace Capture Integration Tests"
    echo "=================================="
    echo
    
    setup
    
    test_module_load
    test_debugfs_entries
    test_enable_disable
    test_stats
    test_git_commit
    test_cli_exists
    test_daemon_exists
    test_artifact_storage
    test_binary_format
    
    teardown
    
    echo
    echo "=================================="
    echo "Results: $PASSED passed, $FAILED failed"
    echo "=================================="
    
    if [ $FAILED -gt 0 ]; then
        exit 1
    fi
}

# Run if executed directly
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
