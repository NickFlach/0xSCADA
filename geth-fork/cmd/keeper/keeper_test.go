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

//go:build example

package main

import (
	"bytes"
	"os"
	"testing"

	"github.com/ethereum/go-ethereum/core/stateless"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rlp"
)

// TestPayloadDecoding tests that RLP-encoded payloads can be properly decoded
func TestPayloadDecoding(t *testing.T) {
	tests := []struct {
		name        string
		input       []byte
		expectError bool
		errorMsg    string
	}{
		{
			name:        "empty input",
			input:       []byte{},
			expectError: true,
			errorMsg:    "empty payload",
		},
		{
			name:        "nil input",
			input:       nil,
			expectError: true,
			errorMsg:    "nil payload",
		},
		{
			name:        "invalid RLP - truncated",
			input:       []byte{0xf9, 0x01, 0x00}, // claims 256 bytes but only 3 present
			expectError: true,
			errorMsg:    "truncated RLP",
		},
		{
			name:        "invalid RLP - bad prefix",
			input:       []byte{0xff, 0xff, 0xff},
			expectError: true,
			errorMsg:    "invalid RLP prefix",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var payload Payload
			err := DecodePayloadSafe(tt.input, &payload)

			if tt.expectError {
				if err == nil {
					t.Errorf("expected error for %s, got nil", tt.name)
				}
			} else {
				if err != nil {
					t.Errorf("unexpected error for %s: %v", tt.name, err)
				}
			}
		})
	}
}

// TestPayloadRoundTrip tests that a payload can be encoded and decoded
func TestPayloadRoundTrip(t *testing.T) {
	// Create a minimal valid payload for testing
	// In real usage, this would come from test fixtures
	block := types.NewBlockWithHeader(&types.Header{})
	witness := &stateless.Witness{}

	original := Payload{
		ChainID: 1,
		Block:   block,
		Witness: witness,
	}

	// Encode
	encoded, err := rlp.EncodeToBytes(original)
	if err != nil {
		t.Fatalf("failed to encode payload: %v", err)
	}

	// Decode
	var decoded Payload
	err = rlp.DecodeBytes(encoded, &decoded)
	if err != nil {
		t.Fatalf("failed to decode payload: %v", err)
	}

	// Verify ChainID matches
	if decoded.ChainID != original.ChainID {
		t.Errorf("ChainID mismatch: got %d, want %d", decoded.ChainID, original.ChainID)
	}
}

// TestInputValidation tests various input validation scenarios
func TestInputValidation(t *testing.T) {
	tests := []struct {
		name     string
		chainID  uint64
		hasBlock bool
		hasWit   bool
		wantErr  bool
	}{
		{
			name:     "valid payload",
			chainID:  1,
			hasBlock: true,
			hasWit:   true,
			wantErr:  false,
		},
		{
			name:     "zero chain ID",
			chainID:  0,
			hasBlock: true,
			hasWit:   true,
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePayload(tt.chainID, tt.hasBlock, tt.hasWit)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidatePayload() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// TestChainConfigLookup tests chain configuration retrieval
func TestChainConfigLookup(t *testing.T) {
	tests := []struct {
		chainID uint64
		wantErr bool
	}{
		{chainID: 1, wantErr: false},    // mainnet
		{chainID: 17000, wantErr: false}, // holesky
		{chainID: 99999, wantErr: true},  // unknown
	}

	for _, tt := range tests {
		t.Run("chainID_"+string(rune(tt.chainID)), func(t *testing.T) {
			_, err := getChainConfig(tt.chainID)
			if (err != nil) != tt.wantErr {
				t.Errorf("getChainConfig(%d) error = %v, wantErr %v", tt.chainID, err, tt.wantErr)
			}
		})
	}
}

// TestExamplePayloadLoading tests loading the example RLP files
func TestExamplePayloadLoading(t *testing.T) {
	// Check if example files exist
	blockPath := "1192c3_block.rlp"
	witnessPath := "1192c3_witness.rlp"

	if _, err := os.Stat(blockPath); os.IsNotExist(err) {
		t.Skip("example block file not found")
	}
	if _, err := os.Stat(witnessPath); os.IsNotExist(err) {
		t.Skip("example witness file not found")
	}

	blockData, err := os.ReadFile(blockPath)
	if err != nil {
		t.Fatalf("failed to read block file: %v", err)
	}

	witnessData, err := os.ReadFile(witnessPath)
	if err != nil {
		t.Fatalf("failed to read witness file: %v", err)
	}

	// Verify files are not empty
	if len(blockData) == 0 {
		t.Error("block file is empty")
	}
	if len(witnessData) == 0 {
		t.Error("witness file is empty")
	}

	// Try to decode block
	var block types.Block
	err = rlp.DecodeBytes(blockData, &block)
	if err != nil {
		t.Errorf("failed to decode block: %v", err)
	}

	// Try to decode witness
	var witness stateless.Witness
	err = rlp.DecodeBytes(witnessData, &witness)
	if err != nil {
		t.Errorf("failed to decode witness: %v", err)
	}
}

// DecodePayloadSafe decodes a payload with additional input validation
func DecodePayloadSafe(input []byte, payload *Payload) error {
	if input == nil {
		return &ValidationError{msg: "nil payload"}
	}
	if len(input) == 0 {
		return &ValidationError{msg: "empty payload"}
	}
	if len(input) < 3 {
		return &ValidationError{msg: "payload too short"}
	}

	// Check for valid RLP prefix
	firstByte := input[0]
	if firstByte < 0x80 {
		// Single byte, valid but probably not a payload
	} else if firstByte < 0xb8 {
		// Short string
	} else if firstByte < 0xc0 {
		// Long string
	} else if firstByte < 0xf8 {
		// Short list - expected for payload
	} else {
		// Long list - expected for payload
		// Validate length prefix
		lenBytes := int(firstByte - 0xf7)
		if len(input) < 1+lenBytes {
			return &ValidationError{msg: "truncated length prefix"}
		}
	}

	return rlp.DecodeBytes(input, payload)
}

// ValidatePayload validates payload fields
func ValidatePayload(chainID uint64, hasBlock, hasWitness bool) error {
	if chainID == 0 {
		return &ValidationError{msg: "chain ID cannot be zero"}
	}
	if !hasBlock {
		return &ValidationError{msg: "block is required"}
	}
	if !hasWitness {
		return &ValidationError{msg: "witness is required"}
	}
	return nil
}

// ValidationError represents a validation error
type ValidationError struct {
	msg string
}

func (e *ValidationError) Error() string {
	return e.msg
}

// BenchmarkPayloadDecode benchmarks payload decoding
func BenchmarkPayloadDecode(b *testing.B) {
	// Create a test payload
	block := types.NewBlockWithHeader(&types.Header{})
	witness := &stateless.Witness{}
	payload := Payload{
		ChainID: 1,
		Block:   block,
		Witness: witness,
	}

	encoded, err := rlp.EncodeToBytes(payload)
	if err != nil {
		b.Fatalf("failed to encode: %v", err)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var decoded Payload
		_ = rlp.DecodeBytes(bytes.Clone(encoded), &decoded)
	}
}
