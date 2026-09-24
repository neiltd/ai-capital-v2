// ATOMIC NO-REPLACE PUBLICATION — one syscall, or nothing.
//
// THE PROBLEM, MEASURED RATHER THAN ASSUMED. Publishing a bundle means moving a
// finished directory onto its final name and NEVER replacing whatever is
// already there. On Darwin, ordinary `rename(2)` does not give that:
//
//   $ mkdir src && touch src/f && mkdir dst
//   $ python3 -c "import os; os.rename('src','dst')"
//   -> SUCCEEDS. `dst` is gone, replaced by `src`.
//
// An EMPTY destination directory is silently replaced. `renameSync` is that
// same syscall, and `/bin/mv -n` is `lstat` followed by that same syscall - a
// check-then-act with a window in between. Checking for absence immediately
// before renaming narrows the window; it does not remove it, and a publisher
// whose contract is "never overwrite a published destination" cannot be built
// on a primitive that can.
//
// THE PRIMITIVE THAT DOES GIVE IT. Darwin has `renamex_np(from, to, flags)`
// with `RENAME_EXCL`, which fails with `EEXIST` rather than replacing:
//
//   renamex_np('src', 'dst', RENAME_EXCL) -> -1, errno EEXIST
//   renamex_np('src', 'fresh', RENAME_EXCL) -> 0
//
// Both measured on the target platform. It is one syscall, so there is no
// window at all, and it is same-parent, so the atomicity the bundle layout
// depends on is preserved.
//
// WHY A PYTHON HELPER, AND WHY THAT IS NOT A DEPENDENCY. Node exposes no
// binding for `renamex_np` and no stable FFI, and adding a native module would
// mean a new runtime dependency, a changed `package.json` and a changed
// lockfile - all of which are forbidden here, and rightly: a publication
// guarantee should not arrive with a compiler. `/usr/bin/python3` is part of
// the operating system, owned by root, already the interpreter this repository
// shells out to, and its `ctypes` can call the libSystem symbol directly. The
// helper program travels on STDIN, so it never appears in a process list; the
// two paths travel in argv, which is correct - they are evidence directory
// names the operator supplied, not credentials.
//
// FAIL CLOSED, ALWAYS. If the platform is not Darwin, if `/usr/bin/python3` is
// missing, or if `renamex_np` cannot be resolved, this reports `unavailable`
// and the publisher REFUSES. There is no path here that falls back to
// `renameSync`: a silent downgrade from "cannot overwrite" to "probably will
// not overwrite" is precisely the failure this module exists to prevent.

import { execFileSync } from 'node:child_process'

/** The OS-provided interpreter. Absolute; never resolved through PATH. */
export const PYTHON3 = '/usr/bin/python3'
/** The system library carrying `renamex_np`. */
export const LIBSYSTEM = '/usr/lib/libSystem.B.dylib'
/** Darwin's `RENAME_EXCL`, from <sys/stat.h>. */
export const RENAME_EXCL = 0x4

/** Exit codes the helper uses. Nothing else is interpreted as success. */
export const HELPER_PUBLISHED = 0
export const HELPER_FAILED = 1
export const HELPER_UNAVAILABLE = 3
export const HELPER_DESTINATION_EXISTS = 17

export const HELPER_TIMEOUT_MS = 20_000

export type AtomicRenameOutcome =
  /** The directory now lives at the destination. Proved by exit 0. */
  | 'published'
  /** Something was already at the destination. It was NOT touched. */
  | 'destination-exists'
  /** No atomic no-replace primitive here. Nothing was ATTEMPTED. */
  | 'unavailable'
  /** The syscall ran and failed. Nothing was published. */
  | 'failed'
  /**
   * THE HELPER DID NOT REPORT. Whether the syscall ran is UNKNOWN.
   *
   * This is the outcome an earlier revision did not have, and its absence was
   * a lie in both directions. A helper that is killed, times out, dies on a
   * signal, or exits with a code nobody assigned may have completed
   * `renamex_np` microseconds before it went away - the rename is atomic, the
   * REPORTING of it is not. Calling that "unavailable" claims nothing was
   * attempted; calling it "failed" claims nothing was published. Both would be
   * guesses, and one of them would be a published bundle reported as absent.
   *
   * The caller must resolve it by LOOKING - device and inode, fail-closed -
   * and never by assuming.
   */
  | 'indeterminate'

/**
 * The helper, verbatim. Sent on stdin; never written to disk.
 *
 * It resolves the symbol, calls it once, and exits with a code. It prints
 * nothing on either stream, so no filesystem text can travel back through it.
 */
