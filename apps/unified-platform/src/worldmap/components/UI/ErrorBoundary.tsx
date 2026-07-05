/**
 * ErrorBoundary — catches render errors in a subtree and renders a fallback.
 *
 * React requires class components for error boundaries (no hook equivalent).
 * Wrap any component that could fail with <ErrorBoundary label="name"> to
 * prevent a single component's crash from killing the entire app.
 *
 * Used around:
 *   - <WorldMap>    — MapLibre render errors, topology parse failures
 *   - <CountryPanel> — data parse errors on malformed country JSON
 *
 * Future: replace console.error with a proper error reporting service
 * (e.g. Sentry) when the platform moves to production monitoring.
 */

import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  /** Human-readable name for logs — helps identify which boundary caught the error. */
  label?: string
  /** Optional custom fallback UI. If omitted, a minimal dark-theme message is shown. */
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Future: forward to error monitoring service here
    console.error(`[ErrorBoundary:${this.props.label ?? 'unknown'}]`, error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    if (this.props.fallback) return this.props.fallback

    return (
      <div className="flex items-center justify-center w-full h-full p-6">
        <div className="text-center">
          <p className="text-[12px] text-text-muted mb-1">Component failed to render.</p>
          {this.state.error?.message && (
            <p className="text-[11px] text-text-faint font-mono">{this.state.error.message}</p>
          )}
        </div>
      </div>
    )
  }
}
