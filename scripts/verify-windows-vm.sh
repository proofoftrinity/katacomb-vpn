#!/usr/bin/env bash
# Katacomb VPN — the Windows (beta) release check, in the Windows 11 test VM.
#
#     ./scripts/verify-windows-vm.sh fullcycle [setup.exe]
#     ./scripts/verify-windows-vm.sh integration
#     KEEP=1 ...      leave the test servers up afterwards
#
# fullcycle: revert the VM to its `clean` snapshot, install the installer silently
# (dist/katacomb-vpn-<version>-setup.exe unless one is named), check the service, its
# pipe, its files and that another user is refused; start the app in the desktop session
# and drive it over DevTools (the setup gate, start at login, a throwaway UNFUNDED wallet
# the app generates itself, every tab, screenshots); run `integration`; install again
# over the running app; uninstall and check that nothing is left; then install once more,
# drop the throwaway wallet and save the VM as `katacomb-ready` for the paid checks.
#
# integration: real tunnels through the installed service's pipe, against servers this
# script runs in docker on the host: stock WireGuard, the AmneziaWG reference peer
# (built from the commits dvpnd pins, as verify-awg-handshake.sh does) and an xray SOCKS
# server for tun2socks. Then the kill switch through a killed service, and nothing left.
#
# Spends nothing: no funded wallet, no chain transaction. Needs the VM at ~/vms/win11
# (KV_WIN_VM; docs/windows.md), docker, wg, node and ImageMagick's convert. Never with
# the Ubuntu test VM up: the host has the RAM for one. Screenshots and logs go to $OUT.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VM="${KV_WIN_VM:-$HOME/vms/win11}"
MODE="${1:-}"
case "$MODE" in fullcycle|integration) ;; *) sed -n '2,6p' "$0" >&2; exit 2 ;; esac

for tool in docker wg node convert python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is needed" >&2; exit 1; }
done
[ -f "$VM/ssh.conf" ] || { echo "no Windows VM at $VM (KV_WIN_VM)" >&2; exit 1; }
if pgrep -af qemu | grep -q 'noble'; then echo "the Ubuntu VM is running: stop it first (RAM)" >&2; exit 1; fi

WORK="$(mktemp -d)"
OUT="${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/kv-winvm.XXXX")}"
SSH=(ssh -F "$VM/ssh.conf" win)
TUNNEL_PID=""
SERVERS=(kv-win-wg kv-win-awg kv-win-socks)

finish() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ "${KEEP:-}" = 1 ] || docker rm -f "${SERVERS[@]}" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap finish EXIT

pass=0; fail=0
ok() { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
section() { printf '\n== %s\n' "$1"; }

vm() { "${SSH[@]}" "$@"; }
put() { scp -q -F "$VM/ssh.conf" "$@" win:C:/kv/; }
qmp() { python3 "$VM/qmp.py" "$1"; }
# Run one of the PowerShell files below in the VM, counting its PASS/FAIL lines here.
ps1() {
  local f="$1"; shift
  put "$WORK/$f" || { no "copy $f to the VM"; return; }
  local line
  while IFS= read -r line; do
    line="${line%$'\r'}"
    printf '%s\n' "$line"
    case "$line" in "  PASS  "*) pass=$((pass+1)) ;; "  FAIL  "*) fail=$((fail+1)) ;; esac
  done < <(vm "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\kv\\$f $*" 2>&1)
}
shot() {
  qmp "screendump $OUT/$1.ppm" >/dev/null 2>&1 && convert "$OUT/$1.ppm" "$OUT/$1.png" && rm -f "$OUT/$1.ppm" \
    && printf '  ....  screenshot %s\n' "$OUT/$1.png"
}

# --- the PowerShell side ------------------------------------------------------------

