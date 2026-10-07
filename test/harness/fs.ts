import * as fs from 'node:fs'

// Stands in for `fs` inside a test bundle (BundleSpec.stubs): the real filesystem,
// except that a test can say which absolute paths exist (fakes['fs'].existsSync), for
// the checks that look outside the temp dirs a test owns (the system openvpn binary).
export * from 'node:fs'

export function existsSync(p: fs.PathLike): boolean {
  const fake = globalThis.__kvWorld?.fakes.fs?.existsSync
  return fake ? fake(p) as boolean : fs.existsSync(p)
}
