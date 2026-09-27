package main

import (
	"encoding/binary"
	"fmt"
	"testing"

	"golang.org/x/crypto/chacha20"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/poly1305"
)

var cryptoBenchmarkSink byte

// donna32 is a direct port of the public-domain poly1305-donna-32
// implementation (Andrew Moon). Its 26-bit limbs keep every product within
// 32x32->64 bits, which wasm executes natively (i64.mul), while the generic
// x/crypto implementation relies on bits.Mul64's 128-bit products that the
// wasm port must emulate. Benchmark-only prototype; validated against
// x/crypto below.
type donna32 struct {
	r0, r1, r2, r3, r4 uint32
	s1, s2, s3, s4     uint32
	h0, h1, h2, h3, h4 uint32
	pad                [4]uint32
	buffer             [16]byte
	leftover           int
	final              bool
}

func le32(b []byte) uint32 { return binary.LittleEndian.Uint32(b) }

func (d *donna32) init(key *[32]byte) {
	d.r0 = le32(key[0:4]) & 0x3ffffff
	d.r1 = (le32(key[3:7]) >> 2) & 0x3ffff03
	d.r2 = (le32(key[6:10]) >> 4) & 0x3ffc0ff
	d.r3 = (le32(key[9:13]) >> 6) & 0x3f03fff
	d.r4 = (le32(key[12:16]) >> 8) & 0x00fffff
	d.s1 = d.r1 * 5
	d.s2 = d.r2 * 5
	d.s3 = d.r3 * 5
	d.s4 = d.r4 * 5
	d.pad = [4]uint32{
		le32(key[16:20]),
		le32(key[20:24]),
		le32(key[24:28]),
		le32(key[28:32]),
	}
}

func (d *donna32) blocks(m []byte) {
	hibit := uint32(0)
	if !d.final {
		hibit = 1 << 24 // 1 << 128 for every block but the final one
	}
	for len(m) >= 16 {
		h0 := d.h0 + le32(m[0:4])&0x3ffffff
		h1 := d.h1 + (le32(m[3:7])>>2)&0x3ffffff
		h2 := d.h2 + (le32(m[6:10])>>4)&0x3ffffff
		h3 := d.h3 + (le32(m[9:13])>>6)&0x3ffffff
		h4 := d.h4 + ((le32(m[12:16]) >> 8) | hibit)

		// h *= r, with 5*r limbs precomputed to fold the radix reduction.
		d0 := uint64(h0)*uint64(d.r0) + uint64(h1)*uint64(d.s4) + uint64(h2)*uint64(d.s3) + uint64(h3)*uint64(d.s2) + uint64(h4)*uint64(d.s1)
		d1 := uint64(h0)*uint64(d.r1) + uint64(h1)*uint64(d.r0) + uint64(h2)*uint64(d.s4) + uint64(h3)*uint64(d.s3) + uint64(h4)*uint64(d.s2)
		d2 := uint64(h0)*uint64(d.r2) + uint64(h1)*uint64(d.r1) + uint64(h2)*uint64(d.r0) + uint64(h3)*uint64(d.s4) + uint64(h4)*uint64(d.s3)
		d3 := uint64(h0)*uint64(d.r3) + uint64(h1)*uint64(d.r2) + uint64(h2)*uint64(d.r1) + uint64(h3)*uint64(d.r0) + uint64(h4)*uint64(d.s4)
		d4 := uint64(h0)*uint64(d.r4) + uint64(h1)*uint64(d.r3) + uint64(h2)*uint64(d.r2) + uint64(h3)*uint64(d.r1) + uint64(h4)*uint64(d.r0)

		var c uint32
		c = uint32(d0 >> 26)
		d.h0 = uint32(d0) & 0x3ffffff
		d1 += uint64(c)
		c = uint32(d1 >> 26)
		d.h1 = uint32(d1) & 0x3ffffff
		d2 += uint64(c)
		c = uint32(d2 >> 26)
		d.h2 = uint32(d2) & 0x3ffffff
		d3 += uint64(c)
		c = uint32(d3 >> 26)
		d.h3 = uint32(d3) & 0x3ffffff
		d4 += uint64(c)
		c = uint32(d4 >> 26)
		d.h4 = uint32(d4) & 0x3ffffff
		d.h0 += c * 5
		c = d.h0 >> 26
		d.h0 &= 0x3ffffff
		d.h1 += c
		m = m[16:]
	}
}

func (d *donna32) update(m []byte) {
	if d.leftover > 0 {
		want := 16 - d.leftover
		if want > len(m) {
			want = len(m)
		}
		copy(d.buffer[d.leftover:], m[:want])
		m = m[want:]
		d.leftover += want
		if d.leftover < 16 {
			return
		}
		d.blocks(d.buffer[:16])
		d.leftover = 0
	}
	if n := len(m) &^ 15; n > 0 {
		d.blocks(m[:n])
		m = m[n:]
	}
	if len(m) > 0 {
		d.leftover += copy(d.buffer[d.leftover:], m)
	}
}

