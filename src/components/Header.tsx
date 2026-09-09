import { memo } from 'react'
import { useT } from '../i18n'

interface HeaderProps {
  activeCloud: number
  activeLocal: number
}

export const Header = memo(function Header({ activeCloud, activeLocal }: HeaderProps) {
  const t = useT()

  return (
    <header className="border-b border-border px-6 py-5 bg-bg-panel flex justify-between items-end">
      <div>
        <h1 className="text-[1.4rem] font-extrabold tracking-tight text-text-heading">{t.header.title}</h1>
        <p className="text-text-muted text-sm mt-0.5">{t.header.subtitle}</p>
      </div>
      <div className="flex gap-6 text-xs font-semibold text-text-muted">
        <div className="text-right">
          <div className="text-accent text-2xl font-extrabold leading-tight">{activeCloud}</div>
          <div>{t.header.cloudActive}</div>
        </div>
        <div className="text-right">
          <div className="text-success text-2xl font-extrabold leading-tight">{activeLocal}</div>
          <div>{t.header.localActive}</div>
        </div>
      </div>
    </header>
  )
})
