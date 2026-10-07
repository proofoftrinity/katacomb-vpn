import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModule, type ModuleHarness } from '../../test/harness/module.ts'
import { ROOT } from '../../test/harness/source.ts'

// [ARCH-5] Upgrades never lose the user's data. test/fixtures/settings/ holds the
// settings.json and wallets-index.json each past release wrote; the startup migrations
// (in index.ts's order) must carry every one of them forward with the user's choices
// intact, and running them again must change nothing.

const settings = await loadModule({ entries: ['src/main/settings.ts'], fake: [] })

type Fn = (...a: unknown[]) => unknown
const FIXTURES = join(ROOT, 'test/fixtures/settings')
const GENERATIONS = readdirSync(FIXTURES).filter((f) => f.endsWith('.settings.json')).map((f) => f.replace('.settings.json', '')).sort()

/** The migrations whenReady runs before anything else touches settings (src/main/index.ts). */
function startup(h: ModuleHarness): void {
  for (const step of ['migrateLegacyUserData', 'dedupeWalletEntries', 'migrateProviderModeToWallet', 'migrateRpcMode']) (h.mod[step] as Fn)()
}
const file = (h: ModuleHarness, name: string) => readFileSync(join(h.world.userData, name), 'utf-8')
const seed = (h: ModuleHarness, id: string, keyId = h.world.safeStorage.keyId) => {
  mkdirSync(join(h.world.userData, 'wallets'), { recursive: true })
  writeFileSync(join(h.world.userData, 'wallets', `${id}.enc`), `enc:${keyId}:abandon abandon about`)
}

describe('[ARCH-5] every settings generation a release wrote still loads', () => {
  assert.equal(GENERATIONS.length, 6, 'one fixture pair per DEFAULT_SETTINGS generation')
  for (const gen of GENERATIONS) {
    test(`[ARCH-5] ${gen}: the user's choices survive, and a second run changes nothing`, (t) => {
      const h = settings.fresh()
      t.after(() => h.dispose())
      const written = JSON.parse(readFileSync(join(FIXTURES, `${gen}.settings.json`), 'utf-8')) as Record<string, unknown>
      cpSync(join(FIXTURES, `${gen}.settings.json`), join(h.world.userData, 'settings.json'))
      cpSync(join(FIXTURES, `${gen}.wallets-index.json`), join(h.world.userData, 'wallets-index.json'))
      seed(h, 'w1'); seed(h, 'w2')
      startup(h)

      const s = (h.mod.loadSettings as Fn)() as Record<string, unknown>
      for (const key of ['activeWalletId', 'killSwitch', 'dnsResolver', 'autoReconnect', 'bookmarkedNodes', 'splitTunnelRoutes', 'rpcEndpoint']) {
        assert.deepEqual(s[key], written[key], `${key} was lost`)
      }
      assert.equal(s.rpcMode, written.rpcEndpoint === 'https://rpc.sentinel.co:443' ? 'auto' : 'manual',
        'a pre-feature custom endpoint is the user\'s choice: manual, never overwritten by Smart RPC')
      assert.equal(s.lanSharing, written.lanSharing ?? false)
      assert.ok(!('providerMode' in JSON.parse(file(h, 'settings.json'))), 'providerMode no longer lives in settings.json')
      const wallets = (h.mod.listWallets as Fn)() as Array<{ id: string; name: string; address: string }>
      assert.deepEqual(wallets.map((w) => [w.id, w.name, w.address]), [['w1', 'Main', 'sent1aaa'], ['w2', 'Spare', 'sent1bbb']])

      const once = [file(h, 'settings.json'), file(h, 'wallets-index.json')]
      startup(h)
      assert.deepEqual([file(h, 'settings.json'), file(h, 'wallets-index.json')], once, 'migrations are idempotent')
    })
  }

  test('[PC-1] a global providerMode moves onto the wallet that was active, and only that one', (t) => {
    const h = settings.fresh()
    t.after(() => h.dispose())
    cpSync(join(FIXTURES, 'G2-a14ee1b.settings.json'), join(h.world.userData, 'settings.json'))
    cpSync(join(FIXTURES, 'G2-a14ee1b.wallets-index.json'), join(h.world.userData, 'wallets-index.json'))
    startup(h)
    const wallets = (h.mod.listWallets as Fn)() as Array<{ id: string; providerMode?: boolean }>
    assert.deepEqual(wallets.map((w) => [w.id, w.providerMode === true]), [['w1', true], ['w2', false]])
  })
})

