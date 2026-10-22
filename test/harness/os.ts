import * as os from 'node:os'

// Stands in for `os` inside a test bundle (BundleSpec.stubs): the real module, except
// that a test can say which network interfaces exist (fakes['os'].networkInterfaces),
// for the Windows branches that read adapter presence from it.
export * from 'node:os'

export function networkInterfaces(): ReturnType<typeof os.networkInterfaces> {
  const fake = globalThis.__kvWorld?.fakes.os?.networkInterfaces
  return fake ? fake() as ReturnType<typeof os.networkInterfaces> : os.networkInterfaces()
}
