# API Gateway Keys

0xSCADA reads API-key records from the `API_KEYS` environment variable. Each
record uses this format, with multiple records separated by commas:

```text
key:name:scope+scope
```

Generate key material with a cryptographically secure secret generator and
inject it at deployment time. Do not commit real keys to values files, Compose
files, or `.env` templates.

Missing scopes grant no scoped privileges. Grant `admin` to a key that must use
the gateway's key-management endpoints, and use `*` only for a deliberately
unrestricted key:

```text
<generated-key>:operations-console:admin
```

Clients send credentials only in the `X-API-Key` header. Query-string keys are
rejected because URLs commonly appear in browser history, proxy logs, and
access logs.

```bash
curl -H "X-API-Key: ${OPERATOR_KEY}" \
  https://oxscada.example.com/api/sites
```

Set `ENABLE_API_KEYS=true` to require a configured key for every non-public
API route. Health and API-documentation routes remain public.

## Docker Compose

The root `docker-compose.yml` reads `API_KEYS` and `ENABLE_API_KEYS` from the
host environment or a local `.env` file. It contains no default credential:

```bash
export OPERATOR_KEY="$(openssl rand -hex 32)"
export API_KEYS="${OPERATOR_KEY}:operations-console:admin"
export ENABLE_API_KEYS=true
docker compose up -d
```

Treat a local `.env` as a secret file and do not commit it.

## Helm

Both charts read `API_KEYS` from an existing Kubernetes Secret. The charts do
not render credentials into a Helm-managed Secret or ConfigMap:

```bash
OPERATOR_KEY="$(openssl rand -hex 32)"
API_KEYS_VALUE="${OPERATOR_KEY}:operations-console:admin"

kubectl -n oxscada create secret generic oxscada-api-keys \
  --from-literal=API_KEYS="${API_KEYS_VALUE}"

helm upgrade --install oxscada ./helm/oxscada \
  --namespace oxscada --create-namespace \
  --set-string server.apiKeys.existingSecret=oxscada-api-keys \
  --set server.apiKeys.enableGlobalAuth=true
```

Use `./helm/oxscada-full` in the same command for the full-stack chart. Set
`server.apiKeys.secretKey` when the existing Secret uses a key other than
`API_KEYS`.

Rotate keys by updating the Secret and restarting the server Deployment so
the pod receives the new environment value.
