import { memo } from 'react'
import { Search, BookMarked, DownloadCloud, Compass, ScrollText, Settings } from 'lucide-react'
import { useT } from '../i18n'
import { LangToggle } from '../i18n/LangToggle'

interface SidebarProps {
  activeNav: string
  onNavChange: (nav: string) => void
  onSettingsOpen: () => void
  downloadCount: number
  appVersion?: string
}

export const Sidebar = memo(function Sidebar({ activeNav, onNavChange, onSettingsOpen, downloadCount, appVersion }: SidebarProps) {
  const t = useT()

  return (
    <aside className="w-64 border-r border-border bg-bg-panel flex flex-col z-10">
      {/* Brand */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-8 h-8 bg-accent flex items-center justify-center text-bg-deep font-black font-mono">TB</div>
          <span className="font-bold uppercase tracking-wider text-sm">TorDownloader</span>
        </div>
        {appVersion && <span className="text-[10px] text-text-muted font-mono">v{appVersion}</span>}
      </div>

      {/* Nav items */}
      <nav className="flex-1 p-4 space-y-2">
        <NavItem icon={<Search size={16} />} label={t.nav.search} active={activeNav === 'search'} onClick={() => onNavChange('search')} />
        <NavItem icon={<BookMarked size={16} />} label={t.nav.watchlist} active={activeNav === 'watchlist'} onClick={() => onNavChange('watchlist')} />
        <NavItem
          icon={<DownloadCloud size={16} />}
          label={t.nav.transfers}
          active={activeNav === 'downloads'}
          onClick={() => onNavChange('downloads')}
          badge={downloadCount > 0 ? downloadCount : undefined}
        />
        <NavItem icon={<Compass size={16} />} label="Discover" active={activeNav === 'discover'} onClick={() => onNavChange('discover')} />
        <NavItem icon={<ScrollText size={16} />} label={t.nav.logs} active={activeNav === 'logs'} onClick={() => onNavChange('logs')} />
      </nav>

      {/* Bottom actions */}
      <div className="p-4 border-t border-border space-y-2">
        <LangToggle />
        <button className="w-full btn btn-accent" onClick={onSettingsOpen}>
          <Settings size={14} /> {t.nav.settings}
        </button>
      </div>
    </aside>
  )
})

function NavItem({ icon, label, active, onClick, badge }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button
      className={`w-full text-left px-4 py-3 font-mono text-sm tracking-wide uppercase transition-colors ${
        active ? 'bg-accent/10 text-accent border-l-2 border-accent' : 'text-text-muted hover:text-text-main'
      }`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        {icon}
        {label}
        {badge !== undefined && (
          <span className="ml-auto bg-accent text-bg-deep px-2 py-0.5 text-xs font-bold">{badge}</span>
        )}
      </div>
    </button>
  )
}
