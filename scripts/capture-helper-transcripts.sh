#!/usr/bin/env bash
# Golden transcripts of the ORIGINAL bash helper, for the Go port's parity test.
#
#   ./scripts/capture-helper-transcripts.sh            # re-capture into daemon/internal/ops/testdata/transcripts/
#   ./scripts/capture-helper-transcripts.sh --inner    # (what the container runs; do not call by hand)
#
# The Go helper (daemon/) replaced resources/linux/privileged/katacomb-vpn-helper.sh
# verb for verb, and daemon/internal/ops/transcript_test.go proves it by replaying
# every verb against a recording Env and comparing the argv it produces, and the
# state files it leaves, with what the bash helper produced here. These files are
# therefore a FIXTURE, regenerated only by hand (like the wire corpus that
# node-handshake.test.ts keeps), never by CI. The bash helper itself is gone from the
# tree; this script reads it back from git history (the commit that deleted it).
#
# WHY A CONTAINER, AS ROOT, WITH SHIMS
# The helper writes /etc/resolv.conf, /run/katacomb-vpn and /var/lib/katacomb-vpn,
# and chowns them, which is not acceptable on the maintainer's machine.
# So it runs as root in a throwaway debian:bookworm, where every external tool it
# calls (ip, iptables, ip6tables, wg-quick, pkill, tun2socks)
# is a shim that appends its basename + argv to a log and answers the way the real
# tool would on a host where the verb succeeds. Query commands (`ip link show X`,
# `ip -o link show type wireguard`, `ip rule show`, `ip6tables -S`) answer from a
# little fake state the shims share, so the helper's loops run the way they do live
# (e.g. wg-quick's leaked rule pairs, which cleanup_wg_rules deletes one by one).
# The Go test's recording Env implements the SAME fake state, so both sides see the
# same answers and only the state-changing commands are compared.
#
# Output per step: NN-<verb>[-variant].argv (one space-joined command per line —
# no helper argv ever contains whitespace), .out (exit code, stdout, stderr) and
# .state (every file under /run/katacomb-vpn and /var/lib/katacomb-vpn with its mode
# and content, plus /etc/resolv.conf; pids normalised to <PID>).
set -euo pipefail

