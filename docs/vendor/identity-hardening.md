# Vendor Learning Tract: Identity & Hardening

Security guide for 0xSCADA deployments — authentication, authorization, TLS, certificate management, and audit logging.

---

## 1. Authentication

### 1.1 Authentication Methods

| Method | Use Case | Configuration |
|---|---|---|
| API Key | Service-to-service, CLI | `Authorization: Bearer <key>` |
| JWT (OAuth 2.0) | Web UI, SSO integration | OIDC provider configuration |
| mTLS | Gateway-to-server | Client certificate required |
| Wallet Signature | Blockchain operations | Ethereum ECDSA signature |

### 1.2 API Key Management

**Creating keys:**
```bash
0xscada auth create-key --name "vendor-integration" --scopes "read:tags,read:alarms"
```

**Key policies:**
- Minimum 256-bit entropy
- Expiration: configurable (default 90 days)
- Auto-rotation support via key pairs (create new before revoking old)
- Store in environment variables or secrets manager (never in code)

**Key rotation procedure:**
1. Generate new key with `0xscada auth create-key`
2. Update consuming services with new key
3. Verify new key works
4. Revoke old key with `0xscada auth revoke-key <id>`

### 1.3 OAuth 2.0 / OIDC Integration

Configure in `0xscada.config.json`:

```json
{
  "auth": {
    "provider": "oidc",
    "issuer": "https://auth.your-company.com",
    "clientId": "0xscada-prod",
    "clientSecret": "${OIDC_CLIENT_SECRET}",
    "scopes": ["openid", "profile", "email"],
    "callbackUrl": "https://scada.your-company.com/auth/callback",
    "usernameClaim": "preferred_username",
    "groupsClaim": "groups"
  }
}
```

**Supported providers:**
- Azure AD / Entra ID
- Okta
- Auth0
- Keycloak
- Any OIDC-compliant provider

### 1.4 Multi-Factor Authentication (MFA)

- TOTP (Google Authenticator, Authy) for web UI
- Hardware tokens (FIDO2/WebAuthn) for administrative access
- Enforce MFA for roles with write access: `auth.mfaRequired: ["admin", "operator"]`

---

## 2. Authorization

### 2.1 Role-Based Access Control (RBAC)

**Built-in roles:**

| Role | Permissions |
|---|---|
| `viewer` | Read-only access to tags, alarms, events |
| `operator` | Viewer + acknowledge alarms, write tags |
| `engineer` | Operator + manage gateways, blueprints |
| `admin` | Full access including user/key management |
| `auditor` | Read-only access + audit logs |

### 2.2 Scope-Based Permissions

API keys use fine-grained scopes:

```
read:sites, write:sites
read:tags, write:tags
read:alarms, write:alarms
read:events
read:gateways, write:gateways
read:blueprints, write:blueprints
read:audit
admin:users, admin:keys
```

### 2.3 Site-Level Isolation

Restrict users/keys to specific sites:

```json
{
  "apiKey": {
    "scopes": ["read:tags", "read:alarms"],
    "sites": ["site-001", "site-002"],
    "restrictions": {
      "ipWhitelist": ["10.0.0.0/8"],
      "timeWindow": { "start": "06:00", "end": "22:00", "timezone": "UTC" }
    }
  }
}
```

### 2.4 Attribute-Based Access Control (ABAC)

For complex policies, use ABAC rules:

```json
{
  "policy": {
    "effect": "allow",
    "conditions": {
      "user.department": "operations",
      "resource.site.region": "north-america",
      "context.time": { "between": ["06:00", "22:00"] }
    },
    "actions": ["read:tags", "write:tags"]
  }
}
```

---

## 3. TLS Configuration

### 3.1 Server TLS

**Minimum requirements:**
- TLS 1.2+ (TLS 1.3 preferred)
- Strong cipher suites only
- HSTS enabled

Configure in environment or config:

```bash
OXSCADA_TLS_CERT=/etc/0xscada/tls/server.crt
OXSCADA_TLS_KEY=/etc/0xscada/tls/server.key
OXSCADA_TLS_CA=/etc/0xscada/tls/ca.crt
OXSCADA_TLS_MIN_VERSION=1.2
```

### 3.2 Recommended Cipher Suites

```
TLS_AES_256_GCM_SHA384
TLS_CHACHA20_POLY1305_SHA256
TLS_AES_128_GCM_SHA256
ECDHE-ECDSA-AES256-GCM-SHA384
ECDHE-RSA-AES256-GCM-SHA384
```

### 3.3 Mutual TLS (mTLS) for Gateways

Gateway connections should use mTLS for strong machine identity:

```yaml
# Gateway configuration
gateway:
  tls:
    cert: /etc/gateway/client.crt
    key: /etc/gateway/client.key
    ca: /etc/gateway/ca.crt
    verifyServer: true
```

**Server-side verification:**
```json
{
  "gateway": {
    "mtls": {
      "enabled": true,
      "ca": "/etc/0xscada/tls/gateway-ca.crt",
      "crl": "/etc/0xscada/tls/gateway.crl",
      "allowedCNs": ["gateway-north-*", "gateway-south-*"]
    }
  }
}
```

