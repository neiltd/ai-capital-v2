#!/usr/bin/env node
// Install or rotate the pipeline credential file.
//
// THE SECRET ENTERS THROUGH EXACTLY TWO DOORS, and neither is visible to
// anything else on the machine:
//
//   * an interactive terminal with echo disabled;
//   * a pre-opened file descriptor (`--fd 3`), for a caller that already holds
//     the value privately.
//
// Never argv (visible in `ps`), never an ordinary environment variable
// (inherited by children and captured in crash dumps), never stdout, never a
// log line, never shell history, never command substitution.
//
// The value is validated — including the exact ai_capital_pipeline role — BEFORE
// anything is written, so a typo never reaches the filesystem at all.

import { readSync } from 'fs'
import { isAbsolute } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { realpathSync } from 'fs'
import { createInterface } from 'readline'
import { resolve } from 'path'

import { requireExplicitPostgresUrl } from '@common/db/credential-url'
import { PIPELINE_ROLE } from '../src/env.js'
import { MAX_CREDENTIAL_FILE_BYTES, decodeCredentialBytes } from '../src/credential-file.js'
import {
  checkCount, cleanupIncomplete, defaultPublishSeam, describeCleanup, publishBytes,
  type CleanupState, type PublishOutcome, type PublishSeam,
} from '../src/atomic-publish.js'

/** Documented production location. The CONSUMER has no default: the plist
 *  supplies an absolute path, so nothing in the runtime guesses this. */
export const DOCUMENTED_DESTINATION = '~/.config/ai-capital/pipeline-database.url'

export const USAGE =
  'usage: install-pipeline-credential.ts --path <abs> [--rotate] [--fd <n>]\n' +
  `  production location: ${DOCUMENTED_DESTINATION}\n` +
  '  The secret is read from a no-echo terminal, or from --fd. Never from argv.'

/** Read one line from a terminal with echo disabled, restoring state always. */
export async function readSecretFromTty(): Promise<string> {
  const input = process.stdin
  const wasRaw = input.isRaw === true
  const rl = createInterface({ input, output: process.stderr, terminal: true })
  const restore = () => {
    try { if (input.isTTY && input.isRaw !== wasRaw) input.setRawMode(wasRaw) } catch { /* ignore */ }
    try { rl.close() } catch { /* ignore */ }
  }
  // Restore on signals too: a Ctrl-C with echo off leaves the terminal unusable.
  const onSignal = () => { restore(); process.exit(130) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    // Suppress echo by writing nothing back for each keypress.
    const anyRl = rl as unknown as { _writeToOutput?: (s: string) => void }
    anyRl._writeToOutput = () => { /* echo nothing */ }
    process.stderr.write('pipeline credential URL (input hidden): ')
    const line = await new Promise<string>((res) => rl.question('', res))
    process.stderr.write('\n')
    return line
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    restore()
  }
}

/**
 * Read the secret from an already-open descriptor.
 *
 * A read ERROR IS PROPAGATED, never treated as end-of-input. The first version
 * caught and broke, so an EIO after two hundred bytes produced a silently
 * truncated credential that might still parse — the worst possible outcome for
 * a value nothing downstream can sanity-check.
 *
 * Framing and decoding are the SAME rules credential files use, via
 * decodeCredentialBytes: one optional terminating LF, no CR, no NUL, one line
 * only, fatal UTF-8. Duplicating them here is how the two paths would drift.
 *
 * The descriptor belongs to the caller and is not closed here.
 */
export function readSecretFromFd(fd: number): string {
  const buf = new Uint8Array(MAX_CREDENTIAL_FILE_BYTES + 1)
  let total = 0
  for (;;) {
    const remaining = buf.length - total
    if (remaining === 0) throw new Error(`credential on the supplied descriptor exceeds ${MAX_CREDENTIAL_FILE_BYTES} bytes`)
    // No try/catch: an I/O error must surface, not become EOF.
    const n = checkCount(readSync(fd, buf, total, remaining, null), remaining, 'fd read')
    if (n === 0) break
    total += n
    if (total > MAX_CREDENTIAL_FILE_BYTES) {
      throw new Error(`credential on the supplied descriptor exceeds ${MAX_CREDENTIAL_FILE_BYTES} bytes`)
    }
  }
  return decodeCredentialBytes('<supplied descriptor>', buf.subarray(0, total))
}

export interface InstallOptions { path: string; rotate: boolean }

export interface InstallResult {
  outcome: 'installed' | 'rotated' | 'unchanged'
  /** Post-publication state. `cleanupIncomplete` decides whether this is a clean success. */
  cleanup: CleanupState
}

