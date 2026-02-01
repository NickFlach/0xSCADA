# SPDX-License-Identifier: GPL-2.0
#
# Makefile for 0xSCADA Hello World Kernel Module
#
# Usage:
#   # Build against running kernel
#   make
#
#   # Build against specific kernel
#   make KDIR=/path/to/linux-fork
#
#   # Build against linux-fork (relative path)
#   make KDIR=../../../..
#
#   # Install module
#   sudo make install
#
#   # Clean build artifacts
#   make clean
#

# Module name
MODULE_NAME := hello_scada

# Kernel build directory (default to running kernel)
KDIR ?= /lib/modules/$(shell uname -r)/build

# Current directory (where module sources are)
PWD := $(shell pwd)

# Object file(s) that make up the module
obj-m := $(MODULE_NAME).o

# Default target: build the module
all:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

# Install the module
install:
	$(MAKE) -C $(KDIR) M=$(PWD) modules_install

# Clean build artifacts
clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean
	rm -f Module.symvers modules.order

# Load the module
load: all
	sudo insmod $(MODULE_NAME).ko

# Unload the module
unload:
	sudo rmmod $(MODULE_NAME)

# Reload the module (unload then load)
reload: unload load

# Show kernel messages related to the module
dmesg:
	dmesg | grep -i "0xscada" | tail -30

# Test the module (load, show messages, unload)
test: load
	@echo "=== Module loaded. Kernel messages: ==="
	@dmesg | grep -i "0xscada" | tail -20
	@echo ""
	@echo "Press Enter to unload module..."
	@read
	$(MAKE) unload
	@echo "=== Module unloaded. Final messages: ==="
	@dmesg | grep -i "0xscada" | tail -10

# Show module info
info:
	@modinfo $(MODULE_NAME).ko 2>/dev/null || echo "Module not built yet"

# Phony targets
.PHONY: all install clean load unload reload dmesg test info
