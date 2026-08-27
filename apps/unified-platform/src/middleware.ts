import { NextRequest, NextResponse } from 'next/server'

// ── DEFAULT DENY ────────────────────────────────────────────────────────────
//
// This matcher intercepts EVERYTHING except Next's own internals. Exemptions
// are then listed explicitly in PUBLIC_PATHS below.
//
// WHY THE INVERSION. The previous matcher enumerated what to protect:
//   ['/admin/:path*', '/studio/:path*', '/api/studio/:path*',
//    '/api/thesis-proposals', '/api/theses/proposals/:path*']
// Twelve routes fell outside it, including POST /api/portfolio/refresh, which
// execFiles a child process with the production DATABASE_URL hardcoded, and
// GET /api/status, which write-locks the production run database. A second
// pipeline dashboard at /system/pipeline was also outside it — and was missed
// even by the audit, because Next route groups like (legacy) and (next) do not
// appear in the URL, so two distinct pages looked like one.
//
// An enumerate-the-dangerous list fails silently every time a route is added.
// An enumerate-the-safe list fails loudly: the new route 401s until someone
// makes a decision about it. That is the direction the failure should point.
//
// CORRECTION (2026-08-28): an earlier version of this comment claimed `public/`
// files are "served BEFORE middleware runs and cannot be intercepted here at
// all". **That is false.** Next's route pipeline
// (next/dist/server/lib/router-utils/resolve-routes.js) orders the steps:
//     middleware_next_data -> headers -> redirects -> middleware
//       -> beforeFiles -> check_fs (public/) -> ...
// `check_fs` — the step that serves `public/` — runs AFTER middleware, and
// minimalMode is false for self-hosted `next dev` and `next start` alike. So
// `public/` IS gated by this matcher: /countries-110m.json, /icons.svg and
// /data/*.json all return 401. Verified by request, not by reading.
//
// What is genuinely NOT gated: `_next/static` and `favicon.ico`. Those are the
// only two exclusions, and they are the complete ungated surface.
//
// The ruvector.db relocation therefore stands as defence in depth — it also
// survives a static export, where no middleware runs at all — but it was not
// the only thing standing between that file and the network.
export const config = {
  // Segment-anchored, not prefix-anchored. `_next/static` as a bare prefix also
  // excused `/_next/staticXapi/status`; nothing is served there today, but the
  // exclusion should describe what it means.
  //
  // `_next/image` is deliberately NOT excluded. An earlier revision listed it
  // as `_next/image\?`, which never matched: Next tests this pattern against the
  // PATHNAME, and a query string is not part of a pathname, so the exclusion was
  // inert and the route was gated anyway. Rather than repair the exclusion, keep
  // the behaviour and drop the pretence — there is no reason image optimisation
  // should be anonymous when nothing else is.
  matcher: ['/((?!_next/static/|favicon\\.ico$).*)'],
}

/**
 * Paths that may be served without credentials.
 *
 * Every entry needs a reason. "It is only a GET" is not one: GET /api/status
 * reaches openDb, which sets journal_mode=WAL and executes the schema against
 * the production run database.
 */
// DELIBERATELY EMPTY. The entry that used to sit here exempted /api/health — a
// route that does not exist. A pre-authorised hole reserved for unwritten code
// is exactly the silent-failure direction this inversion exists to remove:
// whoever creates src/app/api/health/route.ts in six months would inherit an
// unauthenticated route without ever opening this file. Add the exemption when
// the route exists and its "touches nothing" claim can actually be checked.
const PUBLIC_PATHS: Array<{ pattern: RegExp; why: string }> = []

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(p => p.pattern.test(pathname))
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
  const pathname = req.nextUrl.pathname
  const accessKey = process.env.APP_ACCESS_KEY
  const isApi = pathname.startsWith('/api')

  // The only way past the gate without credentials.
  if (isPublic(pathname)) return NextResponse.next()

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
