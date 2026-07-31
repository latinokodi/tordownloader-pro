/**
 * cf-solver.ts — Uses Electron's Chromium to solve Cloudflare challenges
 * and extract cookies for Python plugins to reuse.
 *
 * For heavy-CF sites like 1337x, cloudscraper alone isn't enough.
 * We use a hidden BrowserWindow to load the site, wait for the
 * "Just a moment..." challenge to clear, then export cookies
 * to a temp file that the Python runner can inject.
 */

import { BrowserWindow, session } from 'electron'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

interface Cookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
}

// ── Persistent cookie store ───────────────────────────

function getCookieStorePath(): string {
  return path.join(app.getPath('userData'), 'cf_cookies.json')
}

function loadCookies(): Record<string, Cookie[]> {
  try {
    if (fs.existsSync(getCookieStorePath())) {
      return JSON.parse(fs.readFileSync(getCookieStorePath(), 'utf-8'))
    }
  } catch {}
  return {}
}

function saveCookies(data: Record<string, Cookie[]>): void {
  fs.writeFileSync(getCookieStorePath(), JSON.stringify(data, null, 2), 'utf-8')
}

// ── Solver ─────────────────────────────────────────────

const CF_CHALLENGE_SELECTOR = '#challenge-running, .cf-browser-verification, #cf-challenge-running'
const CF_SUCCESS_INDICATORS = [
  'Just a moment...',
  'Checking your browser',
]

function isChallengePage(html: string): boolean {
  return CF_SUCCESS_INDICATORS.some(indicator => html.includes(indicator))
}

async function solveCF(url: string, timeoutMs: number = 30000): Promise<Cookie[]> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: `cf_solver_${Date.now()}`,
      },
    })

    let resolved = false

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        win.destroy()
        console.warn(`[CF Solver] Timeout after ${timeoutMs}ms for ${url}`)
        resolve([])
      }
    }, timeoutMs)

    // Poll page content until CF challenge clears
    const pollInterval = setInterval(async () => {
      if (resolved || win.isDestroyed()) {
        clearInterval(pollInterval)
        return
      }

      try {
        const body = await win.webContents.executeJavaScript('document.body.innerHTML')
        if (body && !isChallengePage(body) && body.length > 200) {
          // Challenge cleared — page loaded successfully
          clearInterval(pollInterval)
          clearTimeout(timer)
          resolved = true

          // Extract cookies
          const cookies = await win.webContents.session.cookies.get({})
          const clean: Cookie[] = cookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain || '',
            path: c.path || '/',
            secure: c.secure ?? false,
            httpOnly: c.httpOnly ?? false,
            sameSite: c.sameSite || 'lax',
          }))

          win.destroy()
          console.log(`[CF Solver] Solved for ${new URL(url).hostname}: ${clean.length} cookies`)
          resolve(clean)
        }
      } catch {
        // window might be destroyed during polling
      }
    }, 1000)

    // Start loading
    win.loadURL(url).catch((err) => {
      clearInterval(pollInterval)
      clearTimeout(timer)
      if (!resolved) {
        resolved = true
        win.destroy()
        console.warn(`[CF Solver] Load failed for ${url}:`, err.message)
        resolve([])
      }
    })
  })
}

// ── Public API ─────────────────────────────────────────

/** Pre-solve CF for a list of domains. Runs on app startup. */
export async function preSolveDomains(domains: string[]): Promise<void> {
  const stored = loadCookies()
  const updated = { ...stored }

  for (const domainUrl of domains) {
    try {
      const hostname = new URL(domainUrl).hostname

      // Skip if we have recent cookies (they're good for ~hours)
      if (stored[hostname] && stored[hostname].length > 0) {
        console.log(`[CF Solver] Using cached cookies for ${hostname}`)
        continue
      }

      console.log(`[CF Solver] Solving CF for ${hostname}...`)
      const cookies = await solveCF(domainUrl, 30000)
      if (cookies.length > 0) {
        updated[hostname] = cookies
      }
    } catch (err) {
      console.warn(`[CF Solver] Failed for ${domainUrl}:`, err)
    }
  }

  saveCookies(updated)
}

/** Get the latest cookie file path for the Python runner */
export function getCookieFilePath(): string {
  return getCookieStorePath()
}

/** Export cookies for a specific domain (for CLI use) */
export function getCookiesForDomain(domain: string): Cookie[] {
  const stored = loadCookies()
  return stored[domain] || []
}
