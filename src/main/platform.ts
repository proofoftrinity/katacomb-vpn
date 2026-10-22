// The app's two targets: Linux, and Windows (beta). Everything that differs between
// them branches on IS_WINDOWS; docs/windows.md says how each Linux mechanism maps.
// A test reaches the Windows branches by swapping this module for
// test/harness/platform-windows.ts (bundle.ts `stubs`).

export const IS_WINDOWS = process.platform === 'win32'

/** Where the bundled binaries live under resources/: `linux/` or `win/`. */
export const RESOURCE_PLATFORM_DIR = IS_WINDOWS ? 'win' : 'linux'

/** A bundled executable's file name: `xray` on Linux, `xray.exe` on Windows. */
export function executableName(name: string): string {
  return IS_WINDOWS ? `${name}.exe` : name
}
