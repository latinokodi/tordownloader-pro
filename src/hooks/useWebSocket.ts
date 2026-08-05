import { useEffect, useRef } from 'react'
import { getElectronAPI, type Download } from '../types/electron'

type MessageHandler = (data: unknown) => void

/**
 * Listens for download updates via Electron IPC.
 */
export function useWebSocket(_path: string, onMessage: MessageHandler) {
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    const ea = getElectronAPI()
    if (!ea) return

    const cleanup = ea.onDownloadsUpdated(() => {
      ea.getDownloads().then((data: Download[]) => {
        onMessageRef.current({ type: 'status', downloads: data })
      })
    })

    return cleanup
  }, [])
}