# Dot-sourced by every script: the PASS/FAIL line, and a client for the service's pipe.
cat > "$WORK/common.ps1" <<'EOF'
function Check([string]$Name, [scriptblock]$Test) {
  try { if (& $Test) { "  PASS  $Name" } else { "  FAIL  $Name" } }
  catch { "  FAIL  $Name ($($_.Exception.Message.Split([Environment]::NewLine)[0]))" }
}
$script:kvId = 0
function Kv([string]$Op, $KvArgs = $null) {
  $p = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'ProtectedPrefix\Administrators\Katacomb VPN\daemon', [System.IO.Pipes.PipeDirection]::InOut)
  $p.Connect(5000)
  try {
    $w = New-Object System.IO.StreamWriter($p); $w.AutoFlush = $true; $w.NewLine = "`n"
    $r = New-Object System.IO.StreamReader($p)
    $script:kvId++
    $req = @{ id = $script:kvId; op = $Op }
    if ($null -ne $KvArgs) { $req.args = $KvArgs }
    $w.WriteLine(($req | ConvertTo-Json -Compress -Depth 6))
    return ($r.ReadLine() | ConvertFrom-Json)
  } finally { $p.Dispose() }
}
function Gets([string]$Url) { curl.exe -s -m 8 -o NUL -w "%{http_code}" $Url }
function Resolves([string]$Server) {
  try { [bool](Resolve-DnsName example.com -Server $Server -DnsOnly -QuickTimeout -ErrorAction Stop) } catch { $false }
}
function OurFilters {
  netsh wfp show filters file=C:\kv\wfp.xml | Out-Null
  ([regex]::Matches((Get-Content C:\kv\wfp.xml -Raw), '4b61746b-6b73')).Count
}
EOF

