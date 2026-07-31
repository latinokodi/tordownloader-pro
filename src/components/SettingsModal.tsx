import { useState, useEffect, useRef } from 'react'
import { api } from '../hooks/useApi'
import { useT } from '../i18n'

interface SettingsSchema {
  torbox_token: string
  destination_folder: string
  auto_remove_completed: boolean
}

interface Props {
  onClose: () => void
  showToast: (msg: string, type?: 'success' | 'error') => void
}

export function SettingsModal({ onClose, showToast }: Props) {
  const t = useT()
  const [settings, setSettings] = useState<SettingsSchema | null>(null)
  const [loading, setLoading] = useState(true)
  const [testingMetaSearch, setTestingMetaSearch] = useState(false)
  const [searchStatus, setSearchStatus] = useState<string | null>(null)
  const [authData, setAuthData] = useState<any | null>(null)
  const [torboxUser, setTorboxUser] = useState<any | null>(null)
  const pollTimer = useRef<number | null>(null)

  const fetchTorboxUser = async () => {
    try {
      const res = await api<any>('/auth/user')
      if (res.success && res.data) {
        setTorboxUser(res.data)
      }
    } catch (e) {
      // ignore
    }
  }

  useEffect(() => {
    api<SettingsSchema>('/settings')
      .then(async (s) => {
        setSettings(s)
        if (s.torbox_token) {
          await fetchTorboxUser()
        }
      })
      .catch((e) => showToast(e.message, 'error'))
      .finally(() => setLoading(false))

    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    }
  }, [])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!settings) return
    try {
      await api('/settings', 'POST', settings)
      showToast(t.settings.settingsSaved, 'success')
      onClose()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t.settings.saveFailed, 'error')
    }
  }

  const handleTestMetaSearch = async () => {
    setTestingMetaSearch(true)
    try {
      const res = await api<any>('/settings/test-metasearch', 'POST')
      if (res.success) {
        setSearchStatus(res.detail || 'OK')
        showToast(res.detail || t.settings.enginesReady, 'success')
      } else {
        showToast(res.detail || t.settings.enginesFailed, 'error')
      }
    } catch (err: any) {
      showToast(err.message || t.settings.enginesFailed, 'error')
    } finally {
      setTestingMetaSearch(false)
    }
  }

  const handleSelectFolder = async () => {
    try {
      const res = await api<{ path: string; error?: string }>('/select-folder')
      if (res.error) showToast(res.error, 'error')
      else if (res.path) setSettings((s) => s ? { ...s, destination_folder: res.path } : null)
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : t.settings.folderError, 'error')
    }
  }

  const startAuth = async () => {
    try {
      const res = await api<any>('/auth/start')
      if (res.success && res.data) {
        setAuthData(res.data)
        pollTimer.current = window.setInterval(async () => {
          const pollRes = await api<any>(`/auth/poll/${res.data.device_code}`)
          if (pollRes.success) {
            if (pollTimer.current) window.clearInterval(pollTimer.current)
            setAuthData(null)
            showToast(t.settings.torboxLinked, 'success')
            const updated = await api<SettingsSchema>('/settings')
            setSettings(updated)
            if (updated.torbox_token) {
              await fetchTorboxUser()
            }
          }
        }, 5000)
      }
    } catch (e) {
      showToast(t.settings.authFailed, 'error')
    }
  }

  const planLabel = (plan: number): string => {
    const labels: Record<number, string> = {
      0: t.settings.freePlan,
      1: t.settings.essentialPlan,
      2: t.settings.proPlan,
      3: t.settings.standardPlan,
      4: t.settings.premiumPlan,
    }
    return labels[plan] || String(plan)
  }

  if (loading) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in" onClick={onClose}>
      <div className="glass-panel w-full max-w-2xl bg-bg-panel border border-border shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 border-b border-border flex justify-between items-center bg-bg-deep">
          <h2 className="text-xl font-black uppercase tracking-widest text-text-heading font-display">{t.settings.title}</h2>
          <button className="text-text-muted hover:text-danger font-bold text-xl" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSave} className="p-6 flex flex-col gap-8 overflow-y-auto max-h-[70vh]">
          {/* Search — built-in */}
          <div className="space-y-4">
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest border-b border-border pb-2">{t.settings.searchEngines}</h3>
            <div className="border border-border bg-bg-deep p-4">
              <p className="text-sm font-mono text-text-muted mb-3">{t.settings.builtInDesc}</p>
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono uppercase text-text-muted">
                  {t.settings.enginesBundled}
                </span>
              </div>
              {searchStatus && (
                <div className="mt-2 text-xs font-mono text-success">{searchStatus}</div>
              )}
              <button
                type="button"
                className="btn border border-border text-text-main hover:border-accent mt-3"
                onClick={handleTestMetaSearch}
                disabled={testingMetaSearch}
              >
                {testingMetaSearch ? t.settings.testing : t.settings.testEngines}
              </button>
            </div>
          </div>

          {/* Torbox */}
          <div className="space-y-4">
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest border-b border-border pb-2">{t.settings.torboxIntegration}</h3>
            {authData ? (
              <div className="border border-border bg-bg-deep p-6 text-center space-y-4">
                <p className="font-mono text-sm text-text-main">
                  {t.settings.goToEnter}{' '}
                  <a href={authData.friendly_verification_url || "https://tor.box/link"} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    https://tor.box/link
                  </a>{' '}
                  {t.settings.andEnter}
                </p>
                <div className="text-4xl font-black tracking-[0.5em] text-accent font-mono py-4">{authData.code}</div>
                <div className="text-xs text-text-muted font-mono uppercase animate-pulse">{t.settings.waitingAuth}</div>
              </div>
            ) : (
              <div className="flex justify-center">
                {settings?.torbox_token ? (
                  <div className="flex flex-col gap-3 w-full">
                    <div className="bg-success/10 text-success border border-success p-3 text-center font-mono text-sm flex flex-col gap-1 items-center justify-center">
                      <span className="font-bold uppercase tracking-wider">{t.settings.accountLinked}</span>
                      {torboxUser && <span className="opacity-80 lowercase">{torboxUser.email} &bull; {planLabel(torboxUser.plan)}</span>}
                    </div>
                    <button type="button" onClick={startAuth} className="btn border border-border text-text-main hover:border-accent">{t.settings.relinkAccount}</button>
                  </div>
                ) : (
                  <button type="button" onClick={startAuth} className="btn btn-accent w-full">{t.settings.linkTorbox}</button>
                )}
              </div>
            )}
          </div>

          {/* Local Storage */}
          <div className="space-y-4">
            <h3 className="text-accent font-mono text-sm uppercase tracking-widest border-b border-border pb-2">{t.settings.localStorage}</h3>
            <div>
              <label className="block text-xs font-mono text-text-muted mb-2 uppercase">{t.settings.downloadDest}</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="input-field flex-1"
                  readOnly
                  placeholder={t.settings.selectFolder}
                  value={settings?.destination_folder || ''}
                />
                <button type="button" onClick={handleSelectFolder} className="btn border border-border text-text-main hover:border-accent">{t.settings.browse}</button>
              </div>
            </div>
            <div className="flex items-center gap-3 mt-4">
              <input
                type="checkbox"
                id="autoRemove"
                className="w-4 h-4 accent-accent bg-bg-deep border-border"
                checked={settings?.auto_remove_completed || false}
                onChange={(e) => setSettings((s) => s ? { ...s, auto_remove_completed: e.target.checked } : null)}
              />
              <label htmlFor="autoRemove" className="text-sm font-mono text-text-main cursor-pointer select-none">
                {t.settings.autoRemove}
              </label>
            </div>
          </div>

        </form>
        <div className="p-6 border-t border-border bg-bg-deep flex gap-4">
          <button type="button" onClick={onClose} className="btn border border-border flex-1">{t.settings.cancel}</button>
          <button onClick={handleSave} className="btn btn-accent flex-1">{t.settings.saveConfig}</button>
        </div>
      </div>
    </div>
  )
}
