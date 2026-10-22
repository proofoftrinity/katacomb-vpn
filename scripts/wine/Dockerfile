# Wine for electron-builder's one Windows step on Linux: running the NSIS installer it
# has just made, which writes the uninstaller (docs/packaging.md, "Windows installer").
# Debian's own wine, from Debian's signed archive. electron-builder's bundled Linux Wine
# (toolsets.wine "1.0.1") is broken upstream: its archive has no x86_64-windows DLLs, so
# wine dies with ntdll c0000135 before running anything (seen 2026-10-22).
FROM debian:trixie
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends wine wine64 wine32:i386 \
 && rm -rf /var/lib/apt/lists/*