/**
 * Publish the credential, or leave the destination exactly as it was.
 *
 * Uses the one shared publication primitive, so the ordering, locking,
 * temp-ownership and create-vs-replace semantics are the same ones the renderer
 * is tested against.
 *
 * `--rotate` means REPLACE something that exists. It does not silently become an
 * initial install: if there is nothing there, the operator's mental model and
 * the filesystem disagree, and that is worth stopping for.
 */
export function installCredential(
  secret: string,
  options: InstallOptions,
  seam: PublishSeam = defaultPublishSeam,
): InstallResult {
  if (!isAbsolute(options.path)) throw new Error('--path must be absolute')

  // Validate BEFORE writing anything: a bad credential never reaches disk.
  requireExplicitPostgresUrl('credential', secret, { user: PIPELINE_ROLE })

  let result: PublishOutcome
  try {
    result = publishBytes(options.path, Buffer.from(`${secret}\n`, 'utf-8'), {
      mode: options.rotate ? 'replace' : 'create',
      fileMode: 0o600,
      directoryMode: 0o700,
    }, seam)
  } catch (e) {
    const message = (e as Error).message
    if (!options.rotate && /already exists/.test(message)) {
      throw new Error(`${message} Pass --rotate to replace it. No backup is written.`)
    }
    if (options.rotate && /does not exist/.test(message)) {
      throw new Error(`${message} --rotate never silently becomes an initial installation.`)
    }
    throw e
  }

  if (result.unchanged) return { outcome: 'unchanged', cleanup: result.cleanup }
  return { outcome: options.rotate ? 'rotated' : 'installed', cleanup: result.cleanup }
}

/** @param seam injected only by tests; the default is the real filesystem. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  seam: PublishSeam = defaultPublishSeam,
): Promise<number> {
  let path: string | undefined
  let rotate = false
  let fd: number | undefined
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--path': path = argv[i + 1]; i += 1; break
      case '--rotate': rotate = true; break
      case '--fd': fd = Number(argv[i + 1]); i += 1; break
      default:
        process.stderr.write(`install-pipeline-credential: unknown argument ${argv[i]}\n${USAGE}\n`)
        return 64
    }
  }
  if (path === undefined) {
    process.stderr.write(`install-pipeline-credential: --path is required\n${USAGE}\n`)
    return 64
  }

  let secret: string
  try {
    if (fd !== undefined) {
      if (!Number.isInteger(fd) || fd < 0) { process.stderr.write('install-pipeline-credential: --fd must be a descriptor number\n'); return 64 }
      secret = readSecretFromFd(fd)
    } else if (process.stdin.isTTY) {
      secret = await readSecretFromTty()
    } else {
      process.stderr.write('install-pipeline-credential: stdin is not a terminal; supply --fd instead. The secret is never read from a pipe by default.\n')
      return 64
    }
    const result = installCredential(secret, { path, rotate }, seam)
    // The path is configuration, not a secret. The value is never printed.
    const wroteSomething = result.outcome !== 'unchanged'
    if (cleanupIncomplete({ published: wroteSomething, unchanged: !wroteSomething, cleanup: result.cleanup })) {
      // STATE (b): the credential IS at that path, and the invocation did not
      // finish tidily. Two sub-cases, and the retry advice differs:
      //
      //   wrote something  — the destination did not exist (or held other bytes)
      //                      and now holds ours, so any re-run must be --rotate.
      //   unchanged        — the destination ALREADY held exactly these bytes.
      //                      Nothing was written, so an identical re-run is still
      //                      an ordinary install and does NOT need --rotate.
      //                      Telling the operator otherwise sends them to a flag
      //                      that authorizes overwriting for no reason.
      const retry = wroteSomething
        ? 'Do NOT simply re-run: the destination now exists, so an initial installation would be ' +
          'refused and any re-run would have to be a --rotate.'
        : 'The existing destination was ALREADY correct and nothing was written, so a later identical ' +
          'run does NOT require --rotate. Resolve the cleanup problem first.'
      process.stderr.write(
        `${result.outcome}: ${path}\n` +
        `WARNING: the credential IS PRESENT at that path — this is NOT a failed installation. ` +
        `Cleanup did not complete: ${describeCleanup(result.cleanup)}. ` +
        `${retry} Resolve the items above by hand first.\n`,
      )
      return 75
    }
    process.stderr.write(`${result.outcome}: ${path}\n`)
    return 0
  } catch (e) {
    process.stderr.write(`install-pipeline-credential: ${(e as Error).message}\n`)
    return 73
  }
}

export function isDirectEntrypoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false
  const canonical = (p: string) => {
    try { return pathToFileURL(realpathSync(p)).href } catch { return pathToFileURL(resolve(p)).href }
  }
  const self = (() => { try { return canonical(fileURLToPath(moduleUrl)) } catch { return moduleUrl } })()
  return self === canonical(argv1)
}

if (isDirectEntrypoint(import.meta.url)) {
  main().then(code => { process.exitCode = code })
}
