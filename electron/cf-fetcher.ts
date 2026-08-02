/**
 * cf-fetcher.ts — Local HTTP bridge for Python plugins to fetch CF-protected
 * pages through Electron's native Chromium engine.
 *
 * Starts a tiny HTTP server on localhost that accepts POST /fetch requests
 * with a JSON body { "url": "..." }. Uses a hidden BrowserWindow to load
 * the URL, waits for Cloudflare challenges to clear, and returns the page HTML.
 */

import { BrowserWindow } from 'electron'
import http from 'http'

let _server: http.Server | null = null
let _port: number = 0

// ── CF detection ───────────────────────────────────────

const CF_INDICATORS = [
  'Just a moment...',
  'Checking your browser',
  'cf-browser-verification',
  'cf-challenge-running',
  '#challenge-running',
]

function isChallengePage(html: string): boolean {
  if (!html || html.length < 100) return false
  const lower = html.slice(0, 500).toLowerCase()
  return CF_INDICATORS.some(ind => lower.includes(ind.toLowerCase()))
}

// ── Fetch via hidden BrowserWindow ─────────────────────

function fetchViaBrowser(url: string, timeoutMs: number = 45000): Promise<string> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1024,
      height: 768,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: `cf_fetcher_${Date.now()}`,
      },
    })

    let resolved = false
    let pollCount = 0
    const MAX_POLLS = 20 // 20 × 2s = 40s of polling after page load

    const cleanup = () => {
      if (!resolved) return
      try { win.destroy() } catch (_) {}
    }

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        try { win.destroy() } catch (_) {}
        console.warn(`[CF Fetcher] Timeout after ${timeoutMs}ms for ${url}`)
        resolve('')
      }
    }, timeoutMs)

    const tryGetContent = async () => {
      if (resolved || win.isDestroyed()) return

      try {
        const body = await win.webContents.executeJavaScript('document.body.innerHTML')
        if (!body) return

        if (isChallengePage(body)) {
          // Still on CF challenge — keep polling
          return
        }

        // Got real content
        clearTimeout(timer)
        resolved = true

        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML')
        try { win.destroy() } catch (_) {}
        resolve(html)
      } catch {
        // window may have been destroyed
      }
    }

    // Poll every 2s for CF-challenged pages
    const pollInterval = setInterval(() => {
      if (resolved) {
        clearInterval(pollInterval)
        return
      }
      pollCount++
      if (pollCount > MAX_POLLS) {
        clearInterval(pollInterval)
        if (!resolved) {
          // Timed out on CF — return whatever we have
          resolved = true
          clearTimeout(timer)
          win.webContents.executeJavaScript('document.documentElement.outerHTML')
            .then(html => { try { win.destroy() } catch (_) {}; resolve(html || '') })
            .catch(() => { try { win.destroy() } catch (_) {}; resolve('') })
        }
        return
      }
      tryGetContent()
    }, 2000)

    // Also try immediately after page finishes loading
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => tryGetContent(), 500) // small delay for JS to settle
    })

    win.loadURL(url).catch((err) => {
      clearInterval(pollInterval)
      clearTimeout(timer)
      if (!resolved) {
        resolved = true
        try { win.destroy() } catch (_) {}
        console.warn(`[CF Fetcher] Load failed for ${url}:`, err.message)
        resolve('')
      }
    })
  })
}

// ── HTTP Server ────────────────────────────────────────

export function startCFServer(): number {
  if (_server) return _port

  _server = http.createServer(async (req, res) => {
    // CORS for localhost
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'POST' || req.url !== '/fetch') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body)
        if (!url) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Missing url' }))
          return
        }

        console.log(`[CF Fetcher] Fetching: ${url}`)
        const html = await fetchViaBrowser(url, 60000)

        if (!html) {
          res.writeHead(502)
          res.end(JSON.stringify({ error: 'Failed to fetch page' }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ html }))
      } catch (err: any) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: err.message }))
      }
    })
  })

  // Listen on a random available port
  _server.listen(0, '127.0.0.1', () => {
    const addr = _server!.address() as any
    _port = addr.port
    console.log(`[CF Fetcher] HTTP bridge listening on port ${_port}`)
  })

  return _port
}

export function getCFServerPort(): number {
  return _port
}

export function stopCFServer(): void {
  if (_server) {
    _server.close()
    _server = null
    _port = 0
  }
}
