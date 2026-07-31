import { useEffect, useRef } from 'react'

type MessageHandler = (data: unknown) => void

/**
 * Auto-reconnecting WebSocket hook, now mapped to Electron IPC for statuses.
 */
export function useWebSocket(path: string, onMessage: MessageHandler) {
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI) return

    const cleanup = electronAPI.onDownloadsUpdated(() => {
      // Fetch latest downloads when updated
      electronAPI.getDownloads().then((data: any) => {
        onMessageRef.current({ type: 'status', downloads: data })
      })
    })
    
    return cleanup
  }, [])
}
