/* SPDX-License-Identifier: GPL-2.0 */
/*
 * 0xSCADA Trace Capture Daemon
 *
 * Userspace daemon that:
 * - Polls kernel trace buffers via debugfs
 * - Aggregates and compresses captures
 * - Links captures to git commits
 * - Stores as content-addressed LFS artifacts
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
#include <signal.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <syslog.h>
#include <getopt.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/mman.h>
#include <sys/epoll.h>
#include <sys/inotify.h>
#include <pthread.h>
#include <openssl/sha.h>

#include "../include/scada_trace_api.h"
#include "../include/replay_metadata.h"
#include "artifact.h"

/*
 * Daemon configuration
 */
#define DAEMON_NAME		"scada-traced"
#define DEFAULT_CONFIG_FILE	"/etc/scada-trace/traced.conf"
#define DEFAULT_ARTIFACT_DIR	"/var/lib/scada-trace/artifacts"
#define DEFAULT_PID_FILE	"/var/run/scada-traced.pid"
#define DEFAULT_POLL_INTERVAL_MS 1000
#define MAX_SNAPSHOT_SIZE	(64 * 1024 * 1024)  /* 64MB */

/*
 * Global state
 */
static struct {
	bool running;
	bool foreground;
	int log_level;
	
	/* Configuration */
	char config_file[PATH_MAX];
	char artifact_dir[PATH_MAX];
	char pid_file[PATH_MAX];
	uint32_t poll_interval_ms;
	bool auto_link_commits;
	bool compress_artifacts;
	
	/* Runtime state */
	artifact_storage_t *storage;
	char current_commit[41];
	uint64_t sequence;
	
	/* Threads */
	pthread_t poll_thread;
	pthread_mutex_t lock;
	
	/* Statistics */
	uint64_t captures_stored;
	uint64_t bytes_stored;
	uint64_t errors;
} daemon_ctx = {
	.running = false,
	.foreground = false,
	.log_level = LOG_INFO,
	.poll_interval_ms = DEFAULT_POLL_INTERVAL_MS,
	.auto_link_commits = true,
	.compress_artifacts = true,
	.lock = PTHREAD_MUTEX_INITIALIZER,
};

/*
 * Logging
 */
#define LOG(level, fmt, ...) do { \
	if ((level) <= daemon_ctx.log_level) { \
		if (daemon_ctx.foreground) { \
			fprintf(stderr, "[%s] " fmt "\n", \
				(level) == LOG_ERR ? "ERROR" : \
				(level) == LOG_WARNING ? "WARN" : \
				(level) == LOG_INFO ? "INFO" : "DEBUG", \
				##__VA_ARGS__); \
		} else { \
			syslog((level), fmt, ##__VA_ARGS__); \
		} \
	} \
} while (0)

#define LOG_ERROR(fmt, ...)	LOG(LOG_ERR, fmt, ##__VA_ARGS__)
#define LOG_WARN(fmt, ...)	LOG(LOG_WARNING, fmt, ##__VA_ARGS__)
#define LOG_INFO(fmt, ...)	LOG(LOG_INFO, fmt, ##__VA_ARGS__)
#define LOG_DEBUG(fmt, ...)	LOG(LOG_DEBUG, fmt, ##__VA_ARGS__)

/*
 * Signal handler
 */
static void signal_handler(int sig)
{
	switch (sig) {
	case SIGTERM:
	case SIGINT:
		LOG_INFO("Received signal %d, shutting down", sig);
		daemon_ctx.running = false;
		break;
	case SIGHUP:
		LOG_INFO("Received SIGHUP, reloading config");
		/* TODO: Reload configuration */
		break;
	}
}

/*
 * Daemonize
 */
static int daemonize(void)
{
	pid_t pid;
	int fd;
	
	pid = fork();
	if (pid < 0) {
		perror("fork");
		return -1;
	}
	if (pid > 0) {
		exit(0);  /* Parent exits */
	}
	
	/* Child becomes session leader */
	if (setsid() < 0) {
		perror("setsid");
		return -1;
	}
	
	/* Fork again to prevent reacquiring terminal */
	pid = fork();
	if (pid < 0) {
		perror("fork");
		return -1;
	}
	if (pid > 0) {
		exit(0);
	}
	
	/* Set file permissions */
	umask(0027);
	
	/* Change to root directory */
	if (chdir("/") < 0) {
		perror("chdir");
		return -1;
	}
	
	/* Close standard file descriptors */
	close(STDIN_FILENO);
	close(STDOUT_FILENO);
	close(STDERR_FILENO);
	
	/* Redirect to /dev/null */
	fd = open("/dev/null", O_RDWR);
	if (fd >= 0) {
		dup2(fd, STDIN_FILENO);
		dup2(fd, STDOUT_FILENO);
		dup2(fd, STDERR_FILENO);
		if (fd > STDERR_FILENO)
			close(fd);
	}
	
	return 0;
}

/*
 * Write PID file
 */
static int write_pid_file(void)
{
	FILE *f;
	
	f = fopen(daemon_ctx.pid_file, "w");
	if (!f) {
		LOG_ERROR("Failed to create PID file: %s", strerror(errno));
		return -1;
	}
	
	fprintf(f, "%d\n", getpid());
	fclose(f);
	
	return 0;
}

/*
 * Get current git commit
 */
static int get_git_commit(char *commit, size_t len)
{
	FILE *fp;
	char cmd[] = "git rev-parse HEAD 2>/dev/null";
	
	fp = popen(cmd, "r");
	if (!fp)
		return -1;
	
	if (!fgets(commit, len, fp)) {
		pclose(fp);
		return -1;
	}
	
	/* Remove newline */
	size_t slen = strlen(commit);
	if (slen > 0 && commit[slen-1] == '\n')
		commit[slen-1] = '\0';
	
	pclose(fp);
	
	/* Validate format */
	if (strlen(commit) != 40)
		return -1;
	
	return 0;
}

/*
 * Read kernel trace data via debugfs
 */
static int read_kernel_traces(void **data, size_t *size)
{
	/* 
	 * TODO: Read from /sys/kernel/debug/scada_trace/
	 * For now, return a placeholder
	 */
	*data = NULL;
	*size = 0;
	return 0;
}

/*
 * Compute SHA-256 hash
 */
static void compute_sha256(const void *data, size_t len, char *hash_out)
{
	unsigned char digest[SHA256_DIGEST_LENGTH];
	SHA256_CTX ctx;
	
	SHA256_Init(&ctx);
	SHA256_Update(&ctx, data, len);
	SHA256_Final(digest, &ctx);
	
	for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) {
		sprintf(hash_out + (i * 2), "%02x", digest[i]);
	}
	hash_out[64] = '\0';
}

