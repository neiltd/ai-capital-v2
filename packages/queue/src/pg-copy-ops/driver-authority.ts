// THE FIVE REVIEWED DRIVER SESSIONS, AND THE CREDENTIALS THEY COME FROM.
//
// ONE AUTHORITY, FIVE NAMED OPENERS - not five readers. Each opener knows which
// container it may read, which endpoint that container must describe, which
// role must be authenticating, and whether the session may speak before the
// caller's first statement. Duplicating that per call site is how two of them
// end up disagreeing about the target.
//
// NOTHING IS OPENED BY CONSTRUCTION, AND NOTHING IS CACHED. Building the
// authority performs no filesystem read and no connection: a process that has
// merely parsed its arguments holds no secret and no session. Every opener
// reads its container, parses it, proves the endpoint, connects, and hands
// OWNERSHIP to its caller. A returned session is never closed here - the caller
// owns it - but a session constructed and then found unusable is reaped before
// the refusal propagates, because the alternative is a live backend nobody has
// a handle to.
//
// WHY STAGE 1 IS SILENT AND STAGE 2 IS NOT. `openDriverSession` asks the server
// `SELECT pg_catalog.pg_backend_pid()` before anything else. Stage 1 promises
// that BEGIN is the first statement its export session issues, so it must use
// `openSilentDriverSession`; the verifier makes the same promise. Stage 2's own
// sessions may speak first and use the ordinary opener.

import {
  DriverCredentialRefused, EXPORT_ROLE_NAME, openDriverSession,
  openSilentDriverSession, parseDriverCredentialUrl,
  type DriverSession, type DriverTarget, type ParsedDriverCredential,
} from '@common/db/pg-copy'
import { openReviewedContainer } from './secure-file.js'

/** What a container must describe, stated by the caller and never inferred. */
export interface EndpointExpectation {
  readonly host: string
  readonly port: string
  readonly database: string
  /** The role that must be authenticating. */
  readonly role: string
}

/**
 * The two ways a session may be opened. Injectable so a test can prove WHICH
 * one each factory chose - a property no assertion on a live session can see.
 *
 * TYPED AS THE REAL THING. An earlier revision used a structural
 * `OwnedSession` with an index signature, which meant every hand-off to
 * `runStage1`, `runInspect` and `runLifecycle` needed a cast - and a cast is
 * exactly where a wrong session passes without the compiler noticing. A
 * `DriverSession` already satisfies `ExportSession` (`pid` + `rows`) and
 * `VerifyCloseable` (those plus `end`), so the exact type works everywhere and
 * nothing is asserted away.
 */
export interface DriverOpeners {
  readonly ordinary: (t: DriverTarget) => Promise<DriverSession>
  readonly silent: (t: DriverTarget) => Promise<DriverSession>
}

/** Production binds straight to the two reviewed openers. */
export const REVIEWED_OPENERS: DriverOpeners = Object.freeze({
  ordinary: openDriverSession,
  silent: openSilentDriverSession,
})

export interface DriverAuthorityInputs {
  /** Stage 1, Stage-2 source and the verifier source all authenticate as the export role. */
  readonly exportCredentialPath: string
  /**
   * ONE TARGET AUTHORITY, read by the copy AND by its verification.
   *
   * A second selectable secret path was briefly introduced and is removed:
   * verifier INDEPENDENCE means a fresh backend that measures the target for
   * itself, not a different password file. Two selectable paths would have
   * added a way for the copy and the check to be pointed at different
   * databases - the precise confusion the verification exists to detect.
   */
  readonly targetCredentialPath: string
  readonly source: EndpointExpectation
  /**
   * THE TARGET EXPECTATION, RESOLVED WHEN A TARGET SESSION IS FIRST OPENED.
   *
   * A THUNK, not a value, and that is the point. The reviewed apply measures
   * the target identity only AFTER Stage 1 has published its bundle, so the
   * expectation does not exist when this authority is constructed - but
   * `openStage1ExportSource` must already be available, because Stage 1 is
   * what creates the bundle. Holding it as a value forced the apply to derive
   * the target from a PRE-EXISTING `--bundle-dir` before taking the fence,
   * which is exactly the broken chain K7-B6.1 Phase B removes.
   *
   * Every target opener calls this lazily, so a caller that has not yet
   * derived the expectation can refuse from inside the thunk and no target
   * connection is attempted at all.
   */
  readonly target: () => EndpointExpectation
}

export class DriverAuthorityRefused extends Error {
  constructor(readonly reason: string) {
    super(`the driver session was refused: ${reason}`)
    this.name = 'DriverAuthorityRefused'
  }
}

export interface DriverAuthority {
  /** Stage 1's export session. SILENT: BEGIN must be its first statement. */
  openStage1ExportSource(): Promise<DriverSession>
  openStage2Source(): Promise<DriverSession>
  openStage2Target(): Promise<DriverSession>
  /** The independent verifier's source. SILENT. */
  openVerifierSource(): Promise<DriverSession>
  /**
   * The independent verifier's target. SILENT, and from the SAME credential.
   *
   * Independence is the fresh backend, enforced below: a session already handed
   * out is refused, so this can never be the Stage-2 target's connection.
   */
  openVerifierTarget(): Promise<DriverSession>
}

