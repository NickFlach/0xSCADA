# SPDX-License-Identifier: GPL-2.0
#
# 0xSCADA Trace Capture eBPF Programs Makefile
#

CLANG ?= clang
LLVM_STRIP ?= llvm-strip
BPFTOOL ?= bpftool
LIBBPF_DIR ?= /usr/include

# Architecture detection
ARCH := $(shell uname -m | sed 's/x86_64/x86/' | sed 's/aarch64/arm64/')

# Clang flags for BPF
BPF_CFLAGS := -g -O2 -target bpf
BPF_CFLAGS += -D__TARGET_ARCH_$(ARCH)
BPF_CFLAGS += -I$(LIBBPF_DIR)
BPF_CFLAGS += -Wall -Wextra

# eBPF programs
BPF_PROGS := latency.bpf.o io_trace.bpf.o modbus.bpf.o

# Output directory
OUTPUT := .output

.PHONY: all clean install vmlinux

all: $(BPF_PROGS)

# Generate vmlinux.h from running kernel
vmlinux.h:
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@

# Build eBPF objects
%.bpf.o: %.bpf.c vmlinux.h
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@
	$(LLVM_STRIP) -g $@

# Generate skeleton headers (for userspace loader)
%.skel.h: %.bpf.o
	$(BPFTOOL) gen skeleton $< > $@

# Install to standard location
install: all
	install -d /usr/share/scada-trace/bpf
	install -m 644 *.bpf.o /usr/share/scada-trace/bpf/

clean:
	rm -f *.bpf.o *.skel.h vmlinux.h

# Stub files for programs not yet implemented
io_trace.bpf.c:
	@echo "// SPDX-License-Identifier: GPL-2.0" > $@
	@echo "// Stub: I/O trace eBPF program" >> $@
	@echo '#include "vmlinux.h"' >> $@
	@echo '#include <bpf/bpf_helpers.h>' >> $@
	@echo 'char LICENSE[] SEC("license") = "GPL";' >> $@

modbus.bpf.c:
	@echo "// SPDX-License-Identifier: GPL-2.0" > $@
	@echo "// Stub: Modbus protocol eBPF program" >> $@
	@echo '#include "vmlinux.h"' >> $@
	@echo '#include <bpf/bpf_helpers.h>' >> $@
	@echo 'char LICENSE[] SEC("license") = "GPL";' >> $@

# Debug: show BTF info
btf-info:
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux | head -100

# Verify object
verify: $(BPF_PROGS)
	@for prog in $(BPF_PROGS); do \
		echo "Verifying $$prog..."; \
		$(BPFTOOL) prog load $$prog /sys/fs/bpf/test_$$prog && \
		$(BPFTOOL) prog show pinned /sys/fs/bpf/test_$$prog && \
		rm /sys/fs/bpf/test_$$prog; \
	done

.PHONY: install clean btf-info verify
