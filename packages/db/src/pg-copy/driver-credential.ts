// THE DRIVER CREDENTIAL, PARSED FOR node-postgres.
//
// WHY THIS IS NOT `parseCredentialUrl`. That parser is the EXPORT-ROLE reader,
// and it refuses anything whose authority does not begin with `/`:
//
//   if (!hostAndPath.startsWith('/')) throw ... 'not the reviewed socket form'
//
// It therefore accepts exactly one shape - the libpq socket form
// `postgresql://user:pass@/db?host=/sock&port=N` - and cannot parse a TCP
// credential such as `postgresql://user:pass@127.0.0.1:5432/db` at all.
// Reusing it would have meant either loosening the export reader (which several
// suites pin) or hand-editing URLs at the call site. So this is a separate,
// narrow parser for the two forms the reviewed design names, and the export
// reader is untouched.
//
// WHY TWO FORMS, AND WHOSE POLICY DECIDES. This parser supports both reviewed
// URL shapes because separate call sites have separate policies - it is a
// grammar, not an authorization. K8-B1 settled the copy target specifically:
// `pg_hba.conf` has a `local` rule for `ai_capital_migrator` and no `host`
// rule, so THE COPY TARGET IS PRIVATE-SOCKET ONLY, and the copy-target caller
// pins that itself through `TARGET_COPY_TRANSPORT`. Nothing here should be read
// as saying the reviewed production copy target uses TCP; it does not.
//
// WHAT IT REFUSES, AND WHY THE LIST IS LONG. A credential URL is operator
// input that decides WHICH DATABASE A PRODUCTION COPY WRITES TO. Every
// ambiguity below is a way for two readers to disagree about that endpoint:
// a duplicate `port`, a stray fragment, a second line, a `KEY=value` fragment
// of a pgpass file pasted into the wrong container. None of them is corrected
// here - each is refused, because a URL that needs correcting is a URL whose
// author and whose reader disagree.
//
// NOTHING SUPPLIED IS EVER ECHOED. Not the URL, not the userinfo, not the
// password, and not a digest of any of them: an error string reaches logs,
// evidence and test output, and a digest of a secret is still a function of
// the secret.

/** The reviewed endpoint shapes. Nothing else parses. */
export type DriverCredentialForm = 'tcp' | 'socket'

export interface ParsedDriverCredential {
  readonly form: DriverCredentialForm
  readonly user: string
  readonly password: string
  readonly database: string
  /** A hostname/address for `tcp`, an absolute socket DIRECTORY for `socket`. */
  readonly host: string
  readonly port: number
}

export class DriverCredentialRefused extends Error {
  constructor(readonly reason: string) {
    super(`the driver credential is refused: ${reason}`)
    this.name = 'DriverCredentialRefused'
  }
}

const SCHEME = 'postgresql://'
/** 1-65535, written canonically: no leading zero, no sign, no whitespace. */
const CANONICAL_PORT = /^[1-9][0-9]{0,4}$/
/** Reviewed identifier text: printable, no whitespace, no separators. */
const NO_CONTROL = /^[^\s\u0000-\u001f\u007f]+$/

const refuse = (reason: string): never => { throw new DriverCredentialRefused(reason) }

/** Percent-decode, refusing an invalid sequence rather than passing it through. */
function decodeStrict(raw: string, what: string): string {
  let out: string
  try {
    out = decodeURIComponent(raw)
  } catch {
    return refuse(`${what} is not valid percent-encoding`)
  }
  if (!NO_CONTROL.test(out)) refuse(`${what} carries whitespace or a control character`)
  return out
}

