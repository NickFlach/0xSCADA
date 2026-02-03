/* SPDX-License-Identifier: GPL-2.0 */
/*
 * 0xSCADA Trace Capture CLI Tool
 *
 * Command-line interface for:
 * - Triggering trace captures
 * - Viewing artifacts
 * - Replaying traces
 * - Managing git linkage
 *
 * Copyright (C) 2026 0xSCADA Project
 */

#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <getopt.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <openssl/sha.h>

#include "../include/scada_trace_api.h"
#include "../include/replay_metadata.h"
#include "artifact.h"

#define PROG_NAME	"scada-trace"
#define VERSION		"0.1.0"

/*
 * Global options
 */
static struct {
	bool verbose;
	bool json_output;
	char artifact_dir[PATH_MAX];
} opts = {
	.verbose = false,
	.json_output = false,
};

/*
 * Command handlers
 */
typedef int (*cmd_handler_t)(int argc, char **argv);

struct command {
	const char *name;
	const char *desc;
	cmd_handler_t handler;
};

/*
 * Helpers
 */
static void print_error(const char *msg)
{
	fprintf(stderr, "Error: %s\n", msg);
}

static void print_usage_header(void)
{
	printf("%s v%s - 0xSCADA Trace Capture Tool\n\n", PROG_NAME, VERSION);
}

/*
 * Capture command
 */
static void capture_usage(void)
{
	printf("Usage: %s capture [options]\n\n", PROG_NAME);
	printf("Options:\n");
	printf("  -t, --type TYPE    Trace type (ftrace, ebpf, sensor, firmware)\n");
	printf("  -d, --duration MS  Capture duration in milliseconds\n");
	printf("  -o, --output FILE  Output file (default: auto-generated)\n");
	printf("  -c, --commit HASH  Link to git commit\n");
	printf("  --device ID        Device identifier\n");
	printf("  --site ID          Site identifier\n");
	printf("  -h, --help         Show this help\n");
}

static int cmd_capture(int argc, char **argv)
{
	static struct option long_options[] = {
		{"type",     required_argument, 0, 't'},
		{"duration", required_argument, 0, 'd'},
		{"output",   required_argument, 0, 'o'},
		{"commit",   required_argument, 0, 'c'},
		{"device",   required_argument, 0, 'D'},
		{"site",     required_argument, 0, 'S'},
		{"help",     no_argument,       0, 'h'},
		{0, 0, 0, 0}
	};
	int opt;
	const char *type = "ftrace";
	uint32_t duration_ms = 1000;
	const char *output = NULL;
	const char *commit = NULL;
	const char *device = "local";
	const char *site = "default";
	
	optind = 0;  /* Reset getopt */
	while ((opt = getopt_long(argc, argv, "t:d:o:c:D:S:h",
				  long_options, NULL)) != -1) {
		switch (opt) {
		case 't':
			type = optarg;
			break;
		case 'd':
			duration_ms = atoi(optarg);
			break;
		case 'o':
			output = optarg;
			break;
		case 'c':
			commit = optarg;
			break;
		case 'D':
			device = optarg;
			break;
		case 'S':
			site = optarg;
			break;
		case 'h':
		default:
			capture_usage();
			return opt == 'h' ? 0 : 1;
		}
	}
	
	printf("Capturing %s traces for %u ms...\n", type, duration_ms);
	
	/* Enable tracing */
	int fd = open(SCADA_TRACE_DEBUGFS_ENABLE, O_WRONLY);
	if (fd < 0) {
		print_error("Failed to enable tracing (is kernel module loaded?)");
		return 1;
	}
	write(fd, "1", 1);
	close(fd);
	
	/* Wait for capture duration */
	usleep(duration_ms * 1000);
	
	/* Disable tracing */
	fd = open(SCADA_TRACE_DEBUGFS_ENABLE, O_WRONLY);
	if (fd >= 0) {
		write(fd, "0", 1);
		close(fd);
	}
	
	/* Read captured data */
	printf("Capture complete.\n");
	
	/* TODO: Read snapshot data and store as artifact */
	
	if (commit) {
		printf("Linked to commit: %s\n", commit);
	}
	
	return 0;
}

/*
 * Show command
 */
static void show_usage(void)
{
	printf("Usage: %s show <content-hash>\n\n", PROG_NAME);
	printf("Show artifact details.\n");
}

static int cmd_show(int argc, char **argv)
{
	if (argc < 2) {
		show_usage();
		return 1;
	}
	
	const char *hash = argv[1];
	
	if (strlen(hash) != 64) {
		print_error("Invalid content hash (expected 64 hex characters)");
		return 1;
	}
	
	/* TODO: Look up and display artifact */
	printf("Artifact: %s\n", hash);
	printf("(Artifact lookup not yet implemented)\n");
	
	return 0;
}

/*
 * Replay command
 */
