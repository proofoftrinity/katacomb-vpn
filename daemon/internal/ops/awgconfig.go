package ops

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// awgDirectives are the wg-quick(8) [Interface]/[Peer] directives ops needs — the
// ones the device itself does not consume (Address/DNS/Endpoint/AllowedIPs).
type awgDirectives struct {
	addresses    []string
	nameservers  []string
	searches     []string
	endpointIP   string
	mtu          int // 0 when the config names none
	hasV4Default bool
	hasV6Default bool
}

var reIPish = regexp.MustCompile(`^[0-9a-fA-F:.]+$`)

// parseAwgDirectives extracts what ops needs from the already-validated config.
// It is extraction, not validation (guard ran first); an obviously broken shape
// (no addresses, no endpoint) is still refused so a bad bring-up fails early.
func parseAwgDirectives(config []byte) (awgDirectives, error) {
	var d awgDirectives
	section := ""
	for _, raw := range strings.Split(string(config), "\n") {
		text := strings.TrimSpace(raw)
		if i := strings.IndexByte(text, '#'); i >= 0 {
			text = strings.TrimSpace(text[:i])
		}
		if text == "" {
			continue
		}
		if strings.HasPrefix(text, "[") {
			section = strings.ToLower(text)
			continue
		}
		key, value, ok := strings.Cut(text, "=")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		switch {
		case section == "[interface]" && key == "address":
			for _, a := range strings.Split(value, ",") {
				if a = strings.TrimSpace(a); a != "" {
					d.addresses = append(d.addresses, a)
				}
			}
		case section == "[interface]" && key == "dns":
			for _, v := range strings.Split(value, ",") {
				v = strings.TrimSpace(v)
				if v == "" {
					continue
				}
				if reIPish.MatchString(v) {
					d.nameservers = append(d.nameservers, v)
				} else {
					d.searches = append(d.searches, v)
				}
			}
		case section == "[interface]" && key == "mtu":
			// guard has already checked the value is digits.
			d.mtu, _ = strconv.Atoi(value)
		case section == "[peer]" && key == "endpoint":
			d.endpointIP = endpointHost(value)
		case section == "[peer]" && key == "allowedips":
			for _, c := range strings.Split(value, ",") {
				switch strings.TrimSpace(c) {
				case "0.0.0.0/0":
					d.hasV4Default = true
				case "::/0":
					d.hasV6Default = true
				}
			}
		}
	}
	if len(d.addresses) == 0 {
		return d, errors.New("AmneziaWG config has no Address")
	}
	if d.endpointIP == "" {
		return d, errors.New("AmneziaWG config has no Endpoint")
	}
	return d, nil
}

// endpointHost strips the port (and IPv6 brackets) from a wg Endpoint. Our endpoints
// are IPv4-pinned, so this is host:port; the [v6]:port form is handled defensively.
func endpointHost(endpoint string) string {
	if strings.HasPrefix(endpoint, "[") {
		if i := strings.LastIndex(endpoint, "]"); i > 0 {
			return endpoint[1:i]
		}
	}
	if i := strings.LastIndex(endpoint, ":"); i >= 0 {
		return endpoint[:i]
	}
	return endpoint
}
