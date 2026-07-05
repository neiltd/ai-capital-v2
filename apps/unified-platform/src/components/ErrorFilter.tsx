'use client'
import { useEffect } from 'react'

export function ErrorFilter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (event.filename?.startsWith('chrome-extension://') ||
          event.filename?.startsWith('moz-extension://')) {
        event.stopImmediatePropagation()
        event.preventDefault()
        return true
      }
    }
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const msg = String(event.reason)
      if (msg.includes('MetaMask') || msg.includes('chrome-extension')) {
        event.stopImmediatePropagation()
        event.preventDefault()
      }
    }
    window.addEventListener('error', onError, true)
    window.addEventListener('unhandledrejection', onUnhandledRejection, true)
    return () => {
      window.removeEventListener('error', onError, true)
      window.removeEventListener('unhandledrejection', onUnhandledRejection, true)
    }
  }, [])
  return null
}
