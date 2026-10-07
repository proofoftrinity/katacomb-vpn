import * as sdk from '@sentinel-official/sentinel-js-sdk'
import { world } from './world.ts'

// Stands in for the SDK's root inside a test bundle (BundleSpec.stubs): the real SDK,
// except that opening a signing connection is answered by the test's
// fakes['sdk'].connectWithSigner, so a module that dials the chain on its own (endSession,
// the standalone purchases) runs against a client the test controls.
export * from '@sentinel-official/sentinel-js-sdk'

export class SigningSentinelClient extends sdk.SigningSentinelClient {
  static override connectWithSigner(...args: unknown[]): any {
    return world().call('sdk', 'connectWithSigner', args)
  }
}
