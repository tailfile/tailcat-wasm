package main

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"runtime"
	"strings"
	"sync"
	"syscall/js"
	"time"
	"unsafe"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/wgengine/magicsock"
)

// Experimental internal port: signaling stays inside the authenticated tunnel.
const rtcControlPort = 65534
const rtcMaxSignal = 64 << 10

type packetPathOwner interface {
	NewPacketPath(key.NodePublic, func([]byte) bool) *magicsock.PacketPath
	PacketStats(key.NodePublic) magicsock.PacketStats
}

var rtcSessions = struct {
	sync.Mutex
	next  int
	items map[int]*rtcSession
}{items: make(map[int]*rtcSession)}

// rtcMaxPacket bounds one encrypted WireGuard datagram, like the UDP path.
const rtcMaxPacket = 65535

type rtcSession struct {
	id      int
	conn    net.Conn
	path    *magicsock.PacketPath
	signals chan []byte
	done    chan struct{}
	once    sync.Once
	// recvFree recycles receive buffers after the path consumer copies them
	// out. recvPending is the buffer the Worker writes the next packet into.
	// syscall/js calls are serialized by the JS event loop, so no mutex.
	recvFree    chan []byte
	recvPending []byte
}

func (s *rtcSession) nextRecv() []byte {
	select {
	case buf := <-s.recvFree:
		// Recycled buffers keep the previous packet's length; the Worker
		// always writes against the full capacity.
		return buf[:cap(buf)]
	default:
		return make([]byte, rtcMaxPacket)
	}
}

func rtcEvent(id int, event string, data any) {
	if f := js.Global().Get("onTailcatRTC"); f.Type() == js.TypeFunction {
		f.Invoke(id, event, data)
	}
}

func newRTCSession(owner packetPathOwner, c net.Conn, peer key.NodePublic, initiator bool) *rtcSession {
	rtcSessions.Lock()
	if len(rtcSessions.items) >= 32 {
		rtcSessions.Unlock()
		c.Close()
		return nil
	}
	rtcSessions.next++
	s := &rtcSession{
		id:          rtcSessions.next,
		conn:        c,
		signals:     make(chan []byte, 32),
		done:        make(chan struct{}),
		recvFree:    make(chan []byte, 4),
		recvPending: make([]byte, rtcMaxPacket),
	}
	rtcSessions.items[s.id] = s
	rtcSessions.Unlock()
	// The Worker installs this bridge once before starting Go. Keep its JS
	// references for the session instead of creating finalizable js.Values for
	// every encrypted packet.
	sendPacket := js.Global().Get("onTailcatRTCPacket")
	s.path = owner.NewPacketPath(peer, func(packet []byte) bool {
		if sendPacket.Type() != js.TypeFunction || len(packet) == 0 {
			return false
		}
		// The synchronous Worker callback copies this borrowed WASM range before
		// returning. Passing numeric bounds avoids a finalizable js.Value and a
		// separate syscall/js copy for every packet. Never retain this view in JS:
		// WireGuard reuses packet buffers and Go can grow the linear memory.
		accepted := sendPacket.Invoke(s.id, float64(uintptr(unsafe.Pointer(&packet[0]))), len(packet)).Truthy()
		runtime.KeepAlive(packet)
		return accepted
	})
	// The Worker recycles copied-out buffers through the pool. Sessions own
	// their pools; a replaced path keeps its old pool until garbage collection.
	s.path.SetRecvPool(s.recvFree)
	rtcEvent(s.id, "start", map[string]any{
		"initiator":    initiator,
		"peerNodeKey":  peer.String(),
		"recvBuffer":   float64(uintptr(unsafe.Pointer(&s.recvPending[0]))),
		"recvCapacity": rtcMaxPacket,
	})
	go s.readSignals()
	go s.writeSignals()
	return s
}

func (s *rtcSession) close() {
	s.once.Do(func() {
		s.path.Close() // Restore DERP before closing the tunneled control stream.
		close(s.done)
		s.conn.Close()
		rtcSessions.Lock()
		delete(rtcSessions.items, s.id)
		rtcSessions.Unlock()
		rtcEvent(s.id, "closed", nil)
	})
}