/** Read one reviewed container and parse exactly one URL out of it. */
function readCredential(path: string, which: string): ParsedDriverCredential {
  const text = openReviewedContainer(path).text
  // EXACTLY ONE URL, with at most ONE trailing LF removed. `trim()` would
  // silently accept a leading space, a CR, a tab or a second blank line - all
  // of which mean somebody's container is not what was reviewed.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (body === '') throw new DriverAuthorityRefused(`the ${which} container is empty`)
  if (/[\r\n]/.test(body)) {
    throw new DriverAuthorityRefused(`the ${which} container is not a single line`)
  }
  try {
    return parseDriverCredentialUrl(body)
  } catch (e) {
    // The reason is bounded and carries nothing supplied; the container NAME is
    // this module's own input, so saying which one failed is safe.
    throw new DriverAuthorityRefused(
      `the ${which} credential is not in the reviewed form` +
      (e instanceof DriverCredentialRefused ? ` (${e.reason})` : ''))
  }
}

function proveEndpoint(
  p: ParsedDriverCredential, want: EndpointExpectation, which: string,
): void {
  if (p.host !== want.host) throw new DriverAuthorityRefused(`the ${which} host is not the reviewed one`)
  if (String(p.port) !== want.port) throw new DriverAuthorityRefused(`the ${which} port is not the reviewed one`)
  if (p.database !== want.database) throw new DriverAuthorityRefused(`the ${which} database is not the reviewed one`)
  if (p.user !== want.role) throw new DriverAuthorityRefused(`the ${which} role is not the reviewed one`)
}

export function driverAuthority(
  i: DriverAuthorityInputs, openers: DriverOpeners,
): DriverAuthority {
  /**
   * EVERY HANDLE THIS AUTHORITY HAS ALREADY GIVEN AWAY.
   *
   * FRESHNESS ENFORCED AT THE BOUNDARY, not only asserted in a test. An opener
   * that returned a cached client would hand two reviewed callers the same
   * backend: the Stage-2 source and the independent VERIFIER source would then
   * be the same session, and the verification would be checking the copy
   * through the connection that made it. That is the one thing an independent
   * verifier must not be, so a repeat is refused here - and the repeat is
   * reaped, because it is a live backend this module was just handed.
   */
  const handedOut = new WeakSet<DriverSession>()

  // NO READ AND NO CONNECTION HERE. See the header.
  const open = async (
    path: string, want: () => EndpointExpectation, which: string,
    how: 'ordinary' | 'silent',
  ): Promise<DriverSession> => {
    // THE EXPECTATION FIRST, BEFORE THE CREDENTIAL IS EVEN READ. A caller that
    // has not derived it yet refuses from inside the thunk, so no secret is
    // read and no connection is attempted.
    const wanted = want()
    const parsed = readCredential(path, which)
    proveEndpoint(parsed, wanted, which)
    const target: DriverTarget = {
      host: parsed.host, port: parsed.port,
      database: parsed.database, user: parsed.user, password: parsed.password,
    }
    const session = await openers[how](target)
    // REAP A SESSION THAT WAS BUILT AND CANNOT BE HANDED OVER. Nothing below
    // can fail today; the shape stays so a later check added here cannot leak
    // a live backend.
    // FROM HERE ON A LIVE BACKEND EXISTS. Any refusal below must reap it, or
    // the process holds a connection nobody has a handle to.
    try {
      if (typeof session.end !== 'function') {
        throw new DriverAuthorityRefused(`the ${which} session is not a usable handle`)
      }
      if (handedOut.has(session)) {
        throw new DriverAuthorityRefused(
          `the ${which} opener returned a session that was already handed out`)
      }
      handedOut.add(session)
      return session
    } catch (e) {
      await Promise.resolve(session.end?.()).catch(() => undefined)
      throw e
    }
  }

  return {
    openStage1ExportSource: async () => await open(
      i.exportCredentialPath, () => ({ ...i.source, role: EXPORT_ROLE_NAME }), 'stage-1 export', 'silent'),
    openStage2Source: async () => await open(
      i.exportCredentialPath, () => ({ ...i.source, role: EXPORT_ROLE_NAME }), 'stage-2 source', 'ordinary'),
    openStage2Target: async () => await open(
      i.targetCredentialPath, i.target, 'stage-2 target', 'ordinary'),
    openVerifierSource: async () => await open(
      i.exportCredentialPath, () => ({ ...i.source, role: EXPORT_ROLE_NAME }), 'verifier source', 'silent'),
    openVerifierTarget: async () => await open(
      i.targetCredentialPath, i.target, 'verifier target', 'silent'),
  }
}