export function parseDriverCredentialUrl(url: string): ParsedDriverCredential {
  if (typeof url !== 'string' || url === '') refuse('it is empty')
  // A SINGLE LINE. Checked before anything is split, so a pgpass line or a
  // second URL cannot reach the parser proper.
  if (/[\r\n]/.test(url)) refuse('it spans more than one line')
  if (/\u0000/.test(url)) refuse('it contains a NUL')
  if (/\s/.test(url)) refuse('it contains whitespace')
  // `KEY=value` is pgpass/keyword syntax, not a URL.
  if (!url.startsWith(SCHEME)) refuse('it is not a postgresql:// URL')
  if (url.includes('#')) refuse('it carries a fragment')

  const rest = url.slice(SCHEME.length)
  const qmark = rest.indexOf('?')
  const beforeQuery = qmark === -1 ? rest : rest.slice(0, qmark)
  const query = qmark === -1 ? '' : rest.slice(qmark + 1)
  if (query.includes('?')) refuse('it carries more than one query string')

  const at = beforeQuery.lastIndexOf('@')
  if (at < 0) refuse('it carries no userinfo')
  const userinfo = beforeQuery.slice(0, at)
  const authority = beforeQuery.slice(at + 1)
  const colon = userinfo.indexOf(':')
  if (colon < 0) refuse('it carries no password')
  const user = decodeStrict(userinfo.slice(0, colon), 'the username')
  const password = decodeStrict(userinfo.slice(colon + 1), 'the password')
  if (user === '') refuse('the username is empty')
  if (password === '') refuse('the password is empty')

  // ONE PASS OVER THE QUERY, so a duplicate or unknown key is refused rather
  // than last-one-wins. `URLSearchParams.get` hides duplicates.
  const seen = new Map<string, string>()
  if (query !== '') {
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=')
      if (eq < 1) refuse('a query parameter is not key=value')
      const k = pair.slice(0, eq)
      if (k !== 'host' && k !== 'port') refuse('an unknown query parameter is present')
      if (seen.has(k)) refuse('a query parameter is supplied twice')
      seen.set(k, decodeStrict(pair.slice(eq + 1), `the ${k} parameter`))
    }
  }

  if (authority.startsWith('/')) {
    // SOCKET FORM: the path is the database, and host/port are query keys.
    const database = decodeStrict(authority.slice(1), 'the database')
    if (database === '' || database.includes('/')) refuse('the database is empty or not a single name')
    const host = seen.get('host')
    const port = seen.get('port')
    if (host === undefined || port === undefined) {
      refuse('the socket form needs both host and port parameters')
    }
    if (!(host as string).startsWith('/')) refuse('the socket host is not an absolute directory')
    if (!CANONICAL_PORT.test(port as string)) refuse('the port is not canonical')
    const n = Number(port)
    if (n < 1 || n > 65535) refuse('the port is out of range')
    return Object.freeze({ form: 'socket' as const, user, password, database, host: host as string, port: n })
  }

  // TCP FORM: host:port in the authority, database as the path, no query keys.
  if (seen.size > 0) refuse('the TCP form takes no host or port parameter')
  const slash = authority.indexOf('/')
  if (slash < 0) refuse('it names no database')
  const hostPort = authority.slice(0, slash)
  const database = decodeStrict(authority.slice(slash + 1), 'the database')
  if (database === '' || database.includes('/')) refuse('the database is empty or not a single name')
  const hc = hostPort.lastIndexOf(':')
  if (hc < 1) refuse('the TCP form needs host:port')
  const host = decodeStrict(hostPort.slice(0, hc), 'the host')
  const portText = hostPort.slice(hc + 1)
  if (host === '') refuse('the host is empty')
  if (host.startsWith('[') || host.includes('@')) refuse('the host form is not reviewed')
  if (!CANONICAL_PORT.test(portText)) refuse('the port is not canonical')
  const port = Number(portText)
  if (port < 1 || port > 65535) refuse('the port is out of range')
  return Object.freeze({ form: 'tcp' as const, user, password, database, host, port })
}

/**
 * ONE PGPASS RECORD, FROM THE ALREADY-PARSED REVIEWED CREDENTIAL.
 *
 * K8-B: the target used to have TWO independently selected secrets - a driver
 * URL for the node-postgres sessions and a `--target-passfile` for the
 * psql-backed identity session. Nothing compared them, so they could name
 * different roles, different databases or different servers, and a pgpass file
 * can carry wildcard rows that match endpoints nobody reviewed. Provisioning a
 * second persistent secret would have duplicated the password at rest and kept
 * the ambiguity. So the driver credential is the single target authority and
 * this function derives the psql form from it.
 *
 * EXACTLY ONE RECORD, NO WILDCARD. libpq treats `*` as "any", which is the
 * whole hazard; every field here is a literal taken from the parsed credential.
 * In a pgpass field a backslash escapes the next character, so a literal
 * backslash and a literal colon must each be escaped - otherwise a password
 * containing `:` would silently split the record into the wrong columns.
 *
 * The returned value is SECRET. It is written to an anonymous descriptor and
 * never placed in argv, an environment, a log, an error or evidence.
 */
export function pgpassRecordFor(c: ParsedDriverCredential): string {
  // THE ESCAPE IS APPLIED TO EVERY FIELD, including the ones that "cannot"
  // contain a colon: a host, database or role that does is a refusal upstream,
  // not a reason for this function to produce an ambiguous line.
  const field = (v: string): string => v.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
  // BOTH REVIEWED FORMS, WITHOUT WIDENING THE PARSER.
  //
  // K8-B1: this refused everything but TCP, which is exactly backwards for the
  // copy: `pg_hba.conf` reaches `ai_capital_migrator` over the private Unix
  // socket only. For the socket form libpq matches the pgpass host field
  // against the socket DIRECTORY, which is what the parser already returns as
  // `host`, so the record is built the same way for both forms.
  // AND NO EMBEDDED NEWLINE CAN REACH THIS. `parseDriverCredentialUrl` refuses
  // CR and LF anywhere in the URL before any field is decoded, so a second row
  // cannot be smuggled in through the password.
  for (const v of [c.host, c.database, c.user, c.password]) {
    if (/[\r\n]/.test(v)) {
      throw new DriverCredentialRefused('a credential field spans more than one line')
    }
  }
  return `${field(c.host)}:${field(String(c.port))}:${field(c.database)}:` +
    `${field(c.user)}:${field(c.password)}\n`
}
