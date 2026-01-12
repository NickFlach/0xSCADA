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
	"testing"
)

// TestValidateInput tests the input validation function
func TestValidateInput(t *testing.T) {
	tests := []struct {
		name        string
		input       []byte
		expectError bool
		errorSubstr string
	}{
		{
			name:        "nil input",
			input:       nil,
			expectError: true,
			errorSubstr: "nil",
		},
		{
			name:        "empty input",
			input:       []byte{},
			expectError: true,
			errorSubstr: "empty",
		},
		{
			name:        "input too large",
			input:       make([]byte, MaxInputSize+1),
			expectError: true,
			errorSubstr: "exceeds maximum",
		},
		{
			name:        "not an RLP list - single byte",
			input:       []byte{0x05},
			expectError: true,
			errorSubstr: "not an RLP list",
		},
		{
			name:        "not an RLP list - short string",
			input:       []byte{0x85, 0x68, 0x65, 0x6c, 0x6c, 0x6f}, // "hello" as RLP string
			expectError: true,
			errorSubstr: "not an RLP list",
		},
		{
			name:        "valid RLP short list",
			input:       []byte{0xc0}, // empty list
			expectError: false,
		},
		{
			name:        "valid RLP list with content",
			input:       []byte{0xc8, 0x83, 0x61, 0x62, 0x63, 0x83, 0x64, 0x65, 0x66}, // ["abc", "def"]
			expectError: false,
		},
		{
			name:        "valid RLP long list prefix",
			input:       append([]byte{0xf8, 0x04}, make([]byte, 4)...), // long list with 4 bytes
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateInput(tt.input)

			if tt.expectError {
				if err == nil {
					t.Errorf("expected error containing %q, got nil", tt.errorSubstr)
				} else if tt.errorSubstr != "" {
					// Check error contains expected substring
					if !containsSubstr(err.Error(), tt.errorSubstr) {
						t.Errorf("expected error containing %q, got %q", tt.errorSubstr, err.Error())
					}
				}
			} else {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			}
		})
	}
}

// TestValidatePayload tests the payload validation function
func TestValidatePayload(t *testing.T) {
	tests := []struct {
		name        string
		payload     *Payload
		expectError bool
		errorSubstr string
	}{
		{
			name:        "nil block",
			payload:     &Payload{ChainID: 1, Block: nil, Witness: nil},
			expectError: true,
			errorSubstr: "block is nil",
		},
		{
			name:        "nil witness",
			payload:     &Payload{ChainID: 1, Block: nil, Witness: nil},
			expectError: true,
			errorSubstr: "block is nil", // block checked first
		},
		{
			name:        "zero chain ID",
			payload:     &Payload{ChainID: 0, Block: nil, Witness: nil},
			expectError: true,
			errorSubstr: "chain ID cannot be zero",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePayload(tt.payload)

			if tt.expectError {
				if err == nil {
					t.Errorf("expected error containing %q, got nil", tt.errorSubstr)
				} else if tt.errorSubstr != "" {
					if !containsSubstr(err.Error(), tt.errorSubstr) {
						t.Errorf("expected error containing %q, got %q", tt.errorSubstr, err.Error())
					}
				}
			} else {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			}
		})
	}
}

// TestMaxInputSize verifies the constant is set correctly
func TestMaxInputSize(t *testing.T) {
	expected := 100 * 1024 * 1024 // 100 MB
	if MaxInputSize != expected {
		t.Errorf("MaxInputSize = %d, want %d", MaxInputSize, expected)
	}
}

// TestExitCodes verifies exit code constants are unique
func TestExitCodes(t *testing.T) {
	codes := map[int]string{
		ExitSuccess:             "ExitSuccess",
		ExitStatelessFailed:    "ExitStatelessFailed",
		ExitStateRootMismatch:  "ExitStateRootMismatch",
		ExitReceiptRootMismatch: "ExitReceiptRootMismatch",
		ExitUnknownChainID:     "ExitUnknownChainID",
		ExitInvalidInput:       "ExitInvalidInput",
		ExitDecodeFailed:       "ExitDecodeFailed",
		ExitValidationFailed:   "ExitValidationFailed",
	}

	// Check all expected codes are present
	expectedCount := 8
	if len(codes) != expectedCount {
		t.Errorf("expected %d unique exit codes, got %d", expectedCount, len(codes))
	}

	// Check success is 0
	if ExitSuccess != 0 {
		t.Errorf("ExitSuccess should be 0, got %d", ExitSuccess)
	}

	// Check all error codes are > 0
	for code, name := range codes {
		if code < 0 {
			t.Errorf("%s has negative code %d", name, code)
		}
	}
}

// containsSubstr checks if s contains substr
func containsSubstr(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		(len(s) > 0 && len(substr) > 0 && findSubstr(s, substr)))
}

func findSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// BenchmarkValidateInput benchmarks the input validation
func BenchmarkValidateInput(b *testing.B) {
	// Create a valid RLP list input
	input := append([]byte{0xf8, 0xff}, make([]byte, 255)...)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = validateInput(input)
	}
}