if [ "${1:-}" != "--inner" ]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  OUT="$REPO/daemon/internal/ops/testdata/transcripts"
  HELPER_REL=resources/linux/privileged/katacomb-vpn-helper.sh
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  if [ -f "$REPO/$HELPER_REL" ]; then
    cp "$REPO/$HELPER_REL" "$WORK/helper.sh"
  else
    # The commit that deleted it; its parent still has the file.
    del="$(git -C "$REPO" rev-list -1 HEAD -- "$HELPER_REL")"
    [ -n "$del" ] || { echo "cannot find $HELPER_REL in the working tree or git history" >&2; exit 1; }
    git -C "$REPO" show "$del^:$HELPER_REL" > "$WORK/helper.sh"
    echo "bash helper read from git ($del^)"
  fi
  mkdir -p "$OUT"
  rm -f "$OUT"/*.argv "$OUT"/*.out "$OUT"/*.state
  # --privileged: /etc/resolv.conf is a bind mount inside docker, and the helper's
  # `mv -f` over it needs the mount gone first (umount needs CAP_SYS_ADMIN).
  docker run --rm --privileged \
    -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$WORK/helper.sh:/helper.sh:ro" \
    -v "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/capture-helper-transcripts.sh:/capture.sh:ro" \
    -v "$OUT:/out" \
    debian:bookworm bash /capture.sh --inner
  echo "transcripts written to $OUT"
  ls "$OUT" | sed 's/^/  /'
  exit 0
fi

# ---------------------------------------------------------------------------
# Inner: runs as root inside debian:bookworm.
# ---------------------------------------------------------------------------
HELPER=/helper.sh
SHIM=/shim
LOG=$SHIM/argv.log
mkdir -p $SHIM/bin $SHIM/links /tmp/cfg

# Every shim starts with this: log basename + argv, one line, space-joined.
logger_prelude() {
  cat <<EOF
#!/bin/bash
{ printf '%s' "\$(basename "\$0")"; for a in "\$@"; do printf ' %s' "\$a"; done; printf '\n'; } >> $LOG
EOF
}
mkshim() { # name dir body...
  local name="$1" dir="$2"; shift 2
  { logger_prelude; printf '%s\n' "$@"; } > "$dir/$name"
  chmod 755 "$dir/$name"
}

# --- ip: the one shim with fake state -------------------------------------
# links/<name> exists  <=> the interface exists
# wgtype exists        <=> sntl0 was created by wg-quick (kernel wireguard type);
#                          awg-quick's sntl0 is `type tun` and never shows there
# rules<fam>.fw / .sp  <=> how many wg-quick fwmark / suppress_prefixlength rules
#                          are installed per family; wg-quick/awg-quick up leaves
#                          TWO of each, the leak cleanup_wg_rules exists for
mkshim ip $SHIM/bin '
fam=""
if [[ "${1:-}" == "-4" || "${1:-}" == "-6" ]]; then fam="$1"; shift; fi
if [[ "${1:-}" == "-o" && "${2:-}" == "link" && "${3:-}" == "show" && "${4:-}" == "type" && "${5:-}" == "wireguard" ]]; then
  if [[ -e /shim/links/sntl0 && -e /shim/wgtype ]]; then
    echo "5: sntl0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/none "
  fi
  exit 0
fi
if [[ "${1:-}" == "link" && "${2:-}" == "show" && -n "${3:-}" ]]; then
  [[ -e "/shim/links/$3" ]] && exit 0 || exit 1
fi
if [[ "${1:-}" == "link" && "${2:-}" == "delete" && -n "${3:-}" ]]; then
  if [[ -e "/shim/links/$3" ]]; then
    rm -f "/shim/links/$3"; [[ "$3" == sntl0 ]] && rm -f /shim/wgtype
    exit 0
  fi
  echo "Cannot find device \"$3\"" >&2; exit 1
fi
if [[ "${1:-}" == "rule" && "${2:-}" == "show" ]]; then
  n=$(cat "/shim/rules$fam.fw" 2>/dev/null || echo 0); s=$(cat "/shim/rules$fam.sp" 2>/dev/null || echo 0)
  for ((i=0;i<n;i++)); do printf "32764:\tnot from all fwmark 0xca6c lookup 51820\n"; done
  for ((i=0;i<s;i++)); do printf "32765:\tfrom all lookup main suppress_prefixlength 0\n"; done
  exit 0
fi
if [[ "${1:-}" == "rule" && "${2:-}" == "delete" ]]; then
  if [[ "$*" == *"suppress_prefixlength 0"* ]]; then f="/shim/rules$fam.sp"; else f="/shim/rules$fam.fw"; fi
  n=$(cat "$f" 2>/dev/null || echo 0)
  if [[ "$n" -le 0 ]]; then echo "RTNETLINK answers: No such file or directory" >&2; exit 2; fi
  echo $((n-1)) > "$f"; exit 0
fi
exit 0'

mkshim iptables  $SHIM/bin 'exit 0'
mkshim ip6tables $SHIM/bin 'exit 0'
mkshim pkill     $SHIM/bin 'exit 0'

# wg-quick up creates a kernel-type sntl0 and leaks two rule pairs per family;
# wg-quick down FAILS, exactly as it does live (the config is not in /etc/wireguard),
# which is what sends the helper down its `ip link delete` path.
mkshim wg-quick $SHIM/bin '
case "${1:-}" in
  up)   touch /shim/links/sntl0 /shim/wgtype; for f in rules-4.fw rules-4.sp rules-6.fw rules-6.sp; do echo 2 > /shim/$f; done; exit 0 ;;
  down) echo "wg-quick: \`$2'"'"' is not a WireGuard interface" >&2; exit 1 ;;
esac
exit 0'

# tun2socks is spawned detached (nohup … &) and stays resident; its pid is what the
# helper records in tun.state and what tun-down kills.
mkshim tun2socks $SHIM/bin 'touch /shim/links/sntl-tun; exec sleep 300'

export PATH="$SHIM/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# --- fixtures ------------------------------------------------------------
cat > /tmp/cfg/wg.conf <<'EOF'
[Interface]
PrivateKey = aGVsbG8td29ybGQtcHJpdmF0ZS1rZXktYmFzZTY0PT0=
Address = 10.8.0.2/32
DNS = 10.8.0.1
MTU = 1420

[Peer]
PublicKey = c29tZS1wdWJsaWMta2V5LWluLWJhc2U2NC1mb3JtYXQ9
PresharedKey = cHNrLWtleS1iYXNlNjQtZW5jb2RlZC12YWx1ZS09PQ==
AllowedIPs = 0.0.0.0/0
Endpoint = 203.0.113.7:51820
PersistentKeepalive = 25
EOF
sed 's/^MTU = 1420$/PostUp = touch \/tmp\/pwned/' /tmp/cfg/wg.conf > /tmp/cfg/wg-postup.conf

# The helper derives the interface from the config's basename, so the WG/AWG
# configs are handed over as sntl0.conf.
use_wg()  { cp /tmp/cfg/wg.conf  /tmp/cfg/sntl0.conf; }
use_wg_postup() { cp /tmp/cfg/wg-postup.conf /tmp/cfg/sntl0.conf; }

# /etc/resolv.conf: a plain file with known content (docker bind-mounts it).
umount /etc/resolv.conf 2>/dev/null || true
rm -f /etc/resolv.conf
printf 'nameserver 10.0.0.53\nsearch example.test\n' > /etc/resolv.conf
chmod 644 /etc/resolv.conf

# --- recorder ------------------------------------------------------------
snapshot() {
  local f
  for f in /run/katacomb-vpn /var/lib/katacomb-vpn; do
    if [ -d "$f" ]; then echo "$f/ mode=$(stat -c %a "$f")"; fi
  done
  for f in /run/katacomb-vpn/* /var/lib/katacomb-vpn/*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    if [ -L "$f" ]; then
      echo "$f -> $(readlink "$f")"
    else
      echo "$f mode=$(stat -c %a "$f")"
      sed -e 's/^[0-9][0-9]* /<PID> /' "$f" | sed 's/^/  /'
    fi
  done
  if [ -L /etc/resolv.conf ]; then
    echo "/etc/resolv.conf -> $(readlink /etc/resolv.conf)"
  elif [ -e /etc/resolv.conf ]; then
    echo "/etc/resolv.conf mode=$(stat -c %a /etc/resolv.conf)"
    sed 's/^/  /' /etc/resolv.conf
  else
    echo "/etc/resolv.conf absent"
  fi
}

run() { # label args...
  local label="$1"; shift
  : > "$LOG"
  local rc=0 out err
  out="$(bash "$HELPER" "$@" 2>/tmp/stderr)" || rc=$?
  err="$(cat /tmp/stderr)"
  cp "$LOG" "/out/$label.argv"
  {
    echo "argv: $*"
    echo "exit: $rc"
    echo "stdout: $(printf '%s' "$out" | sed -e 's/^[0-9][0-9]*$/<PID>/')"
    echo "stderr: $err"
  } > "/out/$label.out"
  snapshot > "/out/$label.state"
  echo "  [$rc] $label: $*"
}

echo "capturing…"
# --- the state-changing verbs, in the order a session uses them -----------
use_wg
run 01-up                     up /tmp/cfg/sntl0.conf
run 02-killswitch-on          killswitch-on sntl0 203.0.113.7
run 03-killswitch-on-dns      killswitch-on sntl0 203.0.113.7 1.1.1.1
run 04-killswitch-on-lan      killswitch-on sntl0 203.0.113.7 lan-sharing
run 05-killswitch-on-dns-lan  killswitch-on sntl0 203.0.113.7 1.1.1.1 lan-sharing
run 06-dns-set-first          dns-set 1.1.1.1
run 07-dns-set-second         dns-set 9.9.9.9
run 08-dns-restore            dns-restore
run 09-killswitch-off         killswitch-off
run 10-down                   down
# awg-up / awg-down are no longer captured here: since Phase 3 the AmneziaWG device
# is embedded and awg-up is a behavioural reimplementation of wg-quick(8), asserted by
# daemon/internal/ops/amneziawg_ops_test.go rather than diffed against the bash helper.
# The bash helper's ovpn-up / ovpn-down (13-15, 36) are not captured: OpenVPN was
# removed in 1.19.0.
run 16-tun-up                 tun-up /shim/bin/tun2socks 127.0.0.1:1080 203.0.113.7 192.168.1.1 eth0
run 17-tun-down               tun-down
run 18-tun-up-bypass          tun-up /shim/bin/tun2socks 127.0.0.1:1080 203.0.113.7 192.168.1.1 eth0 10.0.0.0/8,192.168.0.0/16
run 19-tun-down-bypass        tun-down
run 20-tun-up-again           tun-up /shim/bin/tun2socks 127.0.0.1:1080 203.0.113.7 192.168.1.1 eth0
rm -f /run/katacomb-vpn/tun.state
run 21-tun-down-nostate       tun-down
run 22-dns-restore-noop       dns-restore
rm -f /etc/resolv.conf; ln -s /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
run 23-dns-set-symlink        dns-set 8.8.8.8
run 24-dns-restore-symlink    dns-restore
rm -f /etc/resolv.conf
run 25-dns-set-absent         dns-set 9.9.9.9
run 26-dns-restore-absent     dns-restore

# --- refusals: no tool may run, exit 1, Error: on stderr --------------------
use_wg_postup
run 30-up-postup              up /tmp/cfg/sntl0.conf
run 32-killswitch-on-zero     killswitch-on sntl0 0.0.0.0
run 37-killswitch-on-badiface killswitch-on 'sntl0;reboot' 203.0.113.7
run 38-tun-up-badsocks        tun-up /shim/bin/tun2socks localhost:1080 203.0.113.7 192.168.1.1 eth0

chown -R "$HOST_UID:$HOST_GID" /out
echo "done"
