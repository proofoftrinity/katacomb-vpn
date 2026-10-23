package main

import (
	"strings"
	"testing"

	"katacomb.vpn/daemon/internal/oneshot"
)

// [PH-11] No verb of the Linux one-shot, and not the hidden AmneziaWG device,
// is a command on Windows: there the only way to a tunnel is the service's pipe.
// The verbs are read from oneshot.Usage, so a verb added on Linux is checked too.
func TestWindowsRefusesEveryTunnelVerb(t *testing.T) {
	body := strings.TrimSuffix(strings.SplitN(oneshot.Usage, "{", 2)[1], "}")
	verbs := []string{"_amneziawg"}
	for _, alt := range strings.Split(body, "|") {
		verbs = append(verbs, strings.Fields(alt)[0])
	}
	if len(verbs) < 11 {
		t.Fatalf("read only %d verbs from the usage line", len(verbs))
	}
	for _, v := range verbs {
		for _, args := range [][]string{{v}, {v, "C:\\x\\sntl0.conf"}, {v, "sntl0", "1.2.3.4"}} {
			if got := windowsCommand(args); got != "" {
				t.Errorf("%q runs %q on Windows", args, got)
			}
		}
	}
	for _, args := range [][]string{{"service"}, {"service", "start"}, {"--version", "x"}, {}} {
		if got := windowsCommand(args); got != "" {
			t.Errorf("%q runs %q on Windows", args, got)
		}
	}
}
