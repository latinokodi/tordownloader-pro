/**
 * flaresolverr.ts — Bundled FlareSolverr process manager.
 *
 * Spawns the bundled flaresolverr.exe on app startup, monitors
 * its health, and exposes the proxy URL for the Python plugins.
 *
 * No Docker, no external install. Just a bundled .exe + Chrome.
 */

import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import { app } from 'electron'
import http from 'http'
import fs from 'fs'

const FLARESOLVERR_PORT = 8191
const HEALTH_CHECK_INTERVAL = 30_000
const STARTUP_TIMEOUT = 30_000
const MAX_RESTART_COUNT = 3

let _proc: ChildProcess | null = null
let _healthy = false
let _restartCount = 0

function getFlaresolverrPath(): string {
  // In dev: electron/flaresolverr/flaresolverr/flaresolverr.exe
  // In prod: resources/flaresolverr/flaresolverr/flaresolverr.exe
  if (process.env.VITE_DEV_SERVER_URL) {
    // __dirname is dist-electron/ — go up one level to project root
    return path.join(__dirname, '..', 'electron', 'flaresolverr', 'flaresolverr', 'flaresolverr.exe')
  }
  return path.join(process.resourcesPath || app.getAppPath(), 'flaresolverr', 'flaresolverr', 'flaresolverr.exe')
}

function healthCheck(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${FLARESOLVERR_PORT}/health`, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(5000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForReady(timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await healthCheck()
    if (ok) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

function startProcess(): void {
  if (_proc) return

  const exePath = getFlaresolverrPath()
  if (!fs.existsSync(exePath)) {
    console.log('[FlareSolverr] Not installed — Cloudflare bypass unavailable')
    return
  }
  console.log(`[FlareSolverr] Starting: ${exePath}`)

  _proc = spawn(exePath, ['--port', String(FLARESOLVERR_PORT)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  _proc.stdout?.on('data', (data: Buffer) => {
    // FlareSolverr logs to stdout; suppress unless debugging
    // console.log('[FlareSolverr]', data.toString().trim())
  })

  _proc.stderr?.on('data', (data: Buffer) => {
    console.warn('[FlareSolverr]', data.toString().trim())
  })

  _proc.on('close', (code) => {
    console.warn(`[FlareSolverr] Process exited (code ${code})`)
    _proc = null
    _healthy = false
    // Auto-restart only if we haven't exceeded the limit
    _restartCount++
    if (_restartCount <= MAX_RESTART_COUNT) {
      setTimeout(() => {
        if (!_proc) startProcess()
      }, 5000)
    } else {
      console.error(`[FlareSolverr] Max restart attempts (${MAX_RESTART_COUNT}) reached. Giving up.`)
    }
  })

  _proc.on('error', (err) => {
    console.error('[FlareSolverr] Failed to start:', err.message)
    _proc = null
  })
}

export async function startFlareSolverr(): Promise<void> {
  startProcess()
  if (!_proc) return // exe not found — nothing to wait for
  const ready = await waitForReady(STARTUP_TIMEOUT)
  if (ready) {
    _healthy = true
    console.log('[FlareSolverr] Ready on port', FLARESOLVERR_PORT)
  } else {
    console.warn('[FlareSolverr] Startup timed out — will retry')
  }

  // Periodic health checks
  setInterval(async () => {
    const ok = await healthCheck()
    _healthy = ok
    if (!ok && !_proc && _restartCount <= MAX_RESTART_COUNT) {
      console.warn('[FlareSolverr] Not running — restarting...')
      startProcess()
    }
  }, HEALTH_CHECK_INTERVAL)
}

export function getFlareSolverrUrl(): string {
  return `http://localhost:${FLARESOLVERR_PORT}`
}

export function isFlareSolverrReady(): boolean {
  return _healthy
}
