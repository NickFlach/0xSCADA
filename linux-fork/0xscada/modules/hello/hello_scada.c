// SPDX-License-Identifier: GPL-2.0
/*
 * 0xSCADA Hello World Kernel Module
 *
 * A simple kernel module to verify the 0xSCADA kernel development environment.
 * This module demonstrates basic module operations and prints diagnostic
 * information on load and unload.
 *
 * Usage:
 *   make -C /path/to/linux-fork M=$(pwd) modules
 *   sudo insmod hello_scada.ko
 *   dmesg | tail -20
 *   sudo rmmod hello_scada
 *
 * Author: 0xSCADA Team
 * Date: 2024
 */

#include <linux/init.h>
#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/version.h>
#include <linux/utsname.h>

/* Module version information */
#define OXSCADA_HELLO_VERSION "1.0.0"
#define OXSCADA_HELLO_BUILD_DATE __DATE__ " " __TIME__

/* Module parameter for custom message */
static char *greeting = "Hello from 0xSCADA!";
module_param(greeting, charp, 0644);
MODULE_PARM_DESC(greeting, "Custom greeting message to display on load");

/* Track load timestamp for uptime reporting */
static u64 load_jiffies;

/**
 * oxscada_hello_init - Module initialization function
 *
 * Called when the module is loaded with insmod/modprobe.
 * Prints version information and system diagnostics.
 *
 * Return: 0 on success
 */
static int __init oxscada_hello_init(void)
{
	load_jiffies = get_jiffies_64();

	pr_info("========================================\n");
	pr_info("0xSCADA Hello World Module Loaded\n");
	pr_info("========================================\n");
	pr_info("  Version: %s\n", OXSCADA_HELLO_VERSION);
	pr_info("  Build Date: %s\n", OXSCADA_HELLO_BUILD_DATE);
	pr_info("  Kernel: %s\n", utsname()->release);
	pr_info("  Machine: %s\n", utsname()->machine);
	pr_info("  Message: %s\n", greeting);
	pr_info("========================================\n");
	pr_info("0xSCADA kernel development environment is ready!\n");
	pr_info("========================================\n");

	return 0;
}

/**
 * oxscada_hello_exit - Module cleanup function
 *
 * Called when the module is unloaded with rmmod/modprobe -r.
 * Cleans up resources and prints farewell message with uptime.
 */
static void __exit oxscada_hello_exit(void)
{
	u64 uptime_jiffies = get_jiffies_64() - load_jiffies;
	unsigned long uptime_secs = jiffies_to_msecs(uptime_jiffies) / 1000;
	unsigned long uptime_mins = uptime_secs / 60;
	unsigned long uptime_secs_rem = uptime_secs % 60;

	pr_info("========================================\n");
	pr_info("0xSCADA Hello World Module Unloading\n");
	pr_info("========================================\n");
	pr_info("  Module was loaded for: %lu min %lu sec\n", 
		uptime_mins, uptime_secs_rem);
	pr_info("  Cleanup completed successfully.\n");
	pr_info("  Goodbye from 0xSCADA!\n");
	pr_info("========================================\n");
}

module_init(oxscada_hello_init);
module_exit(oxscada_hello_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("0xSCADA Team");
MODULE_DESCRIPTION("Hello World kernel module for 0xSCADA development environment verification");
MODULE_VERSION(OXSCADA_HELLO_VERSION);
