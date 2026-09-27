// Copyright (c) Tailscale Inc & contributors
// SPDX-License-Identifier: BSD-3-Clause

// Tailfile's browser adapter, derived from Tailcat v0.7.0's web entry point.
// This package owns the JavaScript bridge. Local Tailcat/Tailscale patches add
// an optional encrypted packet path; address parsing and WireGuard are upstream.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// Persist both roles as complete native Tailcat keys in one record.
type transportIdentity struct {
	ServerKey tailcat.PrivateKey `json:"serverKey"`
	ClientKey tailcat.PrivateKey `json:"clientKey"`
}

func newTransportIdentity() *transportIdentity {
	pk := &transportIdentity{
		ServerKey: *tailcat.NewPrivateKey(),
		ClientKey: *tailcat.NewPrivateKey(),
	}
	pk.ServerKey.Public.RegionID = -1
	pk.ClientKey.Public.RegionID = -1
	return pk
}

// Generate native keys locally without resolving an address or opening a connection.
func tailcatCreateIdentity(this js.Value, args []js.Value) any {
	return makePromise(func() (any, error) {
		pk := newTransportIdentity()
		value, err := json.Marshal(pk)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"privateKeyJSON": string(value),
			"nodeKey":        pk.ServerKey.Private.Public().String(),
			"sendNodeKey":    pk.ClientKey.Private.Public().String(),
		}, nil
	})
}

func main() {
	js.Global().Set("tailcatCreateIdentity", js.FuncOf(tailcatCreateIdentity))
	js.Global().Set("tailcatListen", js.FuncOf(tailcatListen))
	js.Global().Set("tailcatDial", js.FuncOf(tailcatDial))
	js.Global().Set("tailcatDescribeAddress", js.FuncOf(tailcatDescribeAddress))
	js.Global().Set("tailcatRTC", js.FuncOf(tailcatRTC))
	if f := js.Global().Get("onTailcatReady"); f.Type() == js.TypeFunction {
		f.Invoke()
	}
	select {}
}

// tailcatListen starts a tailcat server in the browser.
//
// It takes one options object argument:
//
//	{
//	  derpMapURL: string,      // absolute URL of the JSON DERP map (required)
//	  privateKey: string,      // optional transportIdentity JSON; ephemeral if empty
//	  verbose: bool,           // optional; log to the console
//	  onConnection: (conn) => {}, // called with a conn object per incoming connection
//	}
//
// It returns a Promise that resolves to:
//
//	{
//	  addr: string,           // the "tc..." address to share
//	  privateKeyJSON: string, // the key (with its DERP region pinned), for persistence
//	  nodeKey: string,        // the receiving public Tailcat node key
//	  sendNodeKey: string,    // the sending public Tailcat node key
//	  close: () => Promise,
//	}
func tailcatListen(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatListen requires an options object"))
	}
	opts := args[0]
	onConnection := opts.Get("onConnection")
	derpMapURL := optString(opts, "derpMapURL")
	keyJSON := optString(opts, "privateKey")
	logf := optLogf(opts)
	return makePromise(func() (any, error) {
		if onConnection.Type() != js.TypeFunction {
			return nil, errors.New("onConnection function is required")
		}
		if derpMapURL == "" {
			return nil, errors.New("derpMapURL is required")
		}
		pk := &transportIdentity{}
		if keyJSON != "" {
			if err := json.Unmarshal([]byte(keyJSON), pk); err != nil {
				return nil, fmt.Errorf("parsing privateKey: %w", err)
			}
		} else {
			pk = newTransportIdentity()
		}
		for _, role := range []*tailcat.PrivateKey{&pk.ServerKey, &pk.ClientKey} {
			if role.Private.IsZero() || role.Public.ServerPublic.NodePublic != role.Private.Public() || role.Public.PresharedKey.IsZero() {
				return nil, errors.New("invalid Tailcat identity")
			}
		}
		if pk.ServerKey.Private.Public() == pk.ClientKey.Private.Public() {
			return nil, errors.New("invalid Tailcat identity")
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ci := pk.ServerKey.Public
		if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(derpMapURL)); err != nil {
			return nil, fmt.Errorf("Expand: %w", err)
		}
		reg := ci.Region[0]
		if pk.ServerKey.Public.RegionID < 0 {
			// Pin the picked region so a persisted key keeps the
			// same address across page loads.
			pk.ServerKey.Public.RegionID = reg.RegionID
		}
		// Embed the resolved relay so peers can use different DERP maps.
		ci.RegionID = 0
		addr := ci.Addr()
		keyOut, err := json.Marshal(pk)
		if err != nil {
			return nil, err
		}

		srv := &tailcat.Server{Key: pk.ServerKey.Private, PresharedKey: pk.ServerKey.Public.PresharedKey, Logf: logf, Region: reg}
		srv.OnTCP = func(port uint16) (handler func(net.Conn)) {
			if port == rtcControlPort {
				if opts.Get("webRTC").Truthy() {
					return func(c net.Conn) { acceptRTC(srv, c) }
				}
				return nil
			}
			// Like the CLI's default mode, accept a connection on
			// any port and hand it to the page.
			return func(c net.Conn) {
				// Upstream maps the accepted tunnel connection to its authenticated key.
				for _, entry := range srv.PeerEnv(c.LocalAddr(), c.RemoteAddr()) {
					if peer, ok := strings.CutPrefix(entry, "TAILCAT_PEER_KEY="); ok {
						onConnection.Invoke(makeJSConn(c, port, peer, srv, nil))
						return
					}
				}
				c.Close()
			}
		}
		if err := srv.Start(); err != nil {
			srv.Close()
			return nil, fmt.Errorf("Server.Start: %w", err)
		}
		var closeListener js.Func
		closeListener = js.FuncOf(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				defer closeListener.Release()
				return nil, srv.Close()
			})
		})
		return map[string]any{
			"addr":           string(addr),
			"privateKeyJSON": string(keyOut),
			"nodeKey":        pk.ServerKey.Private.Public().String(),
			"sendNodeKey":    pk.ClientKey.Private.Public().String(),
			"close":          closeListener,
		}, nil
	})
}