/*
 * Store snapshot as artifact
 */
static int store_artifact(const void *data, size_t size)
{
	reality_artifact_t artifact;
	artifact_create_input_t input = {0};
	char hash[65];
	int ret;
	
	/* Compute content hash */
	compute_sha256(data, size, hash);
	
	/* Setup input */
	input.origin.system = ORIGIN_LINUX;
	strncpy(input.origin.fork, daemon_ctx.current_commit,
		sizeof(input.origin.fork) - 1);
	
	input.scope.type = ARTIFACT_TRACE;
	input.summary = "Kernel trace capture";
	input.data = data;
	input.data_size = size;
	input.mime_type = "application/octet-stream";
	
	/* Create artifact */
	ret = artifact_create(daemon_ctx.storage, &input, &artifact);
	if (ret < 0) {
		LOG_ERROR("Failed to create artifact: %d", ret);
		return ret;
	}
	
	/* Link to commit if auto-linking enabled */
	if (daemon_ctx.auto_link_commits && daemon_ctx.current_commit[0]) {
		ret = artifact_link_commit(daemon_ctx.storage,
					   artifact.id,
					   daemon_ctx.current_commit);
		if (ret < 0) {
			LOG_WARN("Failed to link artifact to commit: %d", ret);
		}
	}
	
	LOG_INFO("Stored artifact: %s (%zu bytes)", artifact.id, size);
	
	pthread_mutex_lock(&daemon_ctx.lock);
	daemon_ctx.captures_stored++;
	daemon_ctx.bytes_stored += size;
	pthread_mutex_unlock(&daemon_ctx.lock);
	
	artifact_free(&artifact);
	return 0;
}

/*
 * Poll thread - reads kernel traces and stores artifacts
 */
static void *poll_thread_func(void *arg)
{
	void *data = NULL;
	size_t size = 0;
	int ret;
	
	LOG_INFO("Poll thread started (interval: %u ms)",
		 daemon_ctx.poll_interval_ms);
	
	while (daemon_ctx.running) {
		/* Update git commit */
		if (daemon_ctx.auto_link_commits) {
			get_git_commit(daemon_ctx.current_commit,
				       sizeof(daemon_ctx.current_commit));
		}
		
		/* Read kernel traces */
		ret = read_kernel_traces(&data, &size);
		if (ret < 0) {
			LOG_ERROR("Failed to read traces: %d", ret);
			daemon_ctx.errors++;
		} else if (size > 0) {
			ret = store_artifact(data, size);
			if (ret < 0) {
				daemon_ctx.errors++;
			}
			free(data);
			data = NULL;
		}
		
		/* Sleep */
		usleep(daemon_ctx.poll_interval_ms * 1000);
	}
	
	LOG_INFO("Poll thread exiting");
	return NULL;
}

/*
 * Print usage
 */
static void usage(const char *progname)
{
	fprintf(stderr,
		"Usage: %s [options]\n"
		"\n"
		"Options:\n"
		"  -c, --config FILE    Config file (default: %s)\n"
		"  -d, --artifact-dir   Artifact directory (default: %s)\n"
		"  -f, --foreground     Run in foreground\n"
		"  -i, --interval MS    Poll interval in milliseconds (default: %d)\n"
		"  -n, --no-auto-link   Disable auto-linking to git commits\n"
		"  -p, --pid-file FILE  PID file (default: %s)\n"
		"  -v, --verbose        Increase verbosity\n"
		"  -h, --help           Show this help\n"
		"\n",
		progname,
		DEFAULT_CONFIG_FILE,
		DEFAULT_ARTIFACT_DIR,
		DEFAULT_POLL_INTERVAL_MS,
		DEFAULT_PID_FILE);
}

