# Gateway Failover Playbook

## Symptoms
- Tags reporting stale values
- WebSocket disconnections spike
- Shard manager reporting node offline
- Health manager gateway heartbeat timeout

## Automatic Remediation
The auto-remediation engine handles most gateway failures:
1. Detects heartbeat timeout (3 missed intervals)
2. Marks gateway as `draining`
3. Shard manager rebalances tags to healthy gateways
4. Load balancer stops routing to failed node
5. Alerts on-call if auto-remediation fails after 3 attempts

## Manual Recovery

### Single Gateway Failure
1. Check gateway process: `systemctl status 0xscada-gateway@{id}`
2. Check network connectivity to SCADA devices
3. Restart gateway: `systemctl restart 0xscada-gateway@{id}`
4. Verify shard reassignment: `GET /api/scaling/shards`
5. Confirm tag data flowing: check historian for gaps

### Multiple Gateway Failure
1. **Priority:** Ensure critical safety tags have coverage
2. Check common cause (network, DNS, certificate expiry)
3. Spin up emergency gateway instances
4. Force shard rebalance: `POST /api/scaling/rebalance`
5. Enable store-and-forward for affected edge nodes

### Gateway Certificate Expiry
1. Check cert: `openssl x509 -in /etc/0xscada/gateway.crt -noout -dates`
2. Renew via CA or auto-renewal system
3. Restart gateway with new certificate
4. Verify mTLS handshake with server

## Verification
- All shards assigned to active gateways
- No historian data gaps > 1 minute
- WebSocket reconnection count returns to baseline
- Store-and-forward queues draining