// tailcatDial connects to a tailcat server and dials one TCP stream
// over the tunnel.
//
// It takes one options object argument:
//
//	{
//	  addr: string,       // the server's "tc..." address (required)
//	  derpMapURL: string, // optional absolute URL of the JSON DERP map
//	  privateKey: string, // required transportIdentity JSON; uses its sending key
//	  signal: AbortSignal, // optional cancellation for connection establishment
//	  port: number,       // optional TCP port; defaults to 1 like the CLI
//	  verbose: bool,
//	}
//
// It returns a Promise that resolves to a conn object (see makeJSConn).
func tailcatDial(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatDial requires an options object"))
	}
	opts := args[0]
	addr := optString(opts, "addr")
	derpMapURL := optString(opts, "derpMapURL")
	keyJSON := optString(opts, "privateKey")
	logf := optLogf(opts)
	port := uint16(1)
	if p := opts.Get("port"); p.Type() == js.TypeNumber {
		port = uint16(p.Int())
	}
	return makePromise(func() (any, error) {
		if addr == "" {
			return nil, errors.New("addr is required")
		}
		var pk transportIdentity
		if err := json.Unmarshal([]byte(keyJSON), &pk); err != nil {
			return nil, fmt.Errorf("parsing privateKey: %w", err)
		}
		if pk.ClientKey.Private.IsZero() {
			return nil, errors.New("a Tailcat identity is required")
		}
		ci, err := tailcat.ParseAddr(tailcat.Addr(addr))
		if err != nil {
			return nil, err
		}
		cl := &tailcat.Client{
			Server:     tailcat.Addr(addr),
			Key:        pk.ClientKey.Private,
			Logf:       logf,
			DERPMapURL: derpMapURL,
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if signal := opts.Get("signal"); signal.Type() == js.TypeObject {
			abort := js.FuncOf(func(js.Value, []js.Value) any { cancel(); return nil })
			signal.Call("addEventListener", "abort", abort)
			defer func() {
				signal.Call("removeEventListener", "abort", abort)
				abort.Release()
			}()
			if signal.Get("aborted").Bool() {
				cancel()
			}
		}
		if err := pingUntil(ctx, cl); err != nil {
			cl.Close()
			return nil, err
		}
		c, err := cl.DialTCPPort(ctx, port)
		if err != nil {
			cl.Close()
			return nil, fmt.Errorf("DialTCPPort: %w", err)
		}
		stopRTC := func() {}
		if opts.Get("webRTC").Truthy() {
			stopRTC = startRTCClient(cl, ci.ServerPublic.NodePublic)
		}
		return makeJSConn(c, port, ci.ServerPublic.String(), cl, func() { stopRTC(); cl.Close() }), nil
	})
}

// pingUntil retries the meow/meowed handshake until it succeeds or
// ctx expires. The first pings can be lost while either side's DERP
// connection is still coming up.
type pinger interface {
	Ping(context.Context) (tailcat.PingResult, error)
}

func pingUntil(ctx context.Context, cl pinger) error {
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("ping: %w", err)
		}
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := cl.Ping(pctx)
		cancel()
		if err == nil {
			return nil
		}
		// Startup failures can be immediate (for example a failed relay-map
		// fetch). Bound retries instead of spinning until the outer deadline.
		timer := time.NewTimer(200 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("ping: %w", ctx.Err())
		case <-timer.C:
		}
	}
}

