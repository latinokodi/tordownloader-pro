import { memo } from 'react'
import { LayoutDashboard, Search, BookMarked, DownloadCloud, Compass, ScrollText, Settings, Library } from 'lucide-react'
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
      {/* Brand — MediaPilot */}
      <div className="px-5 py-5 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent flex items-center justify-center text-white shadow-sm">
            <span className="translate-x-[0.5px]">▶</span>
          </div>
          <div className="leading-tight">
            <span className="font-extrabold tracking-tight text-[1.05rem] text-text-heading">Media<span className="text-accent">Pilot</span></span>
            <div className="text-[11px] text-text-muted font-medium">Auto downloader</div>
          </div>
        </div>
        {appVersion && <span className="text-[11px] text-text-muted mt-2 block">v{appVersion}</span>}
      </div>

      {/* Nav items */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        <NavItem icon={<LayoutDashboard size={16} />} label={t.nav.dashboard} active={activeNav === 'dashboard'} onClick={() => onNavChange('dashboard')} />
        <NavItem icon={<Search size={16} />} label={t.nav.search} active={activeNav === 'search'} onClick={() => onNavChange('search')} />
        <NavItem icon={<Compass size={16} />} label={t.nav.discover} active={activeNav === 'discover'} onClick={() => onNavChange('discover')} />
        <NavItem icon={<BookMarked size={16} />} label={t.nav.watchlist} active={activeNav === 'watchlist'} onClick={() => onNavChange('watchlist')} />
        <NavItem icon={<Library size={16} />} label={t.nav.library} active={activeNav === 'library'} onClick={() => onNavChange('library')} />
        <NavItem
          icon={<DownloadCloud size={16} />}
          label={t.nav.downloads}
          active={activeNav === 'downloads'}
          onClick={() => onNavChange('downloads')}
          badge={downloadCount > 0 ? downloadCount : undefined}
        />
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
      className={`w-full text-left px-3.5 py-2.5 rounded-lg flex items-center gap-2.5 text-[0.85rem] font-semibold transition-colors ${
        active ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-heading hover:bg-white'
      }`}
      onClick={onClick}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge !== undefined && (
        <span className="bg-accent text-white px-2 py-0.5 text-[11px] font-bold rounded-full">{badge}</span>
      )}
    </button>
  )
}