func (s *rtcSession) readSignals() {
	defer s.close()
	var header [4]byte
	for {
		if _, err := io.ReadFull(s.conn, header[:]); err != nil {
			return
		}
		n := binary.BigEndian.Uint32(header[:])
		if n == 0 || n > rtcMaxSignal {
			return
		}
		body := make([]byte, n)
		if _, err := io.ReadFull(s.conn, body); err != nil {
			return
		}
		rtcEvent(s.id, "signal", string(body))
	}
}

func (s *rtcSession) writeSignals() {
	defer s.close()
	for {
		select {
		case <-s.done:
			return
		case body := <-s.signals:
			frame := make([]byte, 4+len(body))
			binary.BigEndian.PutUint32(frame, uint32(len(body)))
			copy(frame[4:], body)
			if _, err := s.conn.Write(frame); err != nil {
				return
			}
		}
	}
}

func acceptRTC(srv *tailcat.Server, c net.Conn) {
	for _, entry := range srv.PeerEnv(c.LocalAddr(), c.RemoteAddr()) {
		if value, ok := strings.CutPrefix(entry, "TAILCAT_PEER_KEY="); ok {
			var peer key.NodePublic
			if peer.UnmarshalText([]byte(value)) == nil {
				newRTCSession(srv, c, peer, false)
				return
			}
		}
	}
	c.Close()
}

func startRTCClient(cl *tailcat.Client, peer key.NodePublic) func() {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		wait := func(d time.Duration) bool {
			timer := time.NewTimer(d)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return false
			case <-timer.C:
				return true
			}
		}
		backoff := time.Second
		for ctx.Err() == nil {
			if !js.Global().Get("tailcatWebRTCEnabled").Truthy() {
				if !wait(time.Second) {
					return
				}
				continue
			}
			dialCtx, stop := context.WithTimeout(ctx, 10*time.Second)
			c, err := cl.DialTCPPort(dialCtx, rtcControlPort)
			stop()
			if err == nil {
				s := newRTCSession(cl, c, peer, true)
				if s != nil {
					started := time.Now()
					select {
					case <-ctx.Done():
						s.close()
						return
					case <-s.done:
					}
					if time.Since(started) > 30*time.Second {
						backoff = time.Second
					}
				}
			}
			// Legacy/unreachable peers keep using DERP. Retry on the same Client,
			// so application streams and the SDK's outgoing dial slot stay intact.
			if !wait(backoff) {
				return
			}
			backoff = min(backoff*2, 30*time.Second)
		}
	}()
	return cancel
}

func tailcatRTC(_ js.Value, args []js.Value) any {
	if len(args) != 3 {
		return nil
	}
	rtcSessions.Lock()
	s := rtcSessions.items[args[0].Int()]
	rtcSessions.Unlock()
	if s == nil {
		return nil
	}
	switch args[1].String() {
	case "signal":
		body := []byte(args[2].String())
		if len(body) == 0 || len(body) > rtcMaxSignal {
			go s.close()
			return nil
		}
		select {
		case s.signals <- body:
		default:
			go s.close()
		}
	case "packet":
		if args[2].Type() != js.TypeNumber {
			// Legacy path for Workers without buffer addresses.
			n := args[2].Get("byteLength").Int()
			if n > 0 && n <= rtcMaxPacket {
				packet := make([]byte, n)
				js.CopyBytesToGo(packet, args[2])
				return s.path.Receive(packet)
			}
			return false
		}
		n := args[2].Int()
		if n <= 0 || n > rtcMaxPacket {
			return 0
		}
		// The Worker has just copied the packet into recvPending. Take ownership
		// of that buffer and hand back the next free one as a memory address;
		// 0 reports rejection and leaves recvPending in place for the next copy.
		buf := s.recvPending
		if !s.path.ReceiveOwned(buf[:n]) {
			return 0
		}
		s.recvPending = s.nextRecv()
		return float64(uintptr(unsafe.Pointer(&s.recvPending[0])))
	case "closed":
		go s.close()
	}
	return nil
}