static void replay_usage(void)
{
	printf("Usage: %s replay [options] <content-hash>\n\n", PROG_NAME);
	printf("Options:\n");
	printf("  --verify       Verify replay against original\n");
	printf("  --timing       Preserve original timing\n");
	printf("  --speed RATE   Replay speed (0.5, 1.0, 2.0, etc.)\n");
	printf("  -o, --output   Output file for replay log\n");
	printf("  -h, --help     Show this help\n");
}

static int cmd_replay(int argc, char **argv)
{
	static struct option long_options[] = {
		{"verify", no_argument,       0, 'V'},
		{"timing", no_argument,       0, 'T'},
		{"speed",  required_argument, 0, 's'},
		{"output", required_argument, 0, 'o'},
		{"help",   no_argument,       0, 'h'},
		{0, 0, 0, 0}
	};
	int opt;
	bool verify = false;
	bool timing = false;
	float speed = 1.0f;
	const char *output = NULL;
	
	optind = 0;
	while ((opt = getopt_long(argc, argv, "VTs:o:h",
				  long_options, NULL)) != -1) {
		switch (opt) {
		case 'V':
			verify = true;
			break;
		case 'T':
			timing = true;
			break;
		case 's':
			speed = atof(optarg);
			break;
		case 'o':
			output = optarg;
			break;
		case 'h':
		default:
			replay_usage();
			return opt == 'h' ? 0 : 1;
		}
	}
	
	if (optind >= argc) {
		print_error("Missing content hash");
		replay_usage();
		return 1;
	}
	
	const char *hash = argv[optind];
	
	printf("Replaying artifact: %s\n", hash);
	printf("Speed: %.1fx, Verify: %s, Timing: %s\n",
	       speed, verify ? "yes" : "no", timing ? "yes" : "no");
	
	/* TODO: Implement replay logic */
	printf("(Replay not yet implemented)\n");
	
	return 0;
}

/*
 * Diff command
 */
static void diff_usage(void)
{
	printf("Usage: %s diff <hash1> <hash2>\n\n", PROG_NAME);
	printf("Compare two artifact captures.\n");
}

static int cmd_diff(int argc, char **argv)
{
	if (argc < 3) {
		diff_usage();
		return 1;
	}
	
	const char *hash1 = argv[1];
	const char *hash2 = argv[2];
	
	printf("Comparing:\n");
	printf("  A: %s\n", hash1);
	printf("  B: %s\n", hash2);
	
	/* TODO: Implement diff logic */
	printf("(Diff not yet implemented)\n");
	
	return 0;
}

/*
 * Link command
 */
static void link_usage(void)
{
	printf("Usage: %s link <content-hash> --commit <git-hash>\n\n", PROG_NAME);
	printf("Link an artifact to a git commit.\n");
}

static int cmd_link(int argc, char **argv)
{
	static struct option long_options[] = {
		{"commit", required_argument, 0, 'c'},
		{"help",   no_argument,       0, 'h'},
		{0, 0, 0, 0}
	};
	int opt;
	const char *commit = NULL;
	
	optind = 0;
	while ((opt = getopt_long(argc, argv, "c:h",
				  long_options, NULL)) != -1) {
		switch (opt) {
		case 'c':
			commit = optarg;
			break;
		case 'h':
		default:
			link_usage();
			return opt == 'h' ? 0 : 1;
		}
	}
	
	if (optind >= argc) {
		print_error("Missing content hash");
		link_usage();
		return 1;
	}
	
	if (!commit) {
		print_error("Missing --commit option");
		link_usage();
		return 1;
	}
	
	const char *hash = argv[optind];
	
	printf("Linking artifact %s to commit %s\n", hash, commit);
	
	/* TODO: Implement link logic */
	printf("(Link not yet implemented)\n");
	
	return 0;
}

/*
 * Stats command
 */
static int cmd_stats(int argc, char **argv)
{
	(void)argc;
	(void)argv;
	
	/* Read stats from debugfs */
	int fd = open(SCADA_TRACE_DEBUGFS_STATS, O_RDONLY);
	if (fd < 0) {
		print_error("Failed to read stats (is kernel module loaded?)");
		return 1;
	}
	
	char buf[4096];
	ssize_t n = read(fd, buf, sizeof(buf) - 1);
	close(fd);
	
	if (n <= 0) {
		print_error("Failed to read stats");
		return 1;
	}
	
	buf[n] = '\0';
	printf("%s", buf);
	
	return 0;
}

/*
 * List command
 */
