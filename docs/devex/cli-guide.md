# 0xSCADA CLI Guide

The `0xscada` CLI provides a unified command-line interface for development, operations, and monitoring of 0xSCADA systems.

## Installation

```bash
cd cli
npm install
npm run build
npm link  # makes '0xscada' available globally
```

Or run directly during development:

```bash
cd cli
npx tsx src/index.ts <command>
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OXSCADA_API_URL` | API server URL | `http://localhost:5000` |
| `OXSCADA_API_KEY` | API key for authentication | — |
| `OXSCADA_TIMEOUT` | Request timeout (ms) | `30000` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `BLOCKCHAIN_RPC_URL` | Ethereum RPC endpoint | — |
| `BLOCKCHAIN_PRIVATE_KEY` | Wallet private key | — |

### Config File

Create `0xscada.config.json` in the project root or `~/.0xscada.config.json`:

```json
{
  "apiUrl": "http://localhost:5000",
  "apiKey": "your-key-here",
  "defaultOutput": "table"
}
```

## Commands

### System Status

```bash
0xscada status              # System health overview
0xscada status --json       # JSON output
```

### Development

```bash
0xscada dev start           # Start dev environment
0xscada dev start --no-blockchain  # Skip blockchain node
0xscada dev seed            # Seed test data
```

### Gateway Management

```bash
0xscada gateway list                 # List all gateways
0xscada gateway list --status online # Filter by status
0xscada gateway info <gatewayId>     # Detailed info
0xscada gateway restart <gatewayId>  # Restart connection
```

### Tag Operations

```bash
0xscada tags list                    # List all tags
0xscada tags list --gateway <id>     # Filter by gateway
0xscada tags read <tagId>            # Read current value
0xscada tags read <tagId> --raw      # Raw value only (scriptable)
0xscada tags write <tagId> <value>   # Write a value
0xscada tags history <tagId>         # Value history
0xscada tags history <tagId> --from 2026-01-01 --limit 500
```

### Alarm Monitoring

```bash
0xscada alarms list                  # Active alarms
0xscada alarms list --severity critical  # Filter by severity
0xscada alarms summary               # Alarm counts by severity
0xscada alarms ack <alarmId>         # Acknowledge alarm
0xscada alarms clear <alarmId>       # Clear alarm
```

### Database Management

```bash
0xscada db status           # Connection info
0xscada db migrate          # Run pending migrations
0xscada db migrate --dry-run  # Preview migrations
0xscada db seed             # Seed development data
0xscada db seed --reset     # Reset & re-seed
```

### Sites & Assets

```bash
0xscada sites list          # List registered sites
0xscada sites get <id>      # Site details
0xscada assets list         # List all assets
```

### Blockchain

```bash
0xscada blockchain info     # Blockchain status
0xscada anchor create --data <hash>  # Create anchor
0xscada anchor verify <id>  # Verify anchor
```

### Authentication

```bash
0xscada auth login --key <api-key>
0xscada auth status
0xscada wallet list
0xscada wallet balance
```

### Deployment

```bash
0xscada deploy compose generate   # Docker Compose
0xscada deploy k8s generate       # Kubernetes manifests
```

### Logs & Monitoring

```bash
0xscada logs server               # View server logs
0xscada logs server --follow      # Stream real-time
0xscada watch                     # Watch mode
```

## Output Formats

All list commands support `--json` and `-o <format>`:

```bash
0xscada sites list -o json
0xscada sites list -o yaml
0xscada sites list -o csv
0xscada sites list -o table:rounded
```

Available table themes: `table`, `table:minimal`, `table:ascii`, `table:rounded`, `table:heavy`, `table:double`.

## Shell Mode

```bash
0xscada shell   # Interactive REPL
```

## Tab Completion

```bash
# Bash
0xscada completion bash >> ~/.bashrc

# Zsh
0xscada completion zsh >> ~/.zshrc

# Fish
0xscada completion fish > ~/.config/fish/completions/0xscada.fish
```

## Scripting Examples

```bash
# Check if any critical alarms exist
if 0xscada alarms list --severity critical --json | jq -e '.[] | length > 0'; then
  echo "CRITICAL ALARMS ACTIVE"
fi

# Read a tag value into a variable
TEMP=$(0xscada tags read TANK1_TEMP --raw)

# Export all tags to CSV
0xscada tags list -o csv > tags_export.csv

# Monitor gateway status
watch -n 5 '0xscada gateway list --json | jq ".[] | {name, status}"'
```

## Testing

```bash
cd cli
npm test              # Run tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```