func (d *donna32) finish(out *[16]byte) {
	if d.leftover > 0 {
		d.buffer[d.leftover] = 1
		for i := d.leftover + 1; i < 16; i++ {
			d.buffer[i] = 0
		}
		d.final = true
		d.blocks(d.buffer[:16])
	}
	// Fully carry h.
	h0, h1, h2, h3, h4 := d.h0, d.h1, d.h2, d.h3, d.h4
	c := h1 >> 26
	h1 &= 0x3ffffff
	h2 += c
	c = h2 >> 26
	h2 &= 0x3ffffff
	h3 += c
	c = h3 >> 26
	h3 &= 0x3ffffff
	h4 += c
	c = h4 >> 26
	h4 &= 0x3ffffff
	h0 += c * 5
	c = h0 >> 26
	h0 &= 0x3ffffff
	h1 += c
	// Compute h + -p.
	g0 := h0 + 5
	c = g0 >> 26
	g0 &= 0x3ffffff
	g1 := h1 + c
	c = g1 >> 26
	g1 &= 0x3ffffff
	g2 := h2 + c
	c = g2 >> 26
	g2 &= 0x3ffffff
	g3 := h3 + c
	c = g3 >> 26
	g3 &= 0x3ffffff
	g4 := h4 + c - (1 << 26)
	// Select h if h < p, or h + -p if h >= p.
	mask := uint32((g4 >> 31) - 1)
	g0 &= mask
	g1 &= mask
	g2 &= mask
	g3 &= mask
	g4 &= mask
	mask = ^mask
	h0 = (h0 & mask) | g0
	h1 = (h1 & mask) | g1
	h2 = (h2 & mask) | g2
	h3 = (h3 & mask) | g3
	h4 = (h4 & mask) | g4
	// h = h % (2^128).
	h0 = (h0 | h1<<26) & 0xffffffff
	h1 = (h1>>6 | h2<<20) & 0xffffffff
	h2 = (h2>>12 | h3<<14) & 0xffffffff
	h3 = (h3>>18 | h4<<8) & 0xffffffff
	// mac = (h + pad) % (2^128).
	f := uint64(h0) + uint64(d.pad[0])
	h0 = uint32(f)
	f = uint64(h1) + uint64(d.pad[1]) + f>>32
	h1 = uint32(f)
	f = uint64(h2) + uint64(d.pad[2]) + f>>32
	h2 = uint32(f)
	f = uint64(h3) + uint64(d.pad[3]) + f>>32
	h3 = uint32(f)
	put := func(o uint32, p []byte) {
		p[0] = byte(o)
		p[1] = byte(o >> 8)
		p[2] = byte(o >> 16)
		p[3] = byte(o >> 24)
	}
	put(h0, out[0:4])
	put(h1, out[4:8])
	put(h2, out[8:12])
	put(h3, out[12:16])
}

// donna32Sum is the one-shot form used by the AEAD.
func donna32Sum(out *[16]byte, m []byte, key *[32]byte) {
	var d donna32
	d.init(key)
	d.update(m)
	d.finish(out)
}

// Compare the exact pinned AEAD implementation without networking, JS calls,
// packet allocation, or concurrent workers. All keys/data here are public
// synthetic benchmark inputs; they must not be reused for real encryption.
func BenchmarkChaCha20Poly1305(b *testing.B) {
	aead, err := chacha20poly1305.New(make([]byte, chacha20poly1305.KeySize))
	if err != nil {
		b.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	for _, size := range []int{1280, 8192, 32768} {
		plaintext := make([]byte, size)
		ciphertext := aead.Seal(nil, nonce, plaintext, nil)
		b.Run(fmt.Sprintf("Seal/%d", size), func(b *testing.B) {
			dst := make([]byte, 0, len(ciphertext))
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				dst = aead.Seal(dst[:0], nonce, plaintext, nil)
				cryptoBenchmarkSink ^= dst[0]
			}
		})
		b.Run(fmt.Sprintf("Open/%d", size), func(b *testing.B) {
			dst := make([]byte, 0, size)
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				dst, err = aead.Open(dst[:0], nonce, ciphertext, nil)
				if err != nil {
					b.Fatal(err)
				}
				cryptoBenchmarkSink ^= dst[0]
			}
		})
		// Component split: where does a Seal/Open spend its time on wasm?
		b.Run(fmt.Sprintf("ChaCha20/%d", size), func(b *testing.B) {
			key := make([]byte, chacha20.KeySize)
			cipher, err := chacha20.NewUnauthenticatedCipher(key, nonce)
			if err != nil {
				b.Fatal(err)
			}
			dst := make([]byte, size)
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				cipher.XORKeyStream(dst, plaintext)
				cryptoBenchmarkSink ^= dst[0]
			}
		})
		b.Run(fmt.Sprintf("Poly1305/%d", size), func(b *testing.B) {
			var key [32]byte
			var tag [poly1305.TagSize]byte
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				poly1305.Sum(&tag, ciphertext, &key)
				cryptoBenchmarkSink ^= tag[0]
			}
		})
		b.Run(fmt.Sprintf("Donna32/%d", size), func(b *testing.B) {
			// Validate the port against x/crypto before timing: every short
			// length exercises the leftover/final paths, plus block boundaries.
			check := func(n int) {
				var key [32]byte
				for i := range key {
					key[i] = byte(i*7 + n)
				}
				msg := make([]byte, n)
				for i := range msg {
					msg[i] = byte(i*13 + n)
				}
				var got, want [16]byte
				donna32Sum(&got, msg, &key)
				poly1305.Sum(&want, msg, &key)
				if got != want {
					b.Fatalf("donna32 mismatch at length %d: got %x want %x", n, got, want)
				}
			}
			for n := 0; n < 300; n++ {
				check(n)
			}
			for _, n := range []int{511, 512, 513, 1000, 8192, 65535} {
				check(n)
			}
			var key [32]byte
			msg := make([]byte, size)
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				var tag [poly1305.TagSize]byte
				donna32Sum(&tag, msg, &key)
				cryptoBenchmarkSink ^= tag[0]
			}
		})
	}
}