cat > "$WORK/install.ps1" <<'EOF'
param([string]$Setup, [switch]$AppRunning)
. C:\kv\common.ps1
$p = Start-Process -FilePath $Setup -ArgumentList '/S' -Wait -PassThru
Check "a silent install exits 0 (exit $($p.ExitCode))" { $p.ExitCode -eq 0 }
if ($AppRunning) { Check 'the installer closed the running app' { -not (Get-Process 'Katacomb VPN' -ErrorAction SilentlyContinue) } }
$svc = Get-Service KatacombVPN -ErrorAction SilentlyContinue
Check 'the service is running' { $svc.Status -eq 'Running' }
Check 'it starts automatically' { $svc.StartType -eq 'Automatic' }
$cim = Get-CimInstance Win32_Service -Filter "Name='KatacombVPN'"
$sid = (New-Object System.Security.Principal.NTAccount('tester')).Translate([System.Security.Principal.SecurityIdentifier]).Value
Check 'it runs the shipped helper from Program Files, for the installing user' {
  $cim.PathName -eq "`"C:\Program Files\Katacomb VPN\resources\win\privileged\katacomb-vpn-helper.exe`" daemon $sid" }
Check 'as LocalSystem' { $cim.StartName -eq 'LocalSystem' }
Check 'and is restarted after a crash' { (sc.exe qfailure KatacombVPN) -match 'RESTART' }
$res = 'C:\Program Files\Katacomb VPN\resources'
foreach ($f in 'win\bin\v2ray.exe', 'win\bin\xray.exe', 'win\bin\hysteria.exe', 'win\bin\LICENSE.xray',
                'win\privileged\katacomb-vpn-helper.exe', 'win\privileged\wintun.dll', 'win\privileged\LICENSE.wintun') {
  Check "ships $f" { Test-Path "$res\$f" }
}
Check 'ships no Linux binaries' { -not (Test-Path "$res\linux") }
$pv = Kv 'protocol_version'
Check 'the pipe answers protocol_version 1' { $pv.ok -and $pv.result.version -eq 1 }
Check 'with the Windows op list: tun_up, no openvpn_up' { ($pv.result.ops -contains 'tun_up') -and -not ($pv.result.ops -contains 'openvpn_up') }
Check 'the state directory is SYSTEM and Administrators only' {
  $who = (Get-Acl 'C:\ProgramData\Katacomb VPN').Access | ForEach-Object { $_.IdentityReference.Value }
  -not ($who | Where-Object { $_ -notin @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators') }) }
Check 'Defender reports nothing' { -not (Get-MpThreatDetection -ErrorAction SilentlyContinue) }
EOF

# [PH-10] The pipe admits the installing user and refuses another standard one. The other
# user is logged on in-process and impersonated (a standard account has no batch logon
# right for a scheduled task, and ssh is session 0, where Start-Process -Credential
# fails). The control is the installing user's own unelevated token, from a task in the
# desktop session: it must connect, or a refusal proves nothing.
cat > "$WORK/pipe-acl.ps1" <<'EOF'
. C:\kv\common.ps1
$probe = { try {
    $p = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'ProtectedPrefix\Administrators\Katacomb VPN\daemon', [System.IO.Pipes.PipeDirection]::InOut)
    $p.Connect(3000); $p.Dispose(); 'CONNECTED'
  } catch { $_.Exception.GetBaseException().GetType().Name } }

$out = 'C:\Users\Public\kv-pipe-probe.txt'
Remove-Item $out -ErrorAction SilentlyContinue
"& { $probe } | Set-Content $out" | Set-Content C:\Users\Public\kv-pipe-probe.ps1
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Users\Public\kv-pipe-probe.ps1'
$pr = New-ScheduledTaskPrincipal -UserId 'tester' -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName kv-pipe-probe -Action $a -Principal $pr -Force | Out-Null
Start-ScheduledTask -TaskName kv-pipe-probe
for ($i = 0; $i -lt 60 -and -not (Test-Path $out); $i++) { Start-Sleep 1 }
$mine = Get-Content $out -ErrorAction SilentlyContinue
Check "[PH-10] control: the installing user, unelevated, is admitted (got: $mine)" { $mine -eq 'CONNECTED' }
Unregister-ScheduledTask -TaskName kv-pipe-probe -Confirm:$false
Remove-Item C:\Users\Public\kv-pipe-probe.ps1, $out -ErrorAction SilentlyContinue

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class KvLogon {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
}
'@
$user = 'kvother'
$pw = 'Kv' + [guid]::NewGuid().ToString('N').Substring(0, 12) + '!x1'
net user $user $pw /add /y | Out-Null
$tok = [IntPtr]::Zero
$theirs = 'no logon'
if ([KvLogon]::LogonUser($user, '.', $pw, 2, 0, [ref]$tok)) {
  $h = New-Object Microsoft.Win32.SafeHandles.SafeAccessTokenHandle($tok)
  [System.Security.Principal.WindowsIdentity]::RunImpersonated($h, [Action]{ $script:theirs = & $probe })
}
Check "[PH-10] another standard user is refused by the pipe (got: $theirs)" { $theirs -eq 'UnauthorizedAccessException' }
net user $user /delete | Out-Null
EOF

cat > "$WORK/launch-app.ps1" <<'EOF'
$a = New-ScheduledTaskAction -Execute 'C:\Program Files\Katacomb VPN\Katacomb VPN.exe' -Argument '--remote-debugging-port=9222'
$p = New-ScheduledTaskPrincipal -UserId 'tester' -LogonType Interactive -RunLevel Limited
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName kv-app -Action $a -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName kv-app
# The first start of a new unsigned executable waits on Defender's scan.
for ($i = 0; $i -lt 180; $i++) {
  try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 2 | Out-Null; 'CDP up'; exit 0 } catch { Start-Sleep 1 }
}
'CDP never answered'; exit 1
EOF

cat > "$WORK/runkey.ps1" <<'EOF'
param([string]$Want)
. C:\kv\common.ps1
$v = (Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -ErrorAction SilentlyContinue).'electron.app.Katacomb VPN'
if ($Want -eq 'present') { Check "[PKG-2] the Run entry starts the installed app with --autostart ($v)" { $v -eq '"C:\Program Files\Katacomb VPN\Katacomb VPN.exe" --autostart' } }
else { Check '[PKG-2] switched off, the Run entry is gone' { -not $v } }
EOF

# Tunnels through the service's pipe. Each config arrives base64-encoded on the
# command line; the servers answer HTTP on their tunnel address.
cat > "$WORK/integration.ps1" <<'EOF'
param([string]$HostIp, [string]$WgB64, [string]$AwgB64, [int]$SocksPort)
. C:\kv\common.ps1
$dec = { param($b) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
$wg = & $dec $WgB64; $awg = & $dec $AwgB64
$def = Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1
$lanDns = (Get-DnsClientServerAddress -InterfaceIndex $def.ifIndex -AddressFamily IPv4).ServerAddresses | Select-Object -First 1
function Via([string]$Ip) { (Find-NetRoute -RemoteIPAddress $Ip -ErrorAction SilentlyContinue).InterfaceAlias }
Check "the host's servers are reachable before any tunnel ($HostIp)" { Test-NetConnection $HostIp -Port $SocksPort -InformationLevel Quiet }

"== WireGuard, a stock kernel server"
$r = Kv 'wireguard_up' @{ configString = $wg }
Check "wireguard_up ($($r.error))" { $r.ok }
Check 'sntl0 is up' { (Get-NetAdapter -Name sntl0 -ErrorAction Stop).Status -eq 'Up' }
Check "HTTP to the server's tunnel address" { (Gets http://10.98.0.1:8080/) -eq '200' }
Check 'the internet, through the tunnel' { (Gets https://1.1.1.1/) -in '200', '301' }
Check 'a public address routes into the tunnel' { (Via 1.1.1.1) -contains 'sntl0' }
Check 'the endpoint itself routes via the uplink' { (Via $HostIp) -notcontains 'sntl0' }
Check 'the handshake age is read from the service' { $h = (Kv 'wireguard_handshake').result; $h.kernel -and $h.ageSeconds -ge 0 }
Check 'the byte counters move' { (Kv 'traffic_counters' @{ iface = 'sntl0' }).result.rxBytes -gt 0 }
Check "[REL-44] DNS to the LAN resolver ($lanDns) is blocked" { -not (Resolves $lanDns) }
Check '[REL-44] DNS through the tunnel answers' { Resolves 1.1.1.1 }
$r = Kv 'wireguard_down'
Check 'wireguard_down' { $r.ok }
Check 'sntl0 is gone' { -not (Get-NetAdapter -Name sntl0 -ErrorAction SilentlyContinue) }
Check "the endpoint's route is gone" { -not (Get-NetRoute -DestinationPrefix "$HostIp/32" -ErrorAction SilentlyContinue) }
Check 'DNS to the LAN resolver works again' { Resolves $lanDns }

"== AmneziaWG, the reference peer"
$r = Kv 'amneziawg_up' @{ configString = $awg }
Check "amneziawg_up ($($r.error))" { $r.ok }
Check "HTTP to the server's tunnel address: the obfuscated handshake completed" { (Gets http://10.97.0.1:8080/) -eq '200' }
Check '[REL-45] the handshake age is read for AmneziaWG too' { $h = (Kv 'wireguard_handshake').result; $h.kernel -and $h.ageSeconds -ge 0 }
$r = Kv 'amneziawg_down'
Check 'amneziawg_down, sntl0 gone' { $r.ok -and -not (Get-NetAdapter -Name sntl0 -ErrorAction SilentlyContinue) }

"== tun2socks, through an xray SOCKS server"
$r = Kv 'tun_up' @{ socksAddr = "$HostIp`:$SocksPort"; remoteHost = $HostIp; gateway = $def.NextHop; iface = "$($def.ifIndex)"; bypassRoutes = @('203.0.113.0/24', 'not-a-cidr') }
Check "tun_up ($($r.error))" { $r.ok }
Check 'sntl-tun is up' { (Get-NetAdapter -Name sntl-tun -ErrorAction Stop).Status -eq 'Up' }
Check 'HTTPS through the SOCKS server' { (Gets https://example.com/) -eq '200' }
Check 'a public address routes into sntl-tun' { (Via 1.1.1.1) -contains 'sntl-tun' }
Check 'the split-tunnel route goes via the uplink, the bad entry dropped' { (Via 203.0.113.9) -notcontains 'sntl-tun' }
$r = Kv 'dns_set' @{ dnsIp = '1.1.1.1' }
Check "[REL-44] dns_set: the LAN resolver is blocked ($($r.error))" { $r.ok -and -not (Resolves $lanDns) }
$r = Kv 'dns_restore'
$r = Kv 'tun_down'
Check 'tun_down, sntl-tun gone' { $r.ok -and -not (Get-NetAdapter -Name sntl-tun -ErrorAction SilentlyContinue) }
Check 'the SOCKS server and split-tunnel routes are gone' { -not (Get-NetRoute -DestinationPrefix "$HostIp/32", '203.0.113.0/24' -ErrorAction SilentlyContinue) }

EOF

# The kill switch blocks the VM's incoming ssh too, so this runs as a SYSTEM task inside
# the VM, and the host collects its lines once the network is back. Whatever happens, it
# ends with the kill switch off: killswitch_off, or the service's full teardown.
cat > "$WORK/killswitch.ps1" <<'EOF'
param([string]$HostIp)
. C:\kv\common.ps1
$wg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((Get-Content C:\kv\wg.b64 -Raw).Trim()))
$def = Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1
$lanDns = (Get-DnsClientServerAddress -InterfaceIndex $def.ifIndex -AddressFamily IPv4).ServerAddresses | Select-Object -First 1
$lines = & {
  "== the kill switch, and a service killed under it"
  try {
    $r = Kv 'wireguard_up' @{ configString = $wg }
    $r = Kv 'killswitch_on' @{ iface = 'sntl0'; remoteHost = $HostIp; dnsIp = '1.1.1.1'; lanSharing = $false }
    Check "killswitch_on ($($r.error))" { $r.ok }
    Check '[REL-43] the tunnel works under it' { (Gets http://10.98.0.1:8080/) -eq '200' }
    Check '[REL-43] the LAN is blocked' { -not (Resolves $lanDns) }
    $svcPid = (Get-CimInstance Win32_Service -Filter "Name='KatacombVPN'").ProcessId
    Stop-Process -Id $svcPid -Force
    Start-Sleep 1
    Check '[REL-43] with the service killed, the tunnel is gone and nothing gets out' {
      -not (Get-NetAdapter -Name sntl0 -ErrorAction SilentlyContinue) -and (Gets https://1.1.1.1/) -eq '000' }
    for ($i = 0; $i -lt 30 -and (Get-Service KatacombVPN).Status -ne 'Running'; $i++) { Start-Sleep 1 }
    Start-Sleep 2
    Check 'the service restarted' { (Get-CimInstance Win32_Service -Filter "Name='KatacombVPN'").ProcessId -notin 0, $svcPid }
    Check '[REL-43] and the kill switch still blocks' { (Gets https://1.1.1.1/) -eq '000' }
  } finally {
    $off = $false
    try { $off = (Kv 'killswitch_off').ok } catch { }
    if (-not $off) { & 'C:\Program Files\Katacomb VPN\resources\win\privileged\katacomb-vpn-helper.exe' service teardown | Out-Null }
  }
  Check 'killswitch_off restores the network' { $off -and (Gets https://1.1.1.1/) -in '200', '301' }
  "== nothing left behind"
  Check 'no sntl adapter' { -not (Get-NetAdapter -IncludeHidden | Where-Object Name -like 'sntl*') }
  Check 'no route to the servers' { -not (Get-NetRoute -DestinationPrefix "$HostIp/32" -ErrorAction SilentlyContinue) }
  Check 'no recorded route' { -not (Get-Content 'C:\ProgramData\Katacomb VPN\routes.state' -ErrorAction SilentlyContinue) }
  Check 'no Katacomb filter' { (OurFilters) -eq 0 }
}
$lines | Set-Content C:\kv\ks.out
New-Item -ItemType File -Force C:\kv\ks.done | Out-Null
EOF

cat > "$WORK/ks-start.ps1" <<'EOF'
param([string]$HostIp)
Remove-Item C:\kv\ks.out, C:\kv\ks.done -ErrorAction SilentlyContinue
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\kv\killswitch.ps1 -HostIp $HostIp"
Register-ScheduledTask -TaskName kv-killswitch -Action $a -User SYSTEM -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName kv-killswitch
EOF

cat > "$WORK/uninstall.ps1" <<'EOF'
. C:\kv\common.ps1
$u = Get-ChildItem 'C:\Program Files\Katacomb VPN' -Filter 'Uninstall*.exe' | Select-Object -First 1
$p = Start-Process -FilePath $u.FullName -ArgumentList '/S' -Wait -PassThru
# The uninstaller hands over to a copy of itself and returns before the files go.
for ($i = 0; $i -lt 60 -and (Test-Path 'C:\Program Files\Katacomb VPN'); $i++) { Start-Sleep 1 }
Check "a silent uninstall exits 0 (exit $($p.ExitCode))" { $p.ExitCode -eq 0 }
Check 'the app was closed' { -not (Get-Process 'Katacomb VPN' -ErrorAction SilentlyContinue) }
Check '[PKG-3] the service is gone' { -not (Get-Service KatacombVPN -ErrorAction SilentlyContinue) }
Check 'the install directory is gone' { -not (Test-Path 'C:\Program Files\Katacomb VPN') }
Check 'the state directory is gone' { -not (Test-Path 'C:\ProgramData\Katacomb VPN') }
Check 'no sntl adapter' { -not (Get-NetAdapter -IncludeHidden | Where-Object Name -like 'sntl*') }
Check 'no Katacomb filter' { (OurFilters) -eq 0 }
Check 'no start-at-login entry' { -not (Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -ErrorAction SilentlyContinue).'electron.app.Katacomb VPN' }
Check "the user's data is kept (wallets survive a reinstall)" { Test-Path "$env:APPDATA\katacomb-vpn" }
EOF

# --- DevTools, from the host -------------------------------------------------------------

cat > "$WORK/cdp.mjs" <<'EOF'
// node cdp.mjs <port> '<expression>': evaluates in the app's page, prints the JSON result.
const [port, expr] = process.argv.slice(2)
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== 1) return
  if (m.result?.exceptionDetails) { console.error(m.result.exceptionDetails.exception?.description ?? 'exception'); process.exit(1) }
  console.log(JSON.stringify(m.result?.result?.value ?? null))
  process.exit(0)
}
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
setTimeout(() => { console.error('timeout'); process.exit(2) }, 30000)
EOF
cdp() { node "$WORK/cdp.mjs" 19222 "$1" 2>&1; }
cdp_check() { if [ "$(cdp "$2")" = true ]; then ok "$1"; else no "$1"; fi; }

# --- the host side ----------------------------------------------------------------------

HOST_IP="$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
WG_PORT=51830; AWG_PORT=51831; SOCKS_PORT=10838

servers() {
  section "test servers in docker on the host ($HOST_IP)"
  docker rm -f "${SERVERS[@]}" >/dev/null 2>&1
  mkdir -p "$WORK/srv"
  WG_SRV=$(wg genkey); WG_CLI=$(wg genkey); AWG_SRV=$(wg genkey); AWG_CLI=$(wg genkey)
  pub() { printf '%s' "$1" | wg pubkey; }
  OBFS=$'Jc = 4\nJmin = 128\nJmax = 800\nS1 = 15\nS2 = 40\nS3 = 20\nS4 = 10\nH1 = 1234567891\nH2 = 987654321\nH3 = 246813579\nH4 = 1357924680'

  printf '[Interface]\nAddress = 10.98.0.1/24\nListenPort = %s\nPrivateKey = %s\n\n[Peer]\nPublicKey = %s\nAllowedIPs = 10.98.0.2/32\n' \
    "$WG_PORT" "$WG_SRV" "$(pub "$WG_CLI")" > "$WORK/srv/wg0.conf"
  printf '[Interface]\nAddress = 10.97.0.1/24\nListenPort = %s\nPrivateKey = %s\n%s\n\n[Peer]\nPublicKey = %s\nAllowedIPs = 10.97.0.2/32\n' \
    "$AWG_PORT" "$AWG_SRV" "$OBFS" "$(pub "$AWG_CLI")" > "$WORK/srv/awg0.conf"
  cat > "$WORK/srv/socks.json" <<EOF
{"log":{"loglevel":"warning"},"inbounds":[{"listen":"0.0.0.0","port":$SOCKS_PORT,"protocol":"socks","settings":{"auth":"noauth","udp":true}}],"outbounds":[{"protocol":"freedom"}]}
EOF
  chmod 600 "$WORK/srv/"*.conf

  WG_CLIENT=$(printf '[Interface]\nPrivateKey = %s\nAddress = 10.98.0.2/24\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = %s\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = %s:%s\nPersistentKeepalive = 15\n' \
    "$WG_CLI" "$(pub "$WG_SRV")" "$HOST_IP" "$WG_PORT")
  AWG_CLIENT=$(printf '[Interface]\nPrivateKey = %s\nAddress = 10.97.0.2/32\n%s\n\n[Peer]\nPublicKey = %s\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = %s:%s\nPersistentKeepalive = 15\n' \
    "$AWG_CLI" "$OBFS" "$(pub "$AWG_SRV")" "$HOST_IP" "$AWG_PORT")

  # The servers NAT their tunnel to the internet and serve HTTP on their tunnel address.
  local serve='iptables -t nat -A POSTROUTING -s 10.9$1.0.0/24 -o eth0 -j MASQUERADE; cd /tmp && exec python3 -m http.server 8080 --bind 10.9$1.0.1'
  docker run -d --name kv-win-wg --privileged -p "$WG_PORT:$WG_PORT/udp" -v "$WORK/srv:/cfg:ro" debian:bookworm sleep infinity >/dev/null
  docker exec kv-win-wg bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends wireguard-tools iproute2 iptables python3' >"$WORK/wg-apt.log" 2>&1 \
    && docker exec kv-win-wg bash -c 'sysctl -qw net.ipv4.ip_forward=1; cp /cfg/wg0.conf /etc/wireguard/ && wg-quick up wg0' >"$WORK/wg-up.log" 2>&1 \
    && docker exec -d kv-win-wg bash -c "${serve//\$1/8}" && ok "stock WireGuard on udp/$WG_PORT" || { no "stock WireGuard server"; tail -5 "$WORK"/wg-*.log; }

  # The reference peer, built once per pinned pair of commits (verify-awg-handshake.sh's).
  local go_commit tools_commit image
  go_commit=$(sed -n 's/^AWG_GO_COMMIT=//p' "$REPO/scripts/verify-awg-handshake.sh")
  tools_commit=$(sed -n 's/^AWG_TOOLS_COMMIT=//p' "$REPO/scripts/verify-awg-handshake.sh")
  image="katacomb-awg-ref:${go_commit:0:7}-${tools_commit:0:7}"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf '  ....  building the AmneziaWG reference peer (%s, about 2 minutes)\n' "$image"
    docker build --network host -t "$image" - >"$WORK/awg-build.log" 2>&1 <<EOF || { no "building the AmneziaWG reference peer"; tail -15 "$WORK/awg-build.log"; }
FROM golang:1.27-bookworm AS build
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends build-essential git
RUN git clone -q https://github.com/amnezia-vpn/amneziawg-go /src/go && git -C /src/go checkout -q $go_commit \\
 && cd /src/go && CGO_ENABLED=0 go build -trimpath -o /out/amneziawg-go .
RUN git clone -q https://github.com/amnezia-vpn/amneziawg-tools /src/tools && git -C /src/tools checkout -q $tools_commit \\
 && make -s -C /src/tools/src && make -s -C /src/tools/src install DESTDIR=/inst PREFIX=/usr WITH_BASHCOMPLETION=no WITH_SYSTEMDUNITS=no \\
 && cp /inst/usr/bin/awg /inst/usr/bin/awg-quick /out/
FROM debian:bookworm
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends iproute2 iptables python3 procps && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /usr/local/bin/
EOF
  fi
  docker run -d --name kv-win-awg --privileged -p "$AWG_PORT:$AWG_PORT/udp" -v "$WORK/srv:/cfg:ro" "$image" sleep infinity >/dev/null \
    && docker exec kv-win-awg bash -c 'sysctl -qw net.ipv4.ip_forward=1; mkdir -p /etc/amnezia/amneziawg && cp /cfg/awg0.conf /etc/amnezia/amneziawg/ && awg-quick up awg0' >"$WORK/awg-up.log" 2>&1 \
    && docker exec -d kv-win-awg bash -c "${serve//\$1/7}" && ok "AmneziaWG reference peer on udp/$AWG_PORT" || { no "AmneziaWG server"; tail -5 "$WORK/awg-up.log"; }

  docker run -d --name kv-win-socks -p "$SOCKS_PORT:$SOCKS_PORT/tcp" -p "$SOCKS_PORT:$SOCKS_PORT/udp" \
    -v "$REPO/resources/linux/bin/xray:/usr/local/bin/xray:ro" -v "$WORK/srv:/cfg:ro" debian:bookworm xray run -c /cfg/socks.json >/dev/null \
    && ok "xray SOCKS on $SOCKS_PORT" || no "xray SOCKS server"
}

integration() {
  servers
  section "tunnels through the service's pipe"
  vm 'New-Item -ItemType Directory -Force C:\kv | Out-Null' >/dev/null
  put "$WORK/common.ps1"
  ps1 integration.ps1 -HostIp "$HOST_IP" -WgB64 "$(printf '%s' "$WG_CLIENT" | base64 -w0)" \
    -AwgB64 "$(printf '%s' "$AWG_CLIENT" | base64 -w0)" -SocksPort "$SOCKS_PORT"

  printf '%s' "$WG_CLIENT" | base64 -w0 > "$WORK/wg.b64"
  put "$WORK/wg.b64" "$WORK/killswitch.ps1"
  ps1 ks-start.ps1 -HostIp "$HOST_IP"
  # Unreachable while the kill switch is up; ssh's ConnectTimeout bounds each try.
  local i finished=""
  for i in $(seq 1 60); do
    sleep 5
    if vm 'Test-Path C:\kv\ks.done' 2>/dev/null | grep -q True; then finished=1; break; fi
  done
  [ -n "$finished" ] || { no "the kill switch run finished and the VM came back"; return; }
  local line
  while IFS= read -r line; do
    line="${line%$'\r'}"
    printf '%s\n' "$line"
    case "$line" in "  PASS  "*) pass=$((pass+1)) ;; "  FAIL  "*) fail=$((fail+1)) ;; esac
  done < <(vm 'Get-Content C:\kv\ks.out; Unregister-ScheduledTask -TaskName kv-killswitch -Confirm:$false' 2>&1)
}

revert() {
  section "revert the VM to its clean snapshot"
  if [ -S "$VM/qmp.sock" ] && qmp 'info status' >/dev/null 2>&1; then
    qmp 'loadvm clean' >/dev/null
  else
    ("$VM/start.sh" -loadvm clean >"$OUT/qemu.log" 2>&1 &)
  fi
  local i
  for i in $(seq 1 90); do
    if vm qwinsta 2>/dev/null | grep -q 'tester.*Active'; then break; fi
    sleep 5
  done
  vm qwinsta 2>/dev/null | grep -q 'tester.*Active' || { no "the VM's desktop session came up"; exit 1; }
  # The snapshot's clock is days old; certificates and the chain care.
  vm "Set-Date -Date '$(date -u +%Y-%m-%dT%H:%M:%SZ)' | Out-Null; New-Item -ItemType Directory -Force C:\\kv | Out-Null" >/dev/null
  ok "the clean desktop is up"
}

app() {
  section "the app, in the desktop session"
  put "$WORK/launch-app.ps1" "$WORK/runkey.ps1"
  if ! vm 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\kv\launch-app.ps1' | grep -q 'CDP up'; then
    no "the app started with DevTools"; return
  fi
  ssh -F "$VM/ssh.conf" -N -L 19222:127.0.0.1:9222 win & TUNNEL_PID=$!
  sleep 3
  cdp_check "the setup gate's one Windows row is ready: the service answers" \
    'window.api.setupStatus().then((s) => s.platform === "windows" && s.helper === "ready")'
  cdp_check "no other VPN is reported" 'window.api.connectionCheckVpn().then((v) => Array.isArray(v) && v.length === 0)'
  cdp_check "idle, nothing connected" 'window.api.connectionStatus().then((s) => s.state === "idle")'
  cdp_check "the welcome screen says five protocols" 'document.body.innerText.includes("Five protocols")'
  shot 01-welcome
  cdp_check "[PKG-2] start at login switches on" 'window.api.autostartSet(true).then((s) => s.enabled)'
  ps1 runkey.ps1 -Want present
  cdp_check "[PKG-2] and off" 'window.api.autostartSet(false).then((s) => !s.enabled)'
  ps1 runkey.ps1 -Want absent
  # Generated by the app inside the VM and never shown or copied out; it holds nothing.
  cdp_check "[REL-41] a throwaway unfunded wallet is stored (DPAPI) and opens" \
    'window.api.walletGenerate(12).then((m) => window.api.walletImport(m, "VM smoke")).then((r) => /^sent1/.test(r.address))'
  cdp 'location.reload(), true' >/dev/null; sleep 10
  local i name
  for i in 0 1 2 3 4 5; do
    name=$(cdp "(() => { const b = document.querySelectorAll('nav button')[$i]; if (!b) return ''; b.click(); return b.textContent.trim() })()" | tr -d '"')
    [ -n "$name" ] || break
    sleep 5
    ok "tab $name opens"
    shot "02-tab-$i-${name// /-}"
  done
  cdp '[...document.querySelectorAll("button")].find((b) => b.title === "Settings").click(), true' >/dev/null; sleep 2
  cdp '[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "system").click(), true' >/dev/null; sleep 3
  cdp_check "[PH-12] Settings, System: the VPN service row alone, Ready" \
    '(() => { const t = document.body.innerText; return t.includes("VPN service") && t.includes("Ready") && !t.includes("WireGuard tools") })()'
  shot 03-settings-system
  kill "$TUNNEL_PID" 2>/dev/null; TUNNEL_PID=""
}

if [ "$MODE" = integration ]; then
  integration
else
  VERSION="$(node -p "require('$REPO/package.json').version")"
  SETUP="${2:-$REPO/dist/katacomb-vpn-$VERSION-setup.exe}"
  [ -f "$SETUP" ] || { echo "no installer at $SETUP: npm run dist:win, or name one" >&2; exit 1; }
  printf 'installer: %s\nscreenshots and logs: %s\n' "$SETUP" "$OUT"
  revert
  section "install"
  put "$WORK/common.ps1" "$WORK/install.ps1" "$WORK/uninstall.ps1" "$SETUP"
  ps1 install.ps1 -Setup "C:\\kv\\$(basename "$SETUP")"
  ps1 pipe-acl.ps1
  app
  integration
  section "install again, over the running app"
  ps1 install.ps1 -Setup "C:\\kv\\$(basename "$SETUP")" -AppRunning
  section "uninstall"
  ps1 uninstall.ps1
  section "install once more, for the paid checks: snapshot katacomb-ready"
  ps1 install.ps1 -Setup "C:\\kv\\$(basename "$SETUP")"
  # No wallet in the snapshot, not even the throwaway one.
  vm 'Remove-Item -Recurse -Force "$env:APPDATA\katacomb-vpn" -ErrorAction SilentlyContinue' >/dev/null
  if [ "$fail" -eq 0 ]; then
    qmp 'savevm katacomb-ready' >/dev/null && ok "saved the VM as katacomb-ready" || no "saving the VM snapshot"
  else
    printf '  ....  not saving katacomb-ready: %d checks failed\n' "$fail"
  fi
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] && echo "ALL PASSED" || { echo "SOME CHECKS FAILED (KEEP=1 keeps the test servers)"; exit 1; }
