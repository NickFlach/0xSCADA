// SPDX-License-Identifier: GPL-2.0-only
/*
 * 0xSCADA Network Protocol Filtering
 *
 * Netfilter hooks for capturing industrial protocol traffic
 * and generating reality artifacts.
 *
 * Supported protocols:
 * - Modbus TCP (port 502)
 * - DNP3 (port 20000)
 * - IEC 61850 MMS (port 102)
 * - OPC UA (port 4840)
 *
 * Copyright (c) 2024 0xSCADA Project
 */

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/netfilter.h>
#include <linux/netfilter_ipv4.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/udp.h>
#include <net/tcp.h>

#include "../core/artifact.h"

/* Industrial protocol ports */
#define MODBUS_TCP_PORT		502
#define DNP3_PORT		20000
#define IEC61850_MMS_PORT	102
#define OPCUA_PORT		4840

/* Protocol identifiers */
#define SCADA_PROTO_MODBUS	1
#define SCADA_PROTO_DNP3	2
#define SCADA_PROTO_IEC61850	3
#define SCADA_PROTO_OPCUA	4

static bool filter_enabled = true;
module_param(filter_enabled, bool, 0644);
MODULE_PARM_DESC(filter_enabled, "Enable/disable protocol filtering");

static bool capture_payload = true;
module_param(capture_payload, bool, 0644);
MODULE_PARM_DESC(capture_payload, "Capture packet payload in artifacts");

/**
 * struct scada_net_event - Network event data for artifacts
 * @timestamp: Event timestamp
 * @protocol: SCADA protocol identifier
 * @src_ip: Source IP address
 * @dst_ip: Destination IP address
 * @src_port: Source port
 * @dst_port: Destination port
 * @payload_len: Length of captured payload
 * @payload: Captured payload data
 */
struct scada_net_event {
	u64 timestamp;
	u8 protocol;
	__be32 src_ip;
	__be32 dst_ip;
	__be16 src_port;
	__be16 dst_port;
	u16 payload_len;
	u8 payload[512];
};

/**
 * get_protocol_name - Get human-readable protocol name
 * @proto: Protocol identifier
 */
static const char *get_protocol_name(u8 proto)
{
	switch (proto) {
	case SCADA_PROTO_MODBUS:
		return "Modbus TCP";
	case SCADA_PROTO_DNP3:
		return "DNP3";
	case SCADA_PROTO_IEC61850:
		return "IEC 61850 MMS";
	case SCADA_PROTO_OPCUA:
		return "OPC UA";
	default:
		return "Unknown";
	}
}

/**
 * identify_protocol - Identify SCADA protocol from port
 * @port: TCP/UDP port number
 *
 * Returns protocol identifier or 0 if not a known SCADA protocol.
 */
static u8 identify_protocol(__be16 port)
{
	switch (ntohs(port)) {
	case MODBUS_TCP_PORT:
		return SCADA_PROTO_MODBUS;
	case DNP3_PORT:
		return SCADA_PROTO_DNP3;
	case IEC61850_MMS_PORT:
		return SCADA_PROTO_IEC61850;
	case OPCUA_PORT:
		return SCADA_PROTO_OPCUA;
	default:
		return 0;
	}
}

/**
 * scada_create_net_artifact - Create artifact from network event
 * @event: Network event data
 */
static int scada_create_net_artifact(struct scada_net_event *event)
{
	struct scada_artifact *art;
	char summary[256];
	int ret;

	art = scada_artifact_create(SCADA_ORIGIN_SYSTEM, SCADA_SCOPE_LINUX);
	if (!art)
		return -ENOMEM;

	ret = scada_artifact_set_origin_id(art, "linux-fork/net/scada_filter");
	if (ret)
		goto err;

	ret = scada_artifact_set_subsystem(art, get_protocol_name(event->protocol));
	if (ret)
		goto err;

	ret = scada_artifact_set_content_type(art, SCADA_CONTENT_TRACE);
	if (ret)
		goto err;

	ret = scada_artifact_set_content(art, event,
					 offsetof(struct scada_net_event, payload) +
					 event->payload_len);
	if (ret)
		goto err;

	snprintf(summary, sizeof(summary),
		 "%s: %pI4:%u -> %pI4:%u (%u bytes)",
		 get_protocol_name(event->protocol),
		 &event->src_ip, ntohs(event->src_port),
		 &event->dst_ip, ntohs(event->dst_port),
		 event->payload_len);
	ret = scada_artifact_set_summary(art, summary);
	if (ret)
		goto err;

	ret = scada_artifact_finalize(art);
	if (ret)
		goto err;

	scada_artifact_put(art);
	return 0;

err:
	scada_artifact_put(art);
	return ret;
}

/**
 * scada_nf_hook - Netfilter hook for SCADA protocol capture
 */
static unsigned int scada_nf_hook(void *priv,
				  struct sk_buff *skb,
				  const struct nf_hook_state *state)
{
	struct iphdr *iph;
	struct tcphdr *tcph;
	struct scada_net_event event = {0};
	u8 proto;
	unsigned char *payload;
	unsigned int payload_len;

	if (!filter_enabled)
		return NF_ACCEPT;

	iph = ip_hdr(skb);
	if (iph->protocol != IPPROTO_TCP)
		return NF_ACCEPT;

	tcph = tcp_hdr(skb);

	/* Check if this is a known SCADA protocol */
	proto = identify_protocol(tcph->dest);
	if (!proto)
		proto = identify_protocol(tcph->source);
	if (!proto)
		return NF_ACCEPT;

	/* Build the network event */
	event.timestamp = ktime_get_real_ns();
	event.protocol = proto;
	event.src_ip = iph->saddr;
	event.dst_ip = iph->daddr;
	event.src_port = tcph->source;
	event.dst_port = tcph->dest;

	if (capture_payload) {
		payload = (unsigned char *)tcph + (tcph->doff * 4);
		payload_len = ntohs(iph->tot_len) - (iph->ihl * 4) - (tcph->doff * 4);
		
		if (payload_len > sizeof(event.payload))
			payload_len = sizeof(event.payload);
		
		memcpy(event.payload, payload, payload_len);
		event.payload_len = payload_len;
	}

	/* Create artifact (non-blocking, best effort) */
	scada_create_net_artifact(&event);

	return NF_ACCEPT;
}

static const struct nf_hook_ops scada_nf_ops = {
	.hook = scada_nf_hook,
	.pf = NFPROTO_IPV4,
	.hooknum = NF_INET_PRE_ROUTING,
	.priority = NF_IP_PRI_FIRST,
};

static int __init scada_filter_init(void)
{
	int ret;

	ret = nf_register_net_hook(&init_net, &scada_nf_ops);
	if (ret) {
		pr_err("0xscada: failed to register netfilter hook\n");
		return ret;
	}

	pr_info("0xscada: network filter initialized\n");
	pr_info("0xscada:   Monitoring: Modbus TCP (%d), DNP3 (%d), "
		"IEC 61850 (%d), OPC UA (%d)\n",
		MODBUS_TCP_PORT, DNP3_PORT, IEC61850_MMS_PORT, OPCUA_PORT);

	return 0;
}

static void __exit scada_filter_exit(void)
{
	nf_unregister_net_hook(&init_net, &scada_nf_ops);
	pr_info("0xscada: network filter unloaded\n");
}

module_init(scada_filter_init);
module_exit(scada_filter_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("0xSCADA Project");
MODULE_DESCRIPTION("0xSCADA Industrial Protocol Network Filter");
