import type { ReactNode } from 'react'
import AppLogo from '../AppLogo'

/**
 * The page the wallet setup screens sit on: create, import and add a wallet
 * (MnemonicInput), and Welcome back and Your seed is saved (WalletPicker). The logo and
 * name run across the top, so no setup screen leaves it unclear whose app this is; the
 * first-run welcome draws its own larger lockup on the same backdrop instead. The page
 * scrolls, so a long wallet list is never cut off at the bottom of the window.
 */
export default function SetupLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto setup-backdrop">
      <div className="min-h-full flex flex-col">
        <header className="flex items-center gap-2.5 px-8 pt-6 shrink-0">
          <AppLogo size={28} className="shrink-0" />
          <span className="text-accent font-semibold">Katacomb VPN</span>
        </header>
        <div className="flex-1 flex items-center justify-center px-8 py-10">{children}</div>
      </div>
    </div>
  )
}
