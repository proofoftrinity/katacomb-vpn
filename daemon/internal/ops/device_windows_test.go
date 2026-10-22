package ops

import (
	"testing"
	"time"
)

func TestHandshakeAge(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	for _, c := range []struct {
		uapi string
		want int
	}{
		{"public_key=ab\nlast_handshake_time_sec=0\nlast_handshake_time_nsec=0\n", -1},
		{"public_key=ab\nlast_handshake_time_sec=999990\n", 10},
		{"last_handshake_time_sec=999000\npublic_key=cd\nlast_handshake_time_sec=999995\n", 5},
		{"last_handshake_time_sec=1000100\n", 0}, // a clock step back is not the future
		{"", -1},
	} {
		if got := handshakeAge(c.uapi, now); got != c.want {
			t.Errorf("%q: got %d, want %d", c.uapi, got, c.want)
		}
	}
}
