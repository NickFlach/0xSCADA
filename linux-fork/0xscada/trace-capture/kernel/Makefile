# SPDX-License-Identifier: GPL-2.0
#
# 0xSCADA Trace Capture Kernel Module Makefile
#

obj-m := scada_trace.o
scada_trace-objs := scada_trace_main.o ring_buffer.o snapshot.o

# Kernel build directory
KDIR ?= /lib/modules/$(shell uname -r)/build

# Module name
MODULE_NAME := scada_trace

# Build flags
ccflags-y := -DDEBUG -O2

# Default target: build out-of-tree
all: modules

modules:
	$(MAKE) -C $(KDIR) M=$(CURDIR) modules

modules_install:
	$(MAKE) -C $(KDIR) M=$(CURDIR) modules_install

clean:
	$(MAKE) -C $(KDIR) M=$(CURDIR) clean
	rm -f Module.symvers modules.order

# In-tree build support (when integrated with main kernel)
# Add to linux-fork/0xscada/Kconfig:
#   config SCADA_TRACE
#     tristate "0xSCADA trace capture support"
#     depends on DEBUG_FS
#     default m
#     help
#       This module provides trace capture for industrial control systems.

# Install to /lib/modules/$(uname -r)/extra/
install: modules
	install -d /lib/modules/$(shell uname -r)/extra/
	install -m 644 scada_trace.ko /lib/modules/$(shell uname -r)/extra/
	depmod -a

uninstall:
	rm -f /lib/modules/$(shell uname -r)/extra/scada_trace.ko
	depmod -a

# Load/unload helpers
load:
	insmod ./scada_trace.ko ring_size=4194304

unload:
	rmmod scada_trace

reload: unload load

# Show module info
info:
	modinfo ./scada_trace.ko

# Test build
test: modules
	@echo "Build successful"
	@modinfo ./scada_trace.ko | head -10

.PHONY: all modules modules_install clean install uninstall load unload reload info test
