/**
 * metasearch.ts — Native multi-engine torrent search using qBittorrent plugins.
 *
 * Replaces Jackett + FlareSolverr Docker stack with a self-contained solution:
 * spawns a Python runner that loads qBittorrent search plugins, aggregates
 * results across engines, deduplicates, and returns JSON.
 *
 * No external services, no Docker, no separate installs.
 * Only dependency: Python 3 with `cloudscraper` (auto-installed if missing).
 */

import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import { app } from 'electron'

// ── Types ──────────────────────────────────────────────

export interface MetaResult {
  title: string
  size: string
  seeders: number
  peers: number
  link: string
  indexer: string
  info_hash: string | null
}

// ── Paths ──────────────────────────────────────────────

function getRunnerPath(): string {
  // In dev: electron/qbit-plugins/qbit-runner.py
  // In prod (packaged): resources/qbit-plugins/qbit-runner.py
  if (process.env.VITE_DEV_SERVER_URL) {
    return path.join(__dirname, '..', 'electron', 'qbit-plugins', 'qbit-runner.py')
  }
  return path.join(process.resourcesPath || app.getAppPath(), 'qbit-plugins', 'qbit-runner.py')
}

function getCFCookiePath(): string {
  return path.join(app.getPath('userData'), 'cf_cookies.json')
}

// ── Auto-install cloudscraper ──────────────────────────

let _ensureDepsPromise: Promise<boolean> | null = null

function ensureDeps(): Promise<boolean> {
  if (_ensureDepsPromise) return _ensureDepsPromise

  _ensureDepsPromise = new Promise<boolean>((resolve) => {
    const check = spawn('python', ['-c', 'import cloudscraper'], {
      windowsHide: true,
    })

    check.on('close', (code) => {
      if (code === 0) {
        resolve(true)
        return
      }

      // cloudscraper not installed — try pip install
      const install = spawn('python', ['-m', 'pip', 'install', '--quiet', 'cloudscraper'], {
        windowsHide: true,
      })

      install.on('close', (installCode) => {
        resolve(installCode === 0)
      })

      install.stderr.on('data', () => {
        // suppress pip output
      })
    })

    check.stderr.on('data', () => {
      // suppress
    })
  })

  return _ensureDepsPromise
}

// ── Runner ──────────────────────────────────────────────

const SEARCH_TIMEOUT_MS = 60_000 // 60 seconds total

export class MetaSearch {
  private runnerPath: string
  private ready: boolean = false

  constructor() {
    this.runnerPath = getRunnerPath()
  }

  async initialize(): Promise<void> {
    const ok = await ensureDeps()
    if (!ok) {
      console.warn('[MetaSearch] cloudscraper not available — some sites may fail')
    }
    this.ready = true
  }

  async search(query: string): Promise<MetaResult[]> {
    if (!this.ready) {
      await this.initialize()
    }

    return new Promise<MetaResult[]>((resolve) => {
      let stdout = ''
      let stderr = ''
      let resolved = false

      const proc: ChildProcess = spawn('python', [this.runnerPath, query], {
        windowsHide: true,
        timeout: SEARCH_TIMEOUT_MS,
        env: {
          ...process.env,
          CF_COOKIE_FILE: getCFCookiePath(),
        },
      })

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          proc.kill('SIGTERM')
          console.warn(`[MetaSearch] Search timed out after ${SEARCH_TIMEOUT_MS}ms for: "${query}"`)
          resolve([])
        }
      }, SEARCH_TIMEOUT_MS)

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (resolved) return
        resolved = true

        if (stderr && code !== 0) {
          console.warn(`[MetaSearch] stderr for "${query}":`, stderr.slice(0, 500))
        }

        if (!stdout.trim()) {
          resolve([])
          return
        }

        try {
          const results: MetaResult[] = JSON.parse(stdout)
          resolve(results)
        } catch (err) {
          console.error(`[MetaSearch] JSON parse failed for "${query}"`, (err as Error).message)
          resolve([])
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        if (resolved) return
        resolved = true
        console.error(`[MetaSearch] Failed to spawn Python runner:`, err.message)
        resolve([])
      })
    })
  }
}

// ── Singleton ──────────────────────────────────────────

let _instance: MetaSearch | null = null

export function getMetaSearch(): MetaSearch {
  if (!_instance) {
    _instance = new MetaSearch()
  }
  return _instance
}

export function initMetaSearch(): void {
  const ms = getMetaSearch()
  ms.initialize().catch((err) => {
    console.error('[MetaSearch] Initialization failed:', err)
  })
}
