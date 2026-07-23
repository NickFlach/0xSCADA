# 0xSCADA CLI

Command-line interface for 0xSCADA development and operations.

## Installation

### From the repository

```bash
cd cli
npm install
npm run build
npm link  # Optional: makes '0xscada' available globally
```

### Direct usage (without installing)

```bash
cd cli
npm install
npm run dev -- status
# or
node dist/index.js status
```

## Quick Start

```bash
# Check system health
0xscada status

# List sites and assets
0xscada sites list
0xscada assets list

# View recent events
0xscada events list --limit 10

# Start development environment
0xscada dev start
```

## Commands

### `0xscada status`

Show system health including database, blockchain, and services.

```bash
0xscada status
0xscada status --json  # Output as JSON
```

### `0xscada sites`

Manage registered SCADA sites.

```bash
# List all sites
0xscada sites list

# Get site details
0xscada sites get <site-id>
0xscada sites get <site-id> --with-assets  # Include assets

# Create a new site
0xscada sites create --name "Plant A" --location "Building 1" --owner "0x..."
```

### `0xscada assets`

Manage registered assets.

```bash
# List all assets
0xscada assets list

# Filter by site or type
0xscada assets list --site <site-id>
0xscada assets list --type PLC
0xscada assets list --critical  # Only critical assets

# Get asset details
0xscada assets get <asset-id>

# Create a new asset
0xscada assets create --site <site-id> --name "PLC-001" --type "PLC" --critical
```

### `0xscada events`

Manage and view event anchors.

```bash
# List recent events
0xscada events list
0xscada events list --page 2 --limit 20
0xscada events list --type "ALARM"
0xscada events list --anchored   # Only blockchain-anchored events
0xscada events list --pending    # Events pending anchoring

# View batch anchoring statistics
0xscada events stats

# Manually trigger batch anchoring
0xscada events anchor

# Create a new event
0xscada events create \
  --asset <asset-id> \
  --type "SENSOR_READING" \
  --payload '{"temperature": 25.5, "unit": "celsius"}'
```

### `0xscada blockchain`

Blockchain status and information.

```bash
# Show blockchain connection status
0xscada blockchain info
0xscada blockchain status  # Alias for 'info'
```

### `0xscada dev`

Development environment commands.

```bash
# Start local development environment
0xscada dev start
0xscada dev start --port 3000
0xscada dev start --no-blockchain  # Skip blockchain node

# Seed database with test data
0xscada dev seed
0xscada dev seed --force  # Re-seed even if already seeded

# Check development prerequisites
0xscada dev check
```

### `0xscada config`

Manage CLI configuration.

```bash
# Show current configuration
0xscada config show

# Set configuration values
0xscada config set apiUrl http://localhost:3000
0xscada config set timeout 60000
0xscada config set colorOutput false

# Get a specific value
0xscada config get apiUrl

# List available configuration keys
0xscada config keys

# Show configuration file paths
0xscada config paths
```

## Global Options

All commands support these options:

| Option | Description |
|--------|-------------|
| `--json` | Output results as JSON for scripting |
| `--no-color` | Disable colorized terminal output |
| `-h, --help` | Display help for the command |
| `-v, --version` | Display CLI version |

## Configuration

### Configuration File

Create a `0xscada.config.json` file in your project directory or `~/.0xscada.config.json` in your home directory:

```json
{
  "apiUrl": "http://localhost:5000",
  "timeout": 30000,
  "colorOutput": true,
  "jsonOutput": false
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OXSCADA_API_URL` | API server URL | `http://localhost:5000` |
| `OXSCADA_TIMEOUT` | Request timeout (ms) | `30000` |
| `OXSCADA_NO_COLOR` | Disable color output | - |
| `NO_COLOR` | Standard no-color flag | - |
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `BLOCKCHAIN_RPC_URL` | Ethereum RPC endpoint | `http://127.0.0.1:8545` |
| `BLOCKCHAIN_PRIVATE_KEY` | Wallet private key | Optional |

## Scripting

The CLI supports JSON output for easy integration with scripts:

```bash
# Get sites as JSON
sites=$(0xscada sites list --json)

# Parse with jq
echo "$sites" | jq '.[0].name'

# Use in a script
if 0xscada status --json | jq -e '.health.status == "healthy"' > /dev/null; then
  echo "System is healthy"
fi
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch

# Run in development mode
npm run dev -- status

# Type check
npm run lint

# Run tests
npm test
```

## License

MIT
