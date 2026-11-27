import { Appearance } from "@/components/Common/Appearance"
import { LanguageSwitch } from "@/components/Common/LanguageSwitch"
import { Logo } from "@/components/Common/Logo"

interface AuthLayoutProps {
  children: React.ReactNode
  showLanguageSwitch?: boolean
}

export function AuthLayout({
  children,
  showLanguageSwitch = false,
}: AuthLayoutProps) {
  return (
    <div className="flex min-h-svh flex-col bg-canvas">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-surface-border bg-surface px-4 sm:px-6">
        <Logo asLink={false} className="text-sm" />
        <div className="flex items-center gap-2">
          {showLanguageSwitch && <LanguageSwitch />}
          <Appearance />
        </div>
      </header>
      <main className="grid flex-1 place-items-center px-4 py-8">
        <div className="w-full max-w-md rounded-xl border border-surface-border bg-surface p-6 shadow-md shadow-black/5 sm:p-8">
          {children}
        </div>
      </main>
    </div>
  )
}