/*
 * Main
 */
int main(int argc, char *argv[])
{
	static struct option long_options[] = {
		{"config",       required_argument, 0, 'c'},
		{"artifact-dir", required_argument, 0, 'd'},
		{"foreground",   no_argument,       0, 'f'},
		{"interval",     required_argument, 0, 'i'},
		{"no-auto-link", no_argument,       0, 'n'},
		{"pid-file",     required_argument, 0, 'p'},
		{"verbose",      no_argument,       0, 'v'},
		{"help",         no_argument,       0, 'h'},
		{0, 0, 0, 0}
	};
	int opt;
	int ret;
	
	/* Set defaults */
	strncpy(daemon_ctx.config_file, DEFAULT_CONFIG_FILE,
		sizeof(daemon_ctx.config_file) - 1);
	strncpy(daemon_ctx.artifact_dir, DEFAULT_ARTIFACT_DIR,
		sizeof(daemon_ctx.artifact_dir) - 1);
	strncpy(daemon_ctx.pid_file, DEFAULT_PID_FILE,
		sizeof(daemon_ctx.pid_file) - 1);
	
	/* Parse arguments */
	while ((opt = getopt_long(argc, argv, "c:d:fi:np:vh",
				  long_options, NULL)) != -1) {
		switch (opt) {
		case 'c':
			strncpy(daemon_ctx.config_file, optarg,
				sizeof(daemon_ctx.config_file) - 1);
			break;
		case 'd':
			strncpy(daemon_ctx.artifact_dir, optarg,
				sizeof(daemon_ctx.artifact_dir) - 1);
			break;
		case 'f':
			daemon_ctx.foreground = true;
			break;
		case 'i':
			daemon_ctx.poll_interval_ms = atoi(optarg);
			break;
		case 'n':
			daemon_ctx.auto_link_commits = false;
			break;
		case 'p':
			strncpy(daemon_ctx.pid_file, optarg,
				sizeof(daemon_ctx.pid_file) - 1);
			break;
		case 'v':
			daemon_ctx.log_level = LOG_DEBUG;
			break;
		case 'h':
		default:
			usage(argv[0]);
			exit(opt == 'h' ? 0 : 1);
		}
	}
	
	/* Setup logging */
	if (!daemon_ctx.foreground) {
		openlog(DAEMON_NAME, LOG_PID, LOG_DAEMON);
	}
	
	LOG_INFO("%s starting", DAEMON_NAME);
	
	/* Daemonize if not in foreground */
	if (!daemon_ctx.foreground) {
		if (daemonize() < 0) {
			LOG_ERROR("Failed to daemonize");
			exit(1);
		}
	}
	
	/* Write PID file */
	if (write_pid_file() < 0) {
		exit(1);
	}
	
	/* Setup signal handlers */
	signal(SIGTERM, signal_handler);
	signal(SIGINT, signal_handler);
	signal(SIGHUP, signal_handler);
	signal(SIGPIPE, SIG_IGN);
	
	/* Create artifact directory */
	mkdir(daemon_ctx.artifact_dir, 0750);
	
	/* Initialize artifact storage */
	daemon_ctx.storage = artifact_storage_create("local",
						     daemon_ctx.artifact_dir);
	if (!daemon_ctx.storage) {
		LOG_ERROR("Failed to create artifact storage");
		exit(1);
	}
	
	/* Get initial git commit */
	if (daemon_ctx.auto_link_commits) {
		get_git_commit(daemon_ctx.current_commit,
			       sizeof(daemon_ctx.current_commit));
		if (daemon_ctx.current_commit[0]) {
			LOG_INFO("Initial git commit: %.8s...",
				 daemon_ctx.current_commit);
		}
	}
	
	/* Start poll thread */
	daemon_ctx.running = true;
	ret = pthread_create(&daemon_ctx.poll_thread, NULL,
			     poll_thread_func, NULL);
	if (ret != 0) {
		LOG_ERROR("Failed to create poll thread: %s", strerror(ret));
		exit(1);
	}
	
	LOG_INFO("%s started, PID=%d", DAEMON_NAME, getpid());
	
	/* Wait for poll thread */
	pthread_join(daemon_ctx.poll_thread, NULL);
	
	/* Cleanup */
	LOG_INFO("Shutting down");
	
	artifact_storage_destroy(daemon_ctx.storage);
	unlink(daemon_ctx.pid_file);
	
	if (!daemon_ctx.foreground) {
		closelog();
	}
	
	LOG_INFO("%s stopped. Captures: %lu, Bytes: %lu, Errors: %lu",
		 DAEMON_NAME,
		 daemon_ctx.captures_stored,
		 daemon_ctx.bytes_stored,
		 daemon_ctx.errors);
	
	return 0;
}
