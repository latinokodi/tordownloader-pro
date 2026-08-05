import { memo } from 'react'
import { useT } from '../i18n'

interface HeaderProps {
  activeCloud: number
  activeLocal: number
}

export const Header = memo(function Header({ activeCloud, activeLocal }: HeaderProps) {
  const t = useT()

  return (
    <header className="border-b border-border p-6 bg-bg-card flex justify-between items-end">
      <div>
        <h1 className="text-2xl font-black uppercase tracking-tight text-text-heading">{t.header.title}</h1>
        <p className="text-text-muted text-sm mt-1 font-mono">{t.header.subtitle}</p>
      </div>
      <div className="flex gap-6 font-mono text-xs uppercase tracking-widest text-text-muted">
        <div className="text-right">
          <div className="text-accent text-xl font-bold">{activeCloud}</div>
          <div>{t.header.cloudActive}</div>
        </div>
        <div className="text-right">
          <div className="text-success text-xl font-bold">{activeLocal}</div>
          <div>{t.header.localActive}</div>
        </div>
      </div>
    </header>
  )
})
