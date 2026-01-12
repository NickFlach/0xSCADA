# Keeper - geth as a zkvm guest

Keeper command is a specialized tool for validating stateless execution of Ethereum blocks. It's designed to run as a zkvm guest.

## Overview

The keeper reads an RLP-encoded payload containing:
- A block to execute
- A witness with the necessary state data
- A chainID

It then executes the block statelessly and validates that the computed state root and receipt root match the values in the block header.

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | ExitSuccess | Block validated successfully |
| 10 | ExitStatelessFailed | Stateless execution failed |
| 11 | ExitStateRootMismatch | Computed state root doesn't match block header |
| 12 | ExitReceiptRootMismatch | Computed receipt root doesn't match block header |
| 13 | ExitUnknownChainID | Unknown or unsupported chain ID |
| 14 | ExitInvalidInput | Input validation failed (nil, empty, too large, not RLP list) |
| 15 | ExitDecodeFailed | RLP decoding failed |
| 16 | ExitValidationFailed | Payload semantic validation failed |

## Input Validation

The keeper performs multiple layers of input validation:

1. **Bounds checking**: Input cannot be nil, empty, or exceed 100 MB
2. **RLP prefix check**: Input must be an RLP list (prefix >= 0xc0)
3. **Semantic validation**: ChainID must be non-zero, block and witness must be non-nil

## Security

For detailed security considerations and trust assumptions, see [TRUST_ASSUMPTIONS.md](./TRUST_ASSUMPTIONS.md).

## Building Keeper

The keeper uses build tags to compile platform-specific input methods and chain configurations:

### Example Implementation

See `getpayload_example.go` for a complete example with embedded Hoodi block data:

```bash
# Build example with different chain configurations
go build -tags "example" ./cmd/keeper
```

### Ziren zkVM Implementation

Build for the Ziren zkVM platform, which is a MIPS ISA-based zkvm:

```bash
GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -tags "ziren" ./cmd/keeper
```

As an example runner, refer to https://gist.github.com/gballet/7b669a99eb3ab2b593324e3a76abd23d

## Creating a Custom Platform Implementation

To add support for a new platform (e.g., "myplatform"), create a new file with the appropriate build tag:

### 1. Create `getinput_myplatform.go`

```go
//go:build myplatform

package main

import (
    "github.com/ethereum/go-ethereum/params"
    // ... other imports as needed
)

// getInput returns the RLP-encoded payload
func getInput() []byte {
    // Your platform-specific code to retrieve the RLP-encoded payload
    // This might read from:
    // - Memory-mapped I/O
    // - Hardware registers
    // - Serial port
    // - Network interface
    // - File system

    // The payload must be RLP-encoded and contain:
    // - Block with transactions
    // - Witness with parent headers and state data

    return encodedPayload
}
```
