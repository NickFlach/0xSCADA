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

package crypto

import (
        "bytes"
        "encoding/hex"
        "testing"
)

// TestKeccak256StandardVectors verifies that our Keccak256 implementation
// produces output matching well-known Keccak256 test vectors.
// These vectors are verified against the Ethereum ecosystem implementations.
func TestKeccak256StandardVectors(t *testing.T) {
        // These are verified Keccak256 test vectors from Ethereum implementations
        tests := []struct {
                name     string
                input    string // hex-encoded input
                expected string // hex-encoded expected output (verified)
        }{
                {
                        name:     "empty input",
                        input:    "",
                        expected: "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
                },
                {
                        name:     "single byte 0x00",
                        input:    "00",
                        expected: "bc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a",
                },
                {
                        name:     "single byte 0xff",
                        input:    "ff",
                        expected: "8b1a944cf13a9a1c08facb2c9e98623ef3254d2ddb48113885c3e8e97fec8db9",
                },
                {
                        name:     "hello",
                        input:    "68656c6c6f", // "hello"
                        expected: "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8",
                },
                {
                        name:     "32 bytes of zeros",
                        input:    "0000000000000000000000000000000000000000000000000000000000000000",
                        expected: "290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563",
                },
                {
                        name:     "32 bytes of ones",
                        input:    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                        expected: "a9c584056064687e149968cbab758a3376d22aedc6a55823d1b3ecbee81b8fb9",
                },
        }

        for _, tt := range tests {
                t.Run(tt.name, func(t *testing.T) {
                        input, err := hex.DecodeString(tt.input)
                        if err != nil {
                                t.Fatalf("failed to decode input: %v", err)
                        }

                        result := Keccak256(input)
                        resultHex := hex.EncodeToString(result)

                        // Assert the hash matches expected value
                        if resultHex != tt.expected {
                                t.Errorf("Keccak256(%s) = %s, want %s", tt.input, resultHex, tt.expected)
                        }

                        // Also verify hash length
                        if len(result) != 32 {
                                t.Errorf("expected 32-byte hash, got %d bytes", len(result))
                        }
                })
        }
}

// TestKeccak256KnownVectors tests against well-known Keccak256 vectors
// that are commonly used in Ethereum implementations.
func TestKeccak256KnownVectors(t *testing.T) {
        tests := []struct {
                input    []byte
                expected string
        }{
                {
                        input:    []byte{},
                        expected: "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
                },
                {
                        input:    []byte("hello"),
                        expected: "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8",
                },
                {
                        input:    []byte("hello world"),
                        expected: "47173285a8d7341e5e972fc677286384f802f8ef42a5ec5f03bbfa254cb01fad",
                },
        }

        for _, tt := range tests {
                result := Keccak256(tt.input)
                resultHex := hex.EncodeToString(result)

                if resultHex != tt.expected {
                        t.Errorf("Keccak256(%q) = %s, want %s", string(tt.input), resultHex, tt.expected)
                }
        }
}

// TestKeccak256MultipleChunks tests hashing with multiple data chunks
func TestKeccak256MultipleChunks(t *testing.T) {
        // Hash of concatenated data should equal hash of individual writes
        chunk1 := []byte("hello")
        chunk2 := []byte(" ")
        chunk3 := []byte("world")

        // Single call with concatenated data
        combined := append(append(chunk1, chunk2...), chunk3...)
        hash1 := Keccak256(combined)

        // Multiple chunks
        hash2 := Keccak256(chunk1, chunk2, chunk3)

        if !bytes.Equal(hash1, hash2) {
                t.Errorf("hash mismatch: single=%x, multi=%x", hash1, hash2)
        }
}

// TestKeccakState tests the stateful hashing interface
func TestKeccakState(t *testing.T) {
        state := NewKeccakState()

        // Write data in chunks
        state.Write([]byte("hello"))
        state.Write([]byte(" "))
        state.Write([]byte("world"))

        // Read the result
        result := make([]byte, 32)
        n, err := state.Read(result)
        if err != nil {
                t.Fatalf("Read failed: %v", err)
        }
        if n != 32 {
                t.Errorf("Read returned %d bytes, want 32", n)
        }

        // Compare with direct hash
        expected := Keccak256([]byte("hello world"))
        if !bytes.Equal(result, expected) {
                t.Errorf("stateful hash mismatch: got=%x, want=%x", result, expected)
        }
}

// TestKeccakStateReset tests that Reset() properly clears state
func TestKeccakStateReset(t *testing.T) {
        state := NewKeccakState()

        // First hash
        state.Write([]byte("hello"))
        result1 := make([]byte, 32)
        state.Read(result1)

        // Reset and hash different data
        state.Reset()
        state.Write([]byte("world"))
        result2 := make([]byte, 32)
        state.Read(result2)

        // Verify different results
        if bytes.Equal(result1, result2) {
                t.Error("Reset did not clear state - hashes should differ")
        }

        // Verify second hash is correct
        expected := Keccak256([]byte("world"))
        if !bytes.Equal(result2, expected) {
                t.Errorf("post-reset hash mismatch: got=%x, want=%x", result2, expected)
        }
}

// TestKeccakStateSize tests Size() and BlockSize() methods
func TestKeccakStateSize(t *testing.T) {
        state := NewKeccakState()

        if state.Size() != 32 {
                t.Errorf("Size() = %d, want 32", state.Size())
        }

        if state.BlockSize() != 136 {
                t.Errorf("BlockSize() = %d, want 136", state.BlockSize())
        }
}

// TestKeccak256HashVariant tests the Hash return variant
func TestKeccak256HashVariant(t *testing.T) {
        hash := Keccak256Hash([]byte("hello"))

        // Verify it's a common.Hash (32 bytes)
        if len(hash) != 32 {
                t.Errorf("Hash length = %d, want 32", len(hash))
        }

        // Verify it matches the slice variant
        expected := Keccak256([]byte("hello"))
        if !bytes.Equal(hash[:], expected) {
                t.Errorf("Keccak256Hash mismatch: got=%x, want=%x", hash, expected)
        }
}

// BenchmarkKeccak256 benchmarks the Keccak256 function
func BenchmarkKeccak256(b *testing.B) {
        data := make([]byte, 1024)
        for i := range data {
                data[i] = byte(i)
        }

        b.ResetTimer()
        for i := 0; i < b.N; i++ {
                Keccak256(data)
        }
}

// BenchmarkKeccakState benchmarks the stateful interface
func BenchmarkKeccakState(b *testing.B) {
        data := make([]byte, 1024)
        for i := range data {
                data[i] = byte(i)
        }

        b.ResetTimer()
        for i := 0; i < b.N; i++ {
                state := NewKeccakState()
                state.Write(data)
                result := make([]byte, 32)
                state.Read(result)
        }
}
