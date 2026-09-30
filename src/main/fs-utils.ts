import { writeFileSync, renameSync, accessSync, statSync, constants } from 'fs'
import { join } from 'path'

/**
 * Write a file atomically: write a sibling temp file, then rename over the
 * target (rename is atomic on the same filesystem). Defaults to 0o600 so
 * settings / wallet-index / cache files aren't created world-readable. A
 * crash mid-write leaves the previous file intact instead of a truncated one.
 */
export function writeFileAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, path)
}

/**
 * Is `name` an executable file in one of `pathEnv`'s directories? What `which`
 * answers, without needing `which`: it is not in Arch's base install, and exec'ing
 * it there failed for every name, so an installed wg-quick read as missing and
 * every WireGuard connect was refused (seen on a minimal Arch VM, 2026-09-29).
 */
export function isOnPath(name: string, pathEnv: string): boolean {
  return pathEnv.split(':').some((dir) => {
    if (!dir) return false
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}
