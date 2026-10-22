// Stands in for src/main/platform.ts inside a test bundle, so a Linux test run can
// drive the Windows branches: `stubs: { 'src/main/platform': 'test/harness/platform-windows.ts' }`.

export const IS_WINDOWS = true

export const RESOURCE_PLATFORM_DIR = 'win'

export function executableName(name: string): string {
  return `${name}.exe`
}
