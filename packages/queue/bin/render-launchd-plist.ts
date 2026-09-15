#!/usr/bin/env node
// Render one launchd plist from its tracked template.
//
// Handles no credential: the values it substitutes are a repository path, an
// unauthenticated Redis endpoint, and the PATH of a credential file. A template
// carrying a credential placeholder, or output containing a PostgreSQL URL or a
// forbidden database key, is refused before anything is published.
//
// There is no arbitrary --out. Each agent maps to exactly one installed path,
// which removes path traversal and wrong-label installation as a class. A
// staging directory is available for lint-only dry runs, and the tool creates it
// itself rather than writing into a directory it was merely pointed at.

import { mkdirSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { realpathSync } from 'fs'

import {
  AGENTS, type AgentName, assertParsedPlistIsSafe, defaultLintSeam, defaultParseSeam,
  installedPath, renderPlist,
} from '../src/launchd-renderer.js'
import {
  type PublishSeam, assertDirectory, cleanupIncomplete, defaultPublishSeam, describeCleanup, publishBytes,
} from '../src/atomic-publish.js'

export const USAGE =
  'usage: render-launchd-plist.ts --agent <name> --root <abs> [--redis-url <url>]\n' +
  '                              [--credential-file <abs>] [--staging-dir <abs>] [--replace]\n' +
  '  --staging-dir must NOT already exist; this tool creates it.\n' +
  `  agents: ${Object.keys(AGENTS).join(', ')}\n` +
  '  No --out: each agent renders to its one ~/Library/LaunchAgents path.\n' +
  '  --staging-dir renders to a directory this tool creates, for lint-only runs.'

export interface ParsedArgs {
  agent?: string
  root?: string
  redisUrl?: string
  credentialFile?: string
  stagingDir?: string
  replace: boolean
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { replace: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = () => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${flag} requires a value`)
      i += 1
      return v
    }
    switch (flag) {
      case '--agent': out.agent = value(); break
      case '--root': out.root = value(); break
      case '--redis-url': out.redisUrl = value(); break
      case '--credential-file': out.credentialFile = value(); break
      case '--staging-dir': out.stagingDir = value(); break
      case '--replace': out.replace = true; break
      default: throw new Error(`unknown argument: ${flag}`)
    }
  }
  return out
}

/** The repository's tracked template directory, relative to this file. */
export function templateDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return resolve(here, '..', '..', '..', 'ops', 'launchd')
}

/**
 * @param seam injected only by tests, so the post-publication failure states can
 *   be driven for real rather than asserted against this file's source text. The
 *   default is the real filesystem, and a non-vacuity control pins that.
 */
export function main(
  argv: readonly string[] = process.argv.slice(2),
  seam: PublishSeam = defaultPublishSeam,
): number {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    process.stderr.write(`render-launchd-plist: ${(e as Error).message}\n${USAGE}\n`)
    return 64
  }

  const agent = args.agent as AgentName | undefined
  if (agent === undefined || !(agent in AGENTS)) {
    process.stderr.write(`render-launchd-plist: --agent must be one of ${Object.keys(AGENTS).join(', ')}\n`)
    return 64
  }
  if (args.root === undefined || !isAbsolute(args.root)) {
    process.stderr.write('render-launchd-plist: --root must be an absolute path\n')
    return 64
  }

  const contract = AGENTS[agent]
  const values: Record<string, string> = { AI_CAPITAL_ROOT: args.root }
  if ('REDIS_URL' in contract.placeholders) {
    if (args.redisUrl === undefined) {
      process.stderr.write(`render-launchd-plist: ${agent} requires --redis-url\n`)
      return 64
    }
    values.REDIS_URL = args.redisUrl
  }
  if ('PIPELINE_CREDENTIAL_FILE' in contract.placeholders) {
    if (args.credentialFile === undefined || !isAbsolute(args.credentialFile)) {
      process.stderr.write(`render-launchd-plist: ${agent} requires an absolute --credential-file\n`)
      return 64
    }
    values.PIPELINE_CREDENTIAL_FILE = args.credentialFile
  }

  let destination: string
  if (args.stagingDir !== undefined) {
    if (!isAbsolute(args.stagingDir)) {
      process.stderr.write('render-launchd-plist: --staging-dir must be absolute\n')
      return 64
    }
    // CONTRACT A, chosen explicitly: the staging directory must NOT already
    // exist. Round 1 accepted an existing directory while claiming the tool had
    // created it, and used statSync, which follows a symlink — so a symlinked
    // staging path passed a check that described something else entirely.
    // Requiring absence removes both problems: there is nothing to inspect.
    try {
      mkdirSync(args.stagingDir, { recursive: false, mode: 0o700 })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const why = code === 'EEXIST'
        ? 'already exists; this tool creates its own staging directory so it can vouch for the mode and owner'
        : `could not be created (${code ?? 'unknown error'})`
      process.stderr.write(`render-launchd-plist: --staging-dir ${why}\n`)
      return 73
    }
    destination = join(args.stagingDir, `${contract.label}.plist`)
  } else {
    destination = installedPath(agent)
    // The real LaunchAgents directory: a real, owner-owned directory, reached
    // through no symlink. Its mode is NOT pinned — launchd's own directory is
    // conventionally 0755 and is not ours to tighten — so ownership plus the
    // no-symlink rule is the documented, accepted policy here.
    try {
      assertDirectory(dirname(destination), null)
    } catch (e) {
      process.stderr.write(`render-launchd-plist: ${(e as Error).message}\n`)
      return 73
    }
  }

  try {
    const text = renderPlist({ agent, templateDir: templateDir(), values })
    const result = publishBytes(destination, Buffer.from(text, 'utf-8'), {
      mode: args.replace ? 'replace' : 'create',
      fileMode: 0o600,
      directoryMode: null,
      // Runs on the TEMPORARY file, before publication: lint it, then parse it
      // and inspect the real EnvironmentVariables dictionary. A regex over XML
      // cannot see an entity-encoded or mixed-case URL; a parser can.
      validate: (temp) => {
        const lint = defaultLintSeam.lint(temp)
        if (lint.status !== 0) throw new Error(`plutil -lint rejected the rendered plist. ${lint.stderr.trim()}`)
        const json = defaultParseSeam.toJson(temp)
        if (json.status !== 0) throw new Error('the rendered plist could not be parsed for semantic validation.')
        let parsed: unknown
        try { parsed = JSON.parse(json.stdout) } catch { throw new Error('the parsed plist was not valid JSON.') }
        assertParsedPlistIsSafe(parsed)
      },
    }, seam)
    if (result.unchanged && !cleanupIncomplete(result)) {
      process.stdout.write(`unchanged: ${destination}\n`)
      return 0
    }
    if (cleanupIncomplete(result)) {
      // The plist IS present; the invocation did not finish tidily. Both facts
      // are stated, because an operator who reads only "failed" would re-run a
      // publication that may now need --replace — and, in the unchanged case,
      // would reach for a flag that authorizes an overwrite for no reason.
      const retry = result.published
        ? 'The destination now holds the newly rendered plist, so a re-run needs --replace.'
        : 'The existing destination was ALREADY byte-identical and nothing was written, so a later ' +
          'identical run does NOT require --replace. Resolve the cleanup problem first.'
      process.stderr.write(
        `${result.published ? 'published' : 'unchanged'}: ${destination}\n` +
        `WARNING: the plist IS PRESENT at that path — this is NOT a failed render. ` +
        `Cleanup did not complete: ${describeCleanup(result.cleanup)}. ` +
        `${retry} Resolve the items above by hand first.\n`,
      )
      return 75
    }
    process.stdout.write(`published: ${destination}\n`)
    return 0
  } catch (e) {
    process.stderr.write(`render-launchd-plist: ${(e as Error).message}\n`)
    return 73
  }
}

// Importing this module must be inert; only direct execution runs main().
export function isDirectEntrypoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false
  const canonical = (p: string) => {
    try { return pathToFileURL(realpathSync(p)).href } catch { return pathToFileURL(resolve(p)).href }
  }
  const self = (() => { try { return canonical(fileURLToPath(moduleUrl)) } catch { return moduleUrl } })()
  return self === canonical(argv1)
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exitCode = main()
}