static int cmd_list(int argc, char **argv)
{
	static struct option long_options[] = {
		{"type",   required_argument, 0, 't'},
		{"site",   required_argument, 0, 's'},
		{"device", required_argument, 0, 'd'},
		{"limit",  required_argument, 0, 'l'},
		{"help",   no_argument,       0, 'h'},
		{0, 0, 0, 0}
	};
	int opt;
	const char *type = NULL;
	const char *site = NULL;
	const char *device = NULL;
	int limit = 20;
	
	optind = 0;
	while ((opt = getopt_long(argc, argv, "t:s:d:l:h",
				  long_options, NULL)) != -1) {
		switch (opt) {
		case 't':
			type = optarg;
			break;
		case 's':
			site = optarg;
			break;
		case 'd':
			device = optarg;
			break;
		case 'l':
			limit = atoi(optarg);
			break;
		case 'h':
		default:
			printf("Usage: %s list [options]\n", PROG_NAME);
			return opt == 'h' ? 0 : 1;
		}
	}
	
	printf("Listing artifacts (limit: %d)\n", limit);
	if (type) printf("  Type: %s\n", type);
	if (site) printf("  Site: %s\n", site);
	if (device) printf("  Device: %s\n", device);
	
	/* TODO: Implement list logic */
	printf("(List not yet implemented)\n");
	
	return 0;
}

/*
 * Enable/Disable commands
 */
static int cmd_enable(int argc, char **argv)
{
	(void)argc;
	(void)argv;
	
	int fd = open(SCADA_TRACE_DEBUGFS_ENABLE, O_WRONLY);
	if (fd < 0) {
		print_error("Failed to enable tracing (is kernel module loaded?)");
		return 1;
	}
	
	if (write(fd, "1", 1) != 1) {
		close(fd);
		print_error("Failed to write enable");
		return 1;
	}
	
	close(fd);
	printf("Tracing enabled\n");
	return 0;
}

static int cmd_disable(int argc, char **argv)
{
	(void)argc;
	(void)argv;
	
	int fd = open(SCADA_TRACE_DEBUGFS_ENABLE, O_WRONLY);
	if (fd < 0) {
		print_error("Failed to disable tracing (is kernel module loaded?)");
		return 1;
	}
	
	if (write(fd, "0", 1) != 1) {
		close(fd);
		print_error("Failed to write disable");
		return 1;
	}
	
	close(fd);
	printf("Tracing disabled\n");
	return 0;
}

/*
 * Command table
 */
static struct command commands[] = {
	{"capture", "Capture kernel traces", cmd_capture},
	{"show",    "Show artifact details", cmd_show},
	{"replay",  "Replay trace capture", cmd_replay},
	{"diff",    "Compare two captures", cmd_diff},
	{"link",    "Link artifact to commit", cmd_link},
	{"stats",   "Show kernel module stats", cmd_stats},
	{"list",    "List stored artifacts", cmd_list},
	{"enable",  "Enable kernel tracing", cmd_enable},
	{"disable", "Disable kernel tracing", cmd_disable},
	{NULL, NULL, NULL}
};

/*
 * Main usage
 */
static void usage(void)
{
	print_usage_header();
	printf("Usage: %s [options] <command> [args...]\n\n", PROG_NAME);
	printf("Options:\n");
	printf("  -d, --dir PATH     Artifact directory\n");
	printf("  -j, --json         JSON output\n");
	printf("  -v, --verbose      Verbose output\n");
	printf("  -h, --help         Show this help\n");
	printf("  -V, --version      Show version\n");
	printf("\nCommands:\n");
	for (struct command *cmd = commands; cmd->name; cmd++) {
		printf("  %-12s %s\n", cmd->name, cmd->desc);
	}
	printf("\nRun '%s <command> --help' for command-specific help.\n", PROG_NAME);
}

int main(int argc, char **argv)
{
	static struct option long_options[] = {
		{"dir",     required_argument, 0, 'd'},
		{"json",    no_argument,       0, 'j'},
		{"verbose", no_argument,       0, 'v'},
		{"help",    no_argument,       0, 'h'},
		{"version", no_argument,       0, 'V'},
		{0, 0, 0, 0}
	};
	int opt;
	
	/* Set default artifact directory */
	strncpy(opts.artifact_dir, "/var/lib/scada-trace/artifacts",
		sizeof(opts.artifact_dir) - 1);
	
	/* Parse global options */
	while ((opt = getopt_long(argc, argv, "+d:jvhV",
				  long_options, NULL)) != -1) {
		switch (opt) {
		case 'd':
			strncpy(opts.artifact_dir, optarg,
				sizeof(opts.artifact_dir) - 1);
			break;
		case 'j':
			opts.json_output = true;
			break;
		case 'v':
			opts.verbose = true;
			break;
		case 'V':
			printf("%s version %s\n", PROG_NAME, VERSION);
			return 0;
		case 'h':
		default:
			usage();
			return opt == 'h' ? 0 : 1;
		}
	}
	
	/* Need at least one command */
	if (optind >= argc) {
		usage();
		return 1;
	}
	
	/* Find and run command */
	const char *cmd_name = argv[optind];
	for (struct command *cmd = commands; cmd->name; cmd++) {
		if (strcmp(cmd->name, cmd_name) == 0) {
			return cmd->handler(argc - optind, argv + optind);
		}
	}
	
	fprintf(stderr, "Unknown command: %s\n\n", cmd_name);
	usage();
	return 1;
}
