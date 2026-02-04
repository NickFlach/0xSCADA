# SPDX-License-Identifier: GPL-2.0-only
#
# Makefile for 0xSCADA Industrial Reality Capture
#

obj-$(CONFIG_SCADA_0X_CORE)	+= core/
obj-$(CONFIG_SCADA_0X_TRACE)	+= trace/
obj-$(CONFIG_SCADA_0X_NET)	+= net/

# Module metadata
0xscada-objs := core/artifact.o

ccflags-$(CONFIG_SCADA_0X_DEBUG) += -DDEBUG
