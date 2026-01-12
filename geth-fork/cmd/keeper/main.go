// Copyright 2025 The go-ethereum Authors
// This file is part of the go-ethereum library.
//
// The go-ethereum library is free software: you can redistribute it and/or modify
// it under the terms of the GNU Lesser General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// The go-ethereum library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public License
// along with the go-ethereum library. If not, see <http://www.gnu.org/licenses/>.

package main

import (
        "fmt"
        "os"
        "runtime/debug"

        "github.com/ethereum/go-ethereum/core"
        "github.com/ethereum/go-ethereum/core/stateless"
        "github.com/ethereum/go-ethereum/core/types"
        "github.com/ethereum/go-ethereum/core/vm"
        "github.com/ethereum/go-ethereum/rlp"
)

// Exit codes for different error conditions
const (
        ExitSuccess            = 0
        ExitStatelessFailed    = 10
        ExitStateRootMismatch  = 11
        ExitReceiptRootMismatch = 12
        ExitUnknownChainID     = 13
        ExitInvalidInput       = 14
        ExitDecodeFailed       = 15
        ExitValidationFailed   = 16
)

// MaxInputSize is the maximum allowed input size (100 MB)
const MaxInputSize = 100 * 1024 * 1024

// Payload represents the input data for stateless execution containing
// a block and its associated witness data for verification.
type Payload struct {
        ChainID uint64
        Block   *types.Block
        Witness *stateless.Witness
}

func init() {
        debug.SetGCPercent(-1) // Disable garbage collection
}

// validateInput performs bounds checking and basic validation on the raw input
func validateInput(input []byte) error {
        if input == nil {
                return fmt.Errorf("input is nil")
        }
        if len(input) == 0 {
                return fmt.Errorf("input is empty")
        }
        if len(input) > MaxInputSize {
                return fmt.Errorf("input exceeds maximum size (%d > %d)", len(input), MaxInputSize)
        }
        // Check for valid RLP encoding prefix
        firstByte := input[0]
        if firstByte < 0xc0 {
                // Not a list - payloads must be RLP lists
                return fmt.Errorf("input is not an RLP list (prefix: 0x%02x)", firstByte)
        }
        return nil
}

// validatePayload performs semantic validation on the decoded payload
func validatePayload(payload *Payload) error {
        if payload.ChainID == 0 {
                return fmt.Errorf("chain ID cannot be zero")
        }
        if payload.Block == nil {
                return fmt.Errorf("block is nil")
        }
        if payload.Witness == nil {
                return fmt.Errorf("witness is nil")
        }
        // Additional block header validation
        header := payload.Block.Header()
        if header == nil {
                return fmt.Errorf("block header is nil")
        }
        return nil
}

func main() {
        input := getInput()

        // Step 1: Validate raw input
        if err := validateInput(input); err != nil {
                fmt.Fprintf(os.Stderr, "input validation failed: %v\n", err)
                os.Exit(ExitInvalidInput)
        }

        // Step 2: Decode RLP payload
        var payload Payload
        if err := rlp.DecodeBytes(input, &payload); err != nil {
                fmt.Fprintf(os.Stderr, "failed to decode payload: %v\n", err)
                os.Exit(ExitDecodeFailed)
        }

        // Step 3: Validate decoded payload
        if err := validatePayload(&payload); err != nil {
                fmt.Fprintf(os.Stderr, "payload validation failed: %v\n", err)
                os.Exit(ExitValidationFailed)
        }

        // Step 4: Get chain configuration
        chainConfig, err := getChainConfig(payload.ChainID)
        if err != nil {
                fmt.Fprintf(os.Stderr, "failed to get chain config: %v\n", err)
                os.Exit(ExitUnknownChainID)
        }
        vmConfig := vm.Config{}

        // Step 5: Execute stateless validation
        crossStateRoot, crossReceiptRoot, err := core.ExecuteStateless(chainConfig, vmConfig, payload.Block, payload.Witness)
        if err != nil {
                fmt.Fprintf(os.Stderr, "stateless self-validation failed: %v\n", err)
                os.Exit(ExitStatelessFailed)
        }

        // Step 6: Verify state root
        if crossStateRoot != payload.Block.Root() {
                fmt.Fprintf(os.Stderr, "stateless self-validation root mismatch (cross: %x local: %x)\n", crossStateRoot, payload.Block.Root())
                os.Exit(ExitStateRootMismatch)
        }

        // Step 7: Verify receipt root
        if crossReceiptRoot != payload.Block.ReceiptHash() {
                fmt.Fprintf(os.Stderr, "stateless self-validation receipt root mismatch (cross: %x local: %x)\n", crossReceiptRoot, payload.Block.ReceiptHash())
                os.Exit(ExitReceiptRootMismatch)
        }

        // Success - block validated
        os.Exit(ExitSuccess)
}
