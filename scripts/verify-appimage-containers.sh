#!/usr/bin/env bash
# Katacomb VPN — prove the built AppImage starts on distro images that have NO
# libfuse2, without a desktop and without root on the host (docker only).
#
#     ./scripts/verify-appimage-containers.sh                 # newest dist/*.AppImage, all images
#     ./scripts/verify-appimage-containers.sh ubuntu:24.04    # one image
#     APPIMAGE_FILE=/path/to/other.AppImage ./scripts/verify-appimage-containers.sh
#
# The AppImage half of the container discipline in docs/packaging.md. Up to 1.11.0
# the AppImage's runtime dlopened libfuse.so.2, which stock Ubuntu 22.04+ does not
# ship, so it died before any window; electron-builder.yml now pins the static
# FUSE 3 runtime, and this checks it still does its job.
# On the file itself (host side):
#   - the runtime is statically linked (no libfuse.so.2 to load) and reports itself
#     as AppImage/type2-runtime;
#   - usr/lib/libasound.so.2 is still staged (see docs/packaging.md);
#   - the embedded .desktop does not force --no-sandbox (AppRun's probe decides).
# Per image, with GUI libraries and a fusermount installed but no libfuse2:
#   - the AppImage mounts itself and the app keeps running from the mount;
#   - a "Katacomb VPN" window is mapped on Xvfb;
#   - root cannot read the mount (why the helper install stages through mkdtemp).
# The container gets /dev/fuse and SYS_ADMIN with AppArmor and seccomp unconfined,
# which is what a FUSE mount inside docker needs; the host is never touched.
# `fedora:44+fuse2` is fedora:44 with only the FUSE 2 `fusermount` and no fuse3.
# Against a pre-1.11.1 AppImage every image FAILS: that is the calibration.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AI="${APPIMAGE_FILE:-$(ls -t "$REPO_ROOT"/dist/katacomb-vpn-*.AppImage 2>/dev/null | head -1)}"
[ -n "$AI" ] && [ -f "$AI" ] || { echo "No dist/katacomb-vpn-*.AppImage found — run 'npm run dist:appimage' first." >&2; exit 1; }
AI="$(readlink -f "$AI")"
IMAGES=("$@")
[ ${#IMAGES[@]} -gt 0 ] || IMAGES=(debian:bookworm debian:trixie ubuntu:22.04 ubuntu:24.04 ubuntu:26.04 fedora:44 fedora:44+fuse2)

overall=0
pass=0; fail=0
ok()  { printf "  PASS  %s\n" "$1"; pass=$((pass+1)); }
no()  { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); overall=1; }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else no "$2"; fi; }

printf '\033[1m== %s ==\033[0m\n' "$(basename "$AI")"
OFF="$("$AI" --appimage-offset 2>/dev/null)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
head -c "$OFF" "$AI" > "$TMP/runtime"
check "! readelf -d '$TMP/runtime' | grep -q NEEDED" "runtime is statically linked (loads no libfuse.so.2)"
check "'$AI' --appimage-version 2>&1 | grep -q type2-runtime" "runtime is AppImage/type2-runtime"
(cd "$TMP" && "$AI" --appimage-extract '*.desktop' >/dev/null 2>&1 && "$AI" --appimage-extract 'usr/lib/libasound.so.2' >/dev/null 2>&1)
check "[ -f '$TMP/squashfs-root/usr/lib/libasound.so.2' ]" "usr/lib/libasound.so.2 staged"
check "grep -q '^Exec=AppRun' '$TMP'/squashfs-root/*.desktop && ! grep -q -- '--no-sandbox' '$TMP'/squashfs-root/*.desktop" "embedded .desktop does not force --no-sandbox"
printf "\nfile: %d passed, %d failed\n" "$pass" "$fail"

INNER='
set -u
pass=0; fail=0
ok()  { printf "  PASS  %s\n" "$1"; pass=$((pass+1)); }
no()  { printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else no "$2"; fi; }
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || { echo "apt-get update failed"; exit 2; }
  GTK=libgtk-3-0t64; apt-cache show $GTK >/dev/null 2>&1 || GTK=libgtk-3-0
  apt-get install -y -qq --no-install-recommends fuse3 xvfb x11-utils procps util-linux $GTK libnss3 libgbm1 libxss1 libxtst6 libsecret-1-0 libdrm2 >/tmp/install.log 2>&1
else
  dnf -y -q install --setopt=install_weak_deps=False $FUSEPKG xorg-x11-server-Xvfb xwininfo procps-ng util-linux shadow-utils gtk3 nss mesa-libgbm libXScrnSaver libXtst libsecret libdrm >/tmp/install.log 2>&1
fi || { echo "  package install failed"; tail -20 /tmp/install.log; exit 2; }
U="$(getent passwd 1000 | cut -d: -f1)"
[ -n "$U" ] || { useradd -m -u 1000 tester; U=tester; }
H="$(getent passwd 1000 | cut -d: -f6)"
cp /tmp/app.AppImage "$H/katacomb-vpn.AppImage" && chown "$U" "$H/katacomb-vpn.AppImage"
check "! ldconfig -p | grep -q libfuse.so.2" "no libfuse.so.2 on this image (the case under test)"
echo "  ....  fusermount: $(command -v fusermount3 || command -v fusermount || echo none)"
su "$U" -c "Xvfb :99 -screen 0 1200x800x24 >/dev/null 2>&1 &"
sleep 2
su "$U" -c "cd && DISPLAY=:99 ./katacomb-vpn.AppImage >app.log 2>&1 &"
MNT=""
for _ in $(seq 30); do MNT="$(findmnt -rn -o TARGET | grep "^/tmp/.mount_kataco" | head -1)"; [ -n "$MNT" ] && break; sleep 1; done
if [ -n "$MNT" ]; then ok "the AppImage mounted itself ($MNT)"; else no "no FUSE mount: $(head -3 "$H/app.log" | tr "\n" " ")"; fi
sleep 20
check "[ -n \"$MNT\" ] && pgrep -u \"$U\" -f \"^$MNT/katacomb-vpn\"" "the app is still running from the mount 20 s later"
check "DISPLAY=:99 xwininfo -root -tree | grep -q \"Katacomb VPN\"" "a Katacomb VPN window is mapped"
check "[ -n \"$MNT\" ] && ! cat \"$MNT/AppRun\"" "root cannot read the mount (why the helper install stages through mkdtemp)"
printf "\n%s: %d passed, %d failed\n" "$IMAGE" "$pass" "$fail"
[ "$fail" -eq 0 ]
'

for spec in "${IMAGES[@]}"; do
  img="${spec%+fuse2}"; fusepkg=fuse3
  [ "$img" != "$spec" ] && fusepkg=fuse
  printf '\n\033[1m== %s ==\033[0m\n' "$spec"
  if ! docker run --rm --device /dev/fuse --cap-add SYS_ADMIN \
      --security-opt apparmor=unconfined --security-opt seccomp=unconfined \
      -e IMAGE="$spec" -e FUSEPKG="$fusepkg" -v "$AI:/tmp/app.AppImage:ro" "$img" bash -c "$INNER"; then
    overall=1
  fi
done
[ "$overall" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $overall