describe('[ARCH-5] the pre-rename profile', () => {
  const legacy = (h: ModuleHarness) => join(h.world.userData, '.appData', 'sentinel-dvpn-app')
  const seedLegacy = (h: ModuleHarness) => {
    const dir = legacy(h)
    mkdirSync(join(dir, 'wallets'), { recursive: true })
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ activeWalletId: 'w1', killSwitch: true }))
    writeFileSync(join(dir, 'wallets-index.json'), JSON.stringify([{ id: 'w1', name: 'Main', address: 'sent1aaa' }]))
    writeFileSync(join(dir, 'wallets', 'w1.enc'), 'enc:sentinel-dvpn-app:abandon abandon about')
    writeFileSync(join(dir, 'sessions', 'session-7.json'), '{}')
    writeFileSync(join(dir, 'nodes-cache.json'), '{"nodes":[]}')
  }

  test('[ARCH-5] is copied across once - settings, wallets, sessions; not caches - and left untouched', (t) => {
    const h = settings.fresh()
    t.after(() => h.dispose())
    seedLegacy(h)
    const before = readdirSync(legacy(h)).sort()
    ;(h.mod.migrateLegacyUserData as Fn)()
    for (const p of ['settings.json', 'wallets-index.json', 'wallets/w1.enc', 'sessions/session-7.json']) {
      assert.ok(existsSync(join(h.world.userData, p)), `${p} was not carried across`)
    }
    assert.equal(existsSync(join(h.world.userData, 'nodes-cache.json')), false, 'caches are rebuilt, not copied')
    assert.deepEqual(readdirSync(legacy(h)).sort(), before, 'the old profile stays as a fallback')
    assert.equal(((h.mod.loadSettings as Fn)() as { killSwitch: boolean }).killSwitch, true)
  })

  test('[ARCH-5] never overwrites a profile the new app already has', (t) => {
    const h = settings.fresh()
    t.after(() => h.dispose())
    seedLegacy(h)
    writeFileSync(join(h.world.userData, 'wallets-index.json'), JSON.stringify([{ id: 'n1', name: 'New', address: 'sent1new' }]))
    ;(h.mod.migrateLegacyUserData as Fn)()
    assert.deepEqual(((h.mod.listWallets as Fn)() as Array<{ id: string }>).map((w) => w.id), ['n1'])
  })

  test('[ARCH-5] a seed saved under the old name asks to be re-imported instead of failing raw', (t) => {
    const h = settings.fresh()
    t.after(() => h.dispose())
    seedLegacy(h)
    ;(h.mod.migrateLegacyUserData as Fn)()
    assert.throws(() => (h.mod.getWalletMnemonic as Fn)('w1'), /import the same seed phrase again/)
    assert.equal((h.mod.canUnlockWallet as Fn)('w1'), false)
  })
})

describe('[ARCH-5] the wallet store', () => {
  test('[ARCH-5] duplicate entries collapse onto the copy that still unlocks, and the active id follows it', (t) => {
    const h = settings.fresh()
    t.after(() => h.dispose())
    writeFileSync(join(h.world.userData, 'wallets-index.json'), JSON.stringify([
      { id: 'old', name: 'Main', address: 'sent1aaa' }, // saved before the rename: will not decrypt
      { id: 'new', name: 'Main (re-imported)', address: 'sent1aaa' },
      { id: 'blank', name: 'Migrating', address: '' },
    ]))
    writeFileSync(join(h.world.userData, 'settings.json'), JSON.stringify({ activeWalletId: 'old' }))
    seed(h, 'old', 'sentinel-dvpn-app'); seed(h, 'new'); seed(h, 'blank')
    ;(h.mod.dedupeWalletEntries as Fn)()
    assert.deepEqual(((h.mod.listWallets as Fn)() as Array<{ id: string }>).map((w) => w.id), ['new', 'blank'])
    assert.equal(((h.mod.loadSettings as Fn)() as { activeWalletId: string }).activeWalletId, 'new')
    assert.equal(existsSync(join(h.world.userData, 'wallets', 'old.enc')), false)
  })

  test('[ARCH-5] with only the insecure basic_text backend, no seed is written', (t) => {
    const h = settings.fresh()
    t.after(() => h.dispose())
    h.world.safeStorage.backend = 'basic_text'
    assert.throws(() => (h.mod.addWalletEntry as Fn)('Main', 'sent1aaa', 'abandon abandon about'), /Secure storage is unavailable/)
    assert.equal(existsSync(join(h.world.userData, 'wallets')) && readdirSync(join(h.world.userData, 'wallets')).length > 0, false)
    writeFileSync(join(h.world.userData, 'wallet.enc'), `enc:${h.world.safeStorage.keyId}:abandon abandon about`)
    ;(h.mod.migrateOldWallet as Fn)()
    assert.equal(existsSync(join(h.world.userData, 'wallet.enc')), true, 'the old seed waits for a real keyring')
    assert.deepEqual((h.mod.listWallets as Fn)(), [])
  })

  test('[ARCH-5] the single-wallet store of the first releases becomes the active wallet', (t) => {
    const h = settings.fresh()
    t.after(() => h.dispose())
    writeFileSync(join(h.world.userData, 'wallet.enc'), `enc:${h.world.safeStorage.keyId}:abandon abandon about`)
    ;(h.mod.migrateOldWallet as Fn)()
    const [w] = (h.mod.listWallets as Fn)() as Array<{ id: string; name: string; address: string }>
    assert.equal(w.name, 'My Wallet')
    assert.equal((h.mod.getWalletMnemonic as Fn)(w.id), 'abandon abandon about')
    assert.equal(((h.mod.loadSettings as Fn)() as { activeWalletId: string }).activeWalletId, w.id)
    assert.equal(existsSync(join(h.world.userData, 'wallet.enc')), false)
  })
})
