# SPDX-License-Identifier: GPL-2.0
#
# KUnit tests for scada_trace module
#

obj-$(CONFIG_SCADA_TRACE_TEST) += trace_capture_test.o

# For out-of-tree build
KDIR ?= /lib/modules/$(shell uname -r)/build

test:
	$(MAKE) -C $(KDIR) M=$(CURDIR) modules
	./../../scripts/run_kunit.sh

clean:
	$(MAKE) -C $(KDIR) M=$(CURDIR) clean