// makeJSConn wraps a tunneled TCP connection as a JavaScript object:
//
//	{
//	  port: number,
//	  peerNodeKey: string, // authenticated by the established Tailcat tunnel
//	  read: () => Promise<Uint8Array|null>, // null on EOF; no concurrent calls
//	  write: (Uint8Array) => Promise,
//	  closeWrite: () => Promise, // half-close, netcat style
//	  close: () => Promise,
//	}
//
// read is pull-based: the browser only reads from netstack when the
// page asks for more, so a fast sender stalls on TCP backpressure
// rather than filling browser memory.
func makeJSConn(c net.Conn, port uint16, peerNodeKey string, owner packetPathOwner, onClose func()) js.Value {
	var peer key.NodePublic
	peer.UnmarshalText([]byte(peerNodeKey))
	buf := make([]byte, 64<<10)
	uint8Array := js.Global().Get("Uint8Array")
	var callbacks []js.Func
	bind := func(handler func(js.Value, []js.Value) any) js.Func {
		callback := js.FuncOf(handler)
		callbacks = append(callbacks, callback)
		return callback
	}
	return js.ValueOf(map[string]any{
		"port":        int(port),
		"peerNodeKey": peerNodeKey,
		"transportStats": bind(func(js.Value, []js.Value) any {
			stats := owner.PacketStats(peer)
			return map[string]any{"derpTxBytes": float64(stats.DERPTxBytes), "derpRxBytes": float64(stats.DERPRxBytes), "pathDrops": float64(stats.PathDrops)}
		}),
		"read": bind(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				n, err := c.Read(buf)
				if n > 0 {
					u8 := uint8Array.New(n)
					js.CopyBytesToJS(u8, buf[:n])
					return u8, nil
				}
				if err == nil || errors.Is(err, io.EOF) {
					return js.Null(), nil
				}
				return nil, err
			})
		}),
		"write": bind(func(this js.Value, args []js.Value) any {
			if len(args) != 1 {
				return rejectedPromise(errors.New("write requires a Uint8Array"))
			}
			b := make([]byte, args[0].Get("length").Int())
			js.CopyBytesToGo(b, args[0])
			return makePromise(func() (any, error) {
				if _, err := c.Write(b); err != nil {
					return nil, err
				}
				return js.Undefined(), nil
			})
		}),
		"closeWrite": bind(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				cw, ok := c.(interface{ CloseWrite() error })
				if !ok {
					return nil, errors.New("connection does not support half-close")
				}
				if err := cw.CloseWrite(); err != nil {
					return nil, err
				}
				return js.Undefined(), nil
			})
		}),
		"close": bind(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				c.Close()
				if onClose != nil {
					onClose()
				}
				// Release callbacks so closed transports and read buffers can be collected.
				for _, callback := range callbacks {
					callback.Release()
				}
				return nil, nil
			})
		}),
	})
}

func optString(v js.Value, name string) string {
	if p := v.Get(name); p.Type() == js.TypeString {
		return p.String()
	}
	return ""
}

func optLogf(v js.Value) logger.Logf {
	if v.Get("verbose").Truthy() {
		return log.Printf
	}
	return logger.Discard
}

// makePromise runs f on a new goroutine and returns a JavaScript
// Promise of its result, rejected with a JavaScript Error if f
// returns an error.
func makePromise(f func() (any, error)) js.Value {
	handler := js.FuncOf(func(this js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			if res, err := f(); err == nil {
				resolve.Invoke(res)
			} else {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			}
		}()
		return nil
	})
	defer handler.Release()
	return js.Global().Get("Promise").New(handler)
}

func rejectedPromise(err error) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(err.Error()))
}

// tailcatDescribeAddress exposes upstream diagnostics, redacted before Worker RPC.
func tailcatDescribeAddress(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return rejectedPromise(errors.New("describeAddress requires an address"))
	}
	address := tailcat.Addr(args[0].String())
	return makePromise(func() (any, error) {
		if len(address) < 22 || len(address) > 2048 {
			return nil, errors.New("Invalid Tailcat address")
		}
		ci, err := tailcat.ParseAddr(address)
		if err != nil || ci.ServerPublic.IsZero() || (len(ci.Region) == 0 && ci.RegionID <= 0) {
			return nil, errors.New("Invalid Tailcat address")
		}
		raw, err := tailcat.ParseAddrRaw(address)
		if err != nil {
			return nil, errors.New("Invalid Tailcat address")
		}
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, err
		}
		result := js.Global().Get("JSON").Call("parse", string(encoded))
		if result.Get("PresharedKey").Type() != js.TypeUndefined {
			result.Set("PresharedKey", "[REDACTED: 32-byte pre-shared key]")
		}
		return result, nil
	})
}
