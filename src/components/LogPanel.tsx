import { useState, useEffect, useRef } from 'react'
import { useT } from '../i18n'

interface LogEntry {
  ts: string
  text: string
  level: string
}

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-text-muted',
  warn: 'text-yellow-400',
  error: 'text-danger',
}

export function LogPanel() {
  const t = useT()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    electronAPI.getLogs().then((initial: LogEntry[]) => {
      if (initial?.length) setLogs(initial)
    })

    const unsub = electronAPI.onLog((entry: LogEntry) => {
      setLogs(prev => {
        const next = [...prev, entry]
        if (next.length > 500) next.shift()
        return next
      })
    })

    return () => { if (unsub) unsub() }
  }, [])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center pb-2 border-b border-border/50 px-1">
        <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider">
          {t.logs.title}
        </h3>
        <button
          className="btn border border-border text-xs px-2 hover:border-accent"
          onClick={() => setLogs([])}
        >
          {t.logs.clear}
        </button>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto mt-2 space-y-0.5 font-mono text-[11px] leading-relaxed"
      >
        {logs.length === 0 && (
          <div className="text-text-muted opacity-50 pt-4 text-center">
            {t.logs.empty}
          </div>
        )}
        {logs.map((entry, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-text-muted opacity-40 shrink-0">{entry.ts}</span>
            <span className={LEVEL_COLORS[entry.level] || 'text-text-muted'}>
              {entry.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
