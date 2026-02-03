# SPDX-License-Identifier: GPL-2.0
#
# 0xSCADA Trace Capture Userspace Tools Makefile
#

CC ?= gcc
CFLAGS ?= -Wall -Wextra -O2 -g
LDFLAGS ?=

# Include paths
INCLUDES = -I../include

# Libraries
LIBS = -lpthread -lcrypto

# Targets
DAEMON = scada-traced
CLI = scada-trace

# Source files
DAEMON_SRCS = scada-traced.c artifact.c lfs.c
CLI_SRCS = scada-trace.c artifact.c lfs.c

# Object files
DAEMON_OBJS = $(DAEMON_SRCS:.c=.o)
CLI_OBJS = $(CLI_SRCS:.c=.o)

# Build directories
BINDIR ?= /usr/local/bin
SBINDIR ?= /usr/local/sbin
CONFDIR ?= /etc/scada-trace
VARDIR ?= /var/lib/scada-trace
SYSTEMD_DIR ?= /etc/systemd/system

.PHONY: all clean install uninstall

all: $(DAEMON) $(CLI)

$(DAEMON): scada-traced.o artifact.o lfs.o
	$(CC) $(LDFLAGS) -o $@ $^ $(LIBS)

$(CLI): scada-trace.o artifact.o lfs.o
	$(CC) $(LDFLAGS) -o $@ $^ $(LIBS)

%.o: %.c
	$(CC) $(CFLAGS) $(INCLUDES) -c -o $@ $<

# Generate stub files for artifact.c and lfs.c if they don't exist
artifact.c:
	@echo "/* Stub: artifact storage implementation */" > $@
	@echo "#include \"artifact.h\"" >> $@
	@echo "" >> $@
	@echo "artifact_storage_t *artifact_storage_create(const char *backend, const char *config) {" >> $@
	@echo "    (void)backend; (void)config;" >> $@
	@echo "    return NULL; /* TODO: Implement */" >> $@
	@echo "}" >> $@
	@echo "" >> $@
	@echo "void artifact_storage_destroy(artifact_storage_t *storage) {" >> $@
	@echo "    (void)storage;" >> $@
	@echo "}" >> $@
	@echo "" >> $@
	@echo "int artifact_create(artifact_storage_t *storage, const artifact_create_input_t *input, reality_artifact_t *out) {" >> $@
	@echo "    (void)storage; (void)input; (void)out;" >> $@
	@echo "    return -1; /* TODO: Implement */" >> $@
	@echo "}" >> $@
	@echo "" >> $@
	@echo "int artifact_link_commit(artifact_storage_t *storage, const char *hash, const char *commit) {" >> $@
	@echo "    (void)storage; (void)hash; (void)commit;" >> $@
	@echo "    return -1; /* TODO: Implement */" >> $@
	@echo "}" >> $@
	@echo "" >> $@
	@echo "void artifact_free(reality_artifact_t *artifact) {" >> $@
	@echo "    (void)artifact;" >> $@
	@echo "}" >> $@

lfs.c:
	@echo "/* Stub: LFS storage implementation */" > $@
	@echo "#include \"artifact.h\"" >> $@
	@echo "" >> $@
	@echo "/* LFS operations to be implemented */" >> $@

clean:
	rm -f $(DAEMON) $(CLI) *.o
	rm -f artifact.c lfs.c

# Install targets
install: all
	install -d $(DESTDIR)$(BINDIR)
	install -d $(DESTDIR)$(SBINDIR)
	install -d $(DESTDIR)$(CONFDIR)
	install -d $(DESTDIR)$(VARDIR)/artifacts
	install -m 755 $(CLI) $(DESTDIR)$(BINDIR)/
	install -m 755 $(DAEMON) $(DESTDIR)$(SBINDIR)/
	test -f $(DESTDIR)$(CONFDIR)/traced.conf || \
		install -m 644 traced.conf.example $(DESTDIR)$(CONFDIR)/traced.conf

uninstall:
	rm -f $(DESTDIR)$(BINDIR)/$(CLI)
	rm -f $(DESTDIR)$(SBINDIR)/$(DAEMON)

# Systemd service
install-service:
	install -m 644 scada-traced.service $(DESTDIR)$(SYSTEMD_DIR)/
	systemctl daemon-reload
	systemctl enable scada-traced

uninstall-service:
	systemctl disable scada-traced
	rm -f $(DESTDIR)$(SYSTEMD_DIR)/scada-traced.service
	systemctl daemon-reload

# Development helpers
run-daemon: $(DAEMON)
	sudo ./$(DAEMON) -f -v

test: all
	./$(CLI) stats
	./$(CLI) enable
	./$(CLI) capture -d 100
	./$(CLI) disable

.PHONY: install uninstall install-service uninstall-service run-daemon test