/**
 * Interpreter isolation, and why each flag is load-bearing.
 *
 * `-I` is isolated mode: it ignores PYTHON* environment variables, drops the
 * script's directory and the current working directory from `sys.path`, and
 * implies `-E` and `-s` (no user site directory). `-S` additionally skips
 * `site` altogether, so no `sitecustomize.py` or `usercustomize.py` runs.
 *
 * MEASURED, NOT ASSUMED. A plain `/usr/bin/python3 -c pass` on this machine
 * EXECUTES a `sitecustomize.py` planted in the user site directory; under
 * `-I -S` it does not, `sys.flags.isolated` and `sys.flags.no_site` are both
 * 1, and `ctypes` still resolves `renamex_np` and completes the rename. The
 * publication path must not be a place where anything on the machine can get
 * arbitrary code to run, and these two flags are what stops that.
 */
export const PYTHON_ISOLATION_FLAGS: readonly string[] = Object.freeze(['-I', '-S'])

export const HELPER_SOURCE = `import ctypes, os, sys
if not (sys.flags.isolated and sys.flags.no_site):
    sys.exit(${HELPER_UNAVAILABLE})
try:
    lib = ctypes.CDLL(${JSON.stringify(LIBSYSTEM)}, use_errno=True)
    fn = lib.renamex_np
except Exception:
    sys.exit(${HELPER_UNAVAILABLE})
fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
fn.restype = ctypes.c_int
try:
    src = os.fsencode(sys.argv[1])
    dst = os.fsencode(sys.argv[2])
except Exception:
    sys.exit(${HELPER_FAILED})
ctypes.set_errno(0)
if fn(src, dst, ${RENAME_EXCL}) == 0:
    sys.exit(${HELPER_PUBLISHED})
e = ctypes.get_errno()
# EEXIST and ENOTEMPTY both mean the destination was there and was left alone.
sys.exit(${HELPER_DESTINATION_EXISTS} if e in (17, 66) else ${HELPER_FAILED})
`

/**
 * Move `from` onto `to` if and only if `to` does not exist.
 *
 * Returns an outcome rather than throwing, so the caller decides what each one
 * means. It never reports `published` unless the helper exited zero, and it
 * reports `unavailable` - never `published` - when it cannot tell.
 */
/**
 * TEST-ONLY seams. Production passes nothing and gets the reviewed constants.
 *
 * They exist because the outcomes that matter most here - a helper that is
 * killed after doing the work, one that times out, one that exits with a code
 * nobody assigned - cannot be produced by the real interpreter on demand, and
 * a 20-second timeout cannot be reached in a test suite. Double-underscored,
 * following this repository's convention for seams nothing in production sets.
 */
export interface AtomicRenameSeams {
  readonly __interpreter?: string
  readonly __timeoutMs?: number
}

export function atomicRenameNoReplace(
  from: string, to: string, seams: AtomicRenameSeams = {},
): AtomicRenameOutcome {
  if (process.platform !== 'darwin') return 'unavailable'
  try {
    execFileSync(seams.__interpreter ?? PYTHON3, [...PYTHON_ISOLATION_FLAGS, '-', from, to], {
      input: HELPER_SOURCE,
      // Nothing comes back but the exit code: no stdout, no stderr, no path
      // echoed into an error this repository would then log.
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: seams.__timeoutMs ?? HELPER_TIMEOUT_MS,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    })
    return 'published'
  } catch (e) {
    const err = e as { status?: unknown; signal?: unknown; code?: unknown }
    if (err.status === HELPER_DESTINATION_EXISTS) return 'destination-exists'
    if (err.status === HELPER_UNAVAILABLE) return 'unavailable'
    if (err.status === HELPER_FAILED) return 'failed'

    // A SPAWN failure - the interpreter is missing or not executable - is the
    // only case where the syscall provably never ran. `execFileSync` reports
    // it with an errno code and no exit status.
    // MEASURED SHAPE: a spawn failure carries `status: null`, `signal: null`
    // and an errno `code` such as ENOENT or EACCES. A TIMEOUT also has no
    // numeric status, but it carries `code: 'ETIMEDOUT'` and a signal, which
    // is exactly the case that must NOT be read as "never attempted".
    if (typeof err.status !== 'number' && typeof err.code === 'string' &&
        err.code !== 'ETIMEDOUT' &&
        (err.signal === undefined || err.signal === null)) {
      return 'unavailable'
    }

    // EVERYTHING ELSE IS UNKNOWN. A timeout (`ETIMEDOUT`), a signal
    // (`SIGTERM` from the timeout, `SIGKILL` from anywhere), or an exit code
    // nobody here assigned all leave the same question open: the helper may
    // have completed the rename and then been killed before `execFileSync`
    // could observe its zero. Guessing either way would be a claim this
    // function cannot support.
    return 'indeterminate'
  }
}
