# API Gateway Keys

0xSCADA reads API-key records from `API_KEYS`, or from the file named by
`API_KEYS_FILE`. Each record uses this format, with multiple records separated
by commas:

```text
key:name:scope+scope
```

Generate key material with a cryptographically secure secret generator and
inject it at deployment time. Do not commit real keys to values files, Compose
files, or `.env` templates.

Missing scopes grant no scoped privileges. The key-generation API also rejects
missing or empty scopes. A bootstrap administrator can create narrower keys:

```text
<generated-key>:operations-console:admin
```

`admin` and `*` bypass route scope checks. Reserve both for bootstrap or
break-glass use.

API-generated keys currently live in the serving process only: they do not
survive a restart or replicate to another pod. Use that endpoint only for
single-process development until a shared credential store is selected. For
multi-replica production, provision every required key through the shared
Docker/Kubernetes secret and restart the deployment after rotation.

## Scope policy

All `POST`, `PUT`, `PATCH`, and `DELETE` requests require `write` unless a
narrower control-route policy applies:

| Scope | Access |
|---|---|
| `read` | Conventional least-privilege grant for REST clients; also permits WebSocket streams |
| `stream.read` | WebSocket streams without general REST-read naming |
| `write` | Ordinary API mutations |
| `alarms.write` | Alarm evaluation/injection/suppression family |
| `geometry.write` | Geometry rule and recalibration mutations |
| `operator+anchor.admin` | Anchor-backend inspection and switching |
| `safety.resume` | Blueprint safe-state resume |
| `tuning.write`, `tuning.approve` | Tuning changes and human approvals |
| `control.write` | Digital-twin control operations |
| `security.admin` | HSM control operations |
| `websocket.admin` | Streaming-client administration |

The server-owned policy inventory is
`server/middleware/control-route-policy.ts`. Feature routers may enforce a
stricter policy in addition to this gateway floor.

Clients send credentials only in the `X-API-Key` header. Query-string keys are
rejected because URLs commonly appear in browser history, proxy logs, and
access logs.

```bash
curl -H "X-API-Key: ${OPERATOR_KEY}" \
  https://oxscada.example.com/api/sites
```

When `ENABLE_API_KEYS=true`, startup fails if neither `API_KEYS` nor
`API_KEYS_FILE` yields a bootstrap key. Health, readiness, and API-documentation
routes remain public.

## Browser client and WebSockets

The first-party React client has a masked **Session API key** control in its
header. It stores the key in memory and `sessionStorage`, adds `X-API-Key` only
to same-origin `/api` requests, and clears the key when the tab session ends.
It never puts a key in a URL.

Browser WebSocket APIs cannot add `X-API-Key`. For `/ws` and `/ws/tags`, the
client sends a stable `oxscada.v1` subprotocol and a second
`oxscada.api-key.<base64url-key>` token. The server parses and validates that
token during the HTTP upgrade, checks `read` or `stream.read`, and negotiates
only the stable protocol. Query credentials are rejected.

Base64url is transport encoding, not encryption. Configure reverse proxies to
forward but never log `Sec-WebSocket-Protocol`, because the credential token is
a bearer secret even though the server does not echo it.

The gateway currently authenticates, but does not further scope, ordinary
`GET` requests; the `read` name documents caller intent and is enforced for
stream upgrades. Mutations always pass through the policy table above.

This is bearer-key plumbing, not protection from compromised page JavaScript.
An XSS payload running in the 0xSCADA origin can read `sessionStorage` and use
the in-memory key. Deploy with a strict Content Security Policy, avoid
third-party scripts, grant the UI only the scopes it needs, and prefer short
key lifetimes. TLS is mandatory because both REST and WebSocket credentials
travel in request headers.

## Docker Compose

The production root `docker-compose.yml` enables authentication by default and
requires a Docker secret file:

```bash
umask 077
mkdir -p .secrets
BOOTSTRAP_KEY="$(openssl rand -hex 32)"
printf '%s' "${BOOTSTRAP_KEY}:bootstrap-admin:admin" > .secrets/api-keys

export API_KEYS_FILE="$PWD/.secrets/api-keys"
docker compose up -d
```

The file is mounted read-only at `/run/secrets/api_keys`; key material is not
placed in the Compose YAML or process environment. Never commit `.secrets`.

## Helm

Both charts enable global authentication by default and require
`server.apiKeys.existingSecret` at render time. They never render credentials
into a Helm-managed Secret or ConfigMap:

```bash
OPERATOR_KEY="$(openssl rand -hex 32)"
API_KEYS_VALUE="${OPERATOR_KEY}:bootstrap-admin:admin"

kubectl -n oxscada create secret generic oxscada-api-keys \
  --from-literal=API_KEYS="${API_KEYS_VALUE}"

helm upgrade --install oxscada ./helm/oxscada \
  --namespace oxscada --create-namespace \
  --set-string server.apiKeys.existingSecret=oxscada-api-keys
```

Use `./helm/oxscada-full` in the same command for the full-stack chart. Set
`server.apiKeys.secretKey` when the existing Secret uses a key other than
`API_KEYS`.

Rotate keys by updating the Secret and restarting the server Deployment so
the pod receives the new environment value.
