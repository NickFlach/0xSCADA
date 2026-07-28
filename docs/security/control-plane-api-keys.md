# Control-Plane API Keys

0xSCADA reads API key records from `API_KEYS` or the file named by
`API_KEYS_FILE`. A record has the following format, and multiple records are
comma-separated:

```text
key:name:scope+scope
```

Do not commit real key material to a values file, Compose file, or `.env`
template. Generate each key with a cryptographically secure secret generator
and inject the complete `API_KEYS` value at deployment time.

## Anchor-switch grant

The anchor-backend status and dry-run endpoints require the `operator` grant.
A committed backend switch additionally requires `anchor.admin`:

```text
<generated-operator-key>:anchor-operations:operator+anchor.admin
```

`admin` and `*` bypass the role and scope checks. Reserve them for exceptional
break-glass workflows rather than routine operator keys.

Clients send a key only in the `X-API-Key` request header:

```bash
curl -H "X-API-Key: ${OPERATOR_KEY}" \
  https://oxscada.example.com/api/admin/anchor-backend
```

## Alarm-correlation grants

Alarm correlation uses separate grants so an observer, producer, operator, or
configuration client receives only the capability it needs:

| Grant | Capability |
| --- | --- |
| `alarms.read` | Read groups, root cause, rules, topology, policy, metrics, and status |
| `alarms.ingest` | Ingest raw active alarms |
| `alarms.acknowledge` | Acknowledge a tracked alarm |
| `alarms.clear` | Clear a tracked alarm |
| `alarms.configure` | Change rules, topology, or suppression policy |

For example, a dedicated ingest key can be configured without any lifecycle or
configuration authority:

```text
<generated-ingest-key>:alarm-ingester:alarms.ingest
```

Suppression defaults off, and `alarms.configure` alone is not enough to turn it
on. `PUT /api/alarm-correlation/suppression-policy` with `enabled: true` is
refused with `409` unless one of the following holds:

- **Durable coordination is healthy.** Start the server with
  `ALARM_CORRELATION_DURABLE=true` and a reachable database (migration 0015).
  Correlation state is then persisted and ordered through a shared journal, so
  every replica agrees and the state survives restart.
  `GET /api/alarm-correlation/coordination` reports the live health, and the
  policy route reads the same value rather than trusting the flag.
- **An explicit single-process evaluation** via
  `ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION=true`. Use that escape hatch
  only for a single-process evaluation; state is lost on restart and a second
  replica may hold a different view.

If durable coordination later fails, the server disables suppression on its own,
restores every suppressed alarm, re-broadcasts them, and reports
`coordinationMode: "process-local"`. Losing coordination can only reveal more
alarms, never fewer.

Configuration mutations (`rules`, `topology`, `suppression-policy`) accept an
optional `Idempotency-Key` header so a retry is applied once. Without it each
request is a distinct operation, because setting a rule to A, then B, then back
to A is genuinely three changes.

## Docker Compose

The production root `docker-compose.yml` enables global authentication and
requires a Docker secret file. Control-plane routes remain fail closed even
when a development process explicitly disables global gateway authentication.

```bash
umask 077
mkdir -p .secrets
OPERATOR_KEY="$(openssl rand -hex 32)"
printf '%s' \
  "${OPERATOR_KEY}:anchor-operations:operator+anchor.admin+read+stream.read" \
  > .secrets/api-keys
export API_KEYS_FILE="$PWD/.secrets/api-keys"
docker compose up -d
```

Treat `.env` as a local secret file if it is used for persistence, and do not
commit it.

## Helm

Both `helm/oxscada` and `helm/oxscada-full` read `API_KEYS` from an existing
Kubernetes Secret. Create the Secret out of band, then select it with
`server.apiKeys.existingSecret`. The chart does not render the credential into
a Helm-managed Secret or ConfigMap.

```bash
OPERATOR_KEY="$(openssl rand -hex 32)"
API_KEYS_VALUE="${OPERATOR_KEY}:anchor-operations:operator+anchor.admin"

kubectl create namespace oxscada --dry-run=client -o yaml | kubectl apply -f -
kubectl -n oxscada create secret generic oxscada-api-keys \
  --from-literal=API_KEYS="${API_KEYS_VALUE}"

helm upgrade --install oxscada ./helm/oxscada \
  --namespace oxscada --create-namespace \
  --set-string server.apiKeys.existingSecret=oxscada-api-keys
```

Use `./helm/oxscada-full` in the same command for the full-stack chart. Set
`server.apiKeys.secretKey` if the existing Secret uses a key other than
`API_KEYS`. Global authentication defaults to true, and Helm rendering fails
until `server.apiKeys.existingSecret` is supplied.

The first-party browser client sends REST keys via `X-API-Key` and WebSocket
keys via the validated `Sec-WebSocket-Protocol` scheme documented in
[API Gateway Keys](api-gateway-keys.md). Keys live only in memory and
`sessionStorage`; review that document's XSS and TLS threat model before use.

Rotate keys by updating the Secret and restarting the server Deployment so the
pod receives the new environment value:

```bash
kubectl -n oxscada rollout restart deployment/oxscada-server
```

The API key-generation endpoint is process-local and ephemeral. Do not use it
as the source of production credentials in a multi-replica deployment until a
shared credential store is implemented.