---

## 4. Certificate Management

### 4.1 PKI Architecture

```
Root CA (offline, air-gapped)
├── Intermediate CA (server certificates)
│   ├── 0xscada-server.crt
│   └── web-ui.crt
└── Gateway CA (device certificates)
    ├── gateway-001.crt
    ├── gateway-002.crt
    └── ...
```

### 4.2 Certificate Lifecycle

| Stage | Action | Tool |
|---|---|---|
| Generation | Create CSR | `openssl req` or `cfssl` |
| Signing | Sign with CA | Internal CA or ACME |
| Distribution | Deploy to nodes | Ansible, Vault, K8s secrets |
| Monitoring | Track expiry | Prometheus `probe_ssl_earliest_cert_expiry` |
| Renewal | Auto-renew before expiry | cert-manager, ACME |
| Revocation | CRL or OCSP | CA management tool |

### 4.3 Automated Renewal with cert-manager (Kubernetes)

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: 0xscada-tls
spec:
  secretName: 0xscada-tls-secret
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - scada.your-company.com
  renewBefore: 720h  # 30 days
```

### 4.4 Certificate Expiry Alerting

```yaml
# Prometheus alert
- alert: CertificateExpiringSoon
  expr: probe_ssl_earliest_cert_expiry - time() < 30 * 24 * 3600
  for: 1h
  labels:
    severity: warning
  annotations:
    summary: "Certificate expires in < 30 days"
```

---

## 5. Audit Logging

### 5.1 What Gets Logged

| Category | Events |
|---|---|
| Authentication | Login, logout, failed attempts, key creation/revocation |
| Authorization | Access denied, privilege escalation |
| Data Access | Tag reads/writes, alarm acknowledgements |
| Configuration | Settings changes, user management, gateway config |
| System | Service start/stop, migration, deployment |
| Blockchain | Anchor creation, verification |

### 5.2 Audit Log Format

```json
{
  "timestamp": "2026-02-14T22:15:00.000Z",
  "level": "info",
  "category": "auth",
  "action": "login.success",
  "actor": {
    "type": "user",
    "id": "user-123",
    "name": "john.doe",
    "ip": "10.0.1.50",
    "userAgent": "0xscada-cli/1.0.0"
  },
  "resource": {
    "type": "session",
    "id": "sess-456"
  },
  "details": {
    "method": "api-key",
    "scopes": ["read:tags", "read:alarms"]
  },
  "result": "success"
}
```

### 5.3 Log Destinations

Configure multiple outputs:

```json
{
  "audit": {
    "enabled": true,
    "destinations": [
      { "type": "file", "path": "/var/log/0xscada/audit.log", "rotation": "daily" },
      { "type": "syslog", "host": "siem.your-company.com", "port": 514 },
      { "type": "elasticsearch", "url": "https://es.your-company.com", "index": "0xscada-audit" }
    ],
    "retention": "365d",
    "immutable": true
  }
}
```

### 5.4 Log Integrity

- Audit logs are append-only (immutable flag)
- Hash chain: each entry includes SHA-256 of previous entry
- Periodic blockchain anchoring of log hashes for tamper evidence
- `0xscada anchor create --data <log-hash>` for manual anchoring

---

## 6. Hardening Checklist

### 6.1 Network

- [ ] TLS 1.2+ on all endpoints
- [ ] mTLS for gateway connections
- [ ] Network segmentation (SCADA on isolated VLAN)
- [ ] Firewall rules: allow only required ports
- [ ] Rate limiting enabled
- [ ] WebSocket connections authenticated

### 6.2 Application

- [ ] Default admin password changed
- [ ] MFA enabled for admin accounts
- [ ] API keys use minimum-required scopes
- [ ] CORS restricted to known origins
- [ ] Content Security Policy headers set
- [ ] Input validation on all endpoints
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (output encoding)

### 6.3 Infrastructure

- [ ] Run as non-root user
- [ ] Read-only filesystem where possible
- [ ] Container image scanning (Trivy, Snyk)
- [ ] Secrets in vault (not environment variables in compose files)
- [ ] Regular dependency updates
- [ ] Backup encryption at rest

### 6.4 Monitoring

- [ ] Failed auth attempts alerting
- [ ] Anomalous API usage detection
- [ ] Certificate expiry monitoring
- [ ] Audit log integrity verification
- [ ] Regular penetration testing schedule

---

## 7. Incident Response

### 7.1 Compromised API Key

1. Immediately revoke: `0xscada auth revoke-key <id>`
2. Review audit logs for unauthorized access
3. Rotate all keys that may share the same secret store
4. Notify affected stakeholders
5. Document and update procedures

### 7.2 Compromised Gateway Certificate

1. Add certificate to CRL
2. Restart gateway with new certificate
3. Review gateway audit logs
4. Check for unauthorized tag writes
5. Verify data integrity via blockchain anchors
