import { world } from './world.ts'

// Stands in for `@electron-toolkit/utils` inside a test bundle. The real one reads
// app.isPackaged at load; this reads the world when asked.
export const is = {
  get dev(): boolean { return world().isDev },
}
