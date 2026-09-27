// Additional tests loaded by tests/crypto.integration.ts through a Go test overlay.
// They never enter the SDK binary. The big.Int oracle is deliberately variable
// time and used only for public deterministic test inputs.
package poly1305

import (
	"bytes"
	"math/big"
	"math/rand"
	"testing"
)

// bigPoly1305 follows the integer definition, independently of both limb-based
// implementations: H = (H + block + 2^(8*len(block))) * r mod (2^130-5).
func bigPoly1305(msg []byte, key *[32]byte) [16]byte {
	little := func(b []byte) *big.Int {
		reversed := append([]byte(nil), b...)
		for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
			reversed[i], reversed[j] = reversed[j], reversed[i]
		}
		return new(big.Int).SetBytes(reversed)
	}
	rBytes := *key
	for _, i := range []int{3, 7, 11, 15} {
		rBytes[i] &= 15
	}
	for _, i := range []int{4, 8, 12} {
		rBytes[i] &= 252
	}
	r := little(rBytes[:16])
	p := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 130), big.NewInt(5))
	h := new(big.Int)
	for len(msg) > 0 {
		n := min(16, len(msg))
		block := little(msg[:n])
		block.Add(block, new(big.Int).Lsh(big.NewInt(1), uint(8*n)))
		h.Add(h, block).Mul(h, r).Mod(h, p)
		msg = msg[n:]
	}
	h.Add(h, little(key[16:]))
	h.Mod(h, new(big.Int).Lsh(big.NewInt(1), 128))
	var out [16]byte
	encoded := h.Bytes()
	for i := range encoded {
		out[i] = encoded[len(encoded)-1-i]
	}
	return out
}

func TestDonnaDifferential(t *testing.T) {
	rng := rand.New(rand.NewSource(0x1305))
	lengths := []int{0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255, 256, 257, 8191, 8192, 8193, 32767, 32768, 65535, 65536}
	for i := 0; i < 512; i++ {
		n := rng.Intn(4097)
		if i < len(lengths) {
			n = lengths[i]
		}
		msg := make([]byte, n)
		var key [32]byte
		rng.Read(msg)
		rng.Read(key[:])
		if i%3 == 0 {
			for j := range key {
				key[j] = 255
			}
			for j := range msg {
				msg[j] = 255
			}
		}
		var got, reference [16]byte
		Sum(&got, msg, &key)
		sumGeneric(&reference, msg, &key)
		if got != reference {
			t.Fatalf("case %d length %d: Donna %x != generic %x", i, n, got, reference)
		}
		// Include long inputs as well as partial blocks in the independent oracle.
		if i < len(lengths) || i%8 == 0 {
			if expected := bigPoly1305(msg, &key); got != expected {
				t.Fatalf("case %d length %d: Donna %x != integer oracle %x", i, n, got, expected)
			}
		}
		h := New(&key)
		for offset := 0; offset < len(msg); {
			h.Write(nil)
			end := min(len(msg), offset+1+rng.Intn(97))
			h.Write(msg[offset:end])
			offset = end
		}
		if tag := h.Sum(nil); !bytes.Equal(tag, reference[:]) {
			t.Fatalf("case %d: segmented writes changed tag", i)
		}
	}
}

func TestDonnaEveryShortSplit(t *testing.T) {
	var key [32]byte
	for i := range key {
		key[i] = 255
	}
	for n := 0; n <= 64; n++ {
		msg := bytes.Repeat([]byte{255}, n)
		want := bigPoly1305(msg, &key)
		for split := 0; split <= n; split++ {
			h := New(&key)
			h.Write(msg[:split])
			h.Write(nil)
			h.Write(msg[split:])
			if !bytes.Equal(h.Sum(nil), want[:]) {
				t.Fatalf("length %d split %d", n, split)
			}
		}
	}
}

func TestDonnaFinalizationContract(t *testing.T) {
	var key [32]byte
	key[0], key[16] = 7, 9
	for _, n := range []int{0, 1, 15, 16, 17, 32} {
		msg := bytes.Repeat([]byte{42}, n)
		want := bigPoly1305(msg, &key)
		for _, verifyFirst := range []bool{false, true} {
			h := New(&key)
			h.Write(msg)
			if verifyFirst && !h.Verify(want[:]) {
				t.Fatal("Verify failed")
			}
			prefix := []byte{11, 22, 33}
			out := h.Sum(append([]byte(nil), prefix...))
			if !bytes.Equal(out, append(prefix, want[:]...)) || !bytes.Equal(h.Sum(nil), want[:]) {
				t.Fatal("Sum changed the prefix or was not repeatable")
			}
			if !h.Verify(want[:]) || h.Verify(want[:15]) || h.Verify(append(want[:], 0)) {
				t.Fatal("Verify accepted the wrong length or changed state")
			}
			func() {
				defer func() {
					if recover() == nil {
						t.Fatal("Write after finalization did not panic")
					}
				}()
				h.Write(nil)
			}()
		}
	}
}
