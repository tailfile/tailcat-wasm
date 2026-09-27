package main

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tailscale/tailcat"
)

type pingFunc func(context.Context) (tailcat.PingResult, error)

func (f pingFunc) Ping(ctx context.Context) (tailcat.PingResult, error) { return f(ctx) }

func TestPingUntilImmediateSuccess(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()
		calls := 0
		err := pingUntil(context.Background(), pingFunc(func(context.Context) (tailcat.PingResult, error) {
			calls++
			return tailcat.PingResult{}, nil
		}))
		if err != nil || calls != 1 || time.Since(start) != 0 {
			t.Fatalf("pingUntil: error=%v calls=%d elapsed=%v", err, calls, time.Since(start))
		}
	})
}

func TestPingUntilImmediateFailuresBackOff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()
		calls := 0
		err := pingUntil(context.Background(), pingFunc(func(context.Context) (tailcat.PingResult, error) {
			calls++
			if calls < 3 {
				return tailcat.PingResult{}, errors.New("relay unavailable")
			}
			return tailcat.PingResult{}, nil
		}))
		if err != nil || calls != 3 || time.Since(start) != 400*time.Millisecond {
			t.Fatalf("pingUntil: error=%v calls=%d elapsed=%v", err, calls, time.Since(start))
		}
	})
}

func TestPingUntilCancellationDuringBackoff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		calls := 0
		result := make(chan error, 1)
		go func() {
			result <- pingUntil(ctx, pingFunc(func(context.Context) (tailcat.PingResult, error) {
				calls++
				return tailcat.PingResult{}, errors.New("relay unavailable")
			}))
		}()
		synctest.Wait() // The first failure has entered the retry timer.
		time.Sleep(20 * time.Millisecond)
		start := time.Now()
		cancel()
		err := <-result
		if !errors.Is(err, context.Canceled) || calls != 1 || time.Since(start) != 0 {
			t.Fatalf("pingUntil: error=%v calls=%d cancellation delay=%v", err, calls, time.Since(start))
		}
	})
}

func TestPingUntilAlreadyCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := pingUntil(ctx, pingFunc(func(context.Context) (tailcat.PingResult, error) {
		t.Fatal("called Ping with an already canceled context")
		return tailcat.PingResult{}, nil
	}))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("pingUntil: %v", err)
	}
}

func TestPingUntilDeadlineDuringBackoff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 450*time.Millisecond)
		defer cancel()
		calls := 0
		err := pingUntil(ctx, pingFunc(func(context.Context) (tailcat.PingResult, error) {
			calls++
			return tailcat.PingResult{}, errors.New("relay unavailable")
		}))
		if !errors.Is(err, context.DeadlineExceeded) || calls != 3 {
			t.Fatalf("pingUntil: error=%v calls=%d", err, calls)
		}
	})
}
