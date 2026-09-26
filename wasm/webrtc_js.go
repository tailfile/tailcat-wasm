package main

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"sync"
	"syscall/js"
	"time"

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

type rtcSession struct {
	id      int
	conn    net.Conn
	path    *magicsock.PacketPath
	signals chan []byte
	done    chan struct{}
	once    sync.Once
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
	s := &rtcSession{id: rtcSessions.next, conn: c, signals: make(chan []byte, 32), done: make(chan struct{})}
	rtcSessions.items[s.id] = s
	rtcSessions.Unlock()
	s.path = owner.NewPacketPath(peer, func(packet []byte) bool {
		f := js.Global().Get("onTailcatRTCPacket")
		if f.Type() != js.TypeFunction {
			return false
		}
		bytes := js.Global().Get("Uint8Array").New(len(packet))
		js.CopyBytesToJS(bytes, packet)
		return f.Invoke(s.id, bytes).Truthy()
	})
	rtcEvent(s.id, "start", map[string]any{"initiator": initiator, "peerNodeKey": peer.String()})
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
		dialCtx, stop := context.WithTimeout(ctx, 3*time.Second)
		defer stop()
		c, err := cl.DialTCPPort(dialCtx, rtcControlPort)
		if err != nil {
			return
		} // Legacy peers retain DERP.
		s := newRTCSession(cl, c, peer, true)
		if s != nil {
			context.AfterFunc(ctx, s.close)
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
		n := args[2].Get("byteLength").Int()
		if n > 0 && n <= 65535 {
			packet := make([]byte, n)
			js.CopyBytesToGo(packet, args[2])
			s.path.Receive(packet)
		}
	case "closed":
		go s.close()
	}
	return nil
}
