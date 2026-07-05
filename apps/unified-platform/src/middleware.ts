import { NextRequest, NextResponse } from 'next/server'

export const config = {
  matcher: ['/admin/:path*', '/studio/:path*', '/api/studio/:path*', '/api/thesis-proposals'],
}

// Logged once so repeated requests while misconfigured don't spam the console.
let warnedMissingKey = false

// Manual constant-time comparison instead of Node's crypto.timingSafeEqual —
// Next.js middleware runs in the Edge Runtime, which does not support
// node:crypto (and this Next 14.2 version lacks the `runtime = 'nodejs'`
// escape hatch added in Next 15.2), so this must stay dependency-free.
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

function unauthorized(isApi: boolean) {
  if (isApi) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Admin"' },
  })
}

export default function middleware(req: NextRequest) {
  const accessKey = process.env.APP_ACCESS_KEY
  const isApi = req.nextUrl.pathname.startsWith('/api')

  // Fail closed: this codebase's existing convention for required config
  // (see ANTHROPIC_API_KEY checks in api/ask and api/thesis-proposals) is to
  // return an explicit error rather than silently proceeding as if the
  // feature were unconfigured. An unset APP_ACCESS_KEY guarding admin/studio
  // routes should not be treated as "no auth needed" — that would defeat the
  // point of the check the first time someone forgets to set it.
  if (!accessKey) {
    if (!warnedMissingKey) {
      console.warn(
        '[middleware] APP_ACCESS_KEY is not set — admin/studio routes will return 401 until it is configured.'
      )
      warnedMissingKey = true
    }
    return unauthorized(isApi)
  }

  // API key header covers programmatic/server-to-server callers. Checked for
  // every matched path (not just /api) since it's harmless to accept it on
  // page routes too, and keeps this branch a single source of truth.
  const apiKeyHeader = req.headers.get('x-api-key')
  if (apiKeyHeader && safeCompare(apiKeyHeader, accessKey)) {
    return NextResponse.next()
  }

  // Basic Auth — checked for every matched path, page or API. This is what
  // makes the browser's client-side chat/upload fetch calls under
  // /api/studio/* work: visiting a gated page (e.g. /studio) triggers the
  // browser's native Basic Auth prompt once, the browser then caches those
  // credentials per-origin, and automatically re-attaches the same
  // Authorization header to every subsequent same-origin fetch/XHR — including
  // calls the page's own client components make to /api/studio/*. If only the
  // API paths checked Basic Auth (and only page paths triggered the prompt),
  // the browser would never have credentials cached to send.
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf-8')
    const sep = decoded.indexOf(':')
    const password = sep >= 0 ? decoded.slice(sep + 1) : ''
    if (password && safeCompare(password, accessKey)) {
      return NextResponse.next()
    }
  }

  return unauthorized(isApi)
}
