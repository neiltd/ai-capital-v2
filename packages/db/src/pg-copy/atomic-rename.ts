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
  /** The directory now lives at the destination. */
  | 'published'
  /** Something was already at the destination. It was NOT touched. */
  | 'destination-exists'
  /** No atomic no-replace primitive here. Nothing was attempted. */
  | 'unavailable'
  /** The syscall failed for some other reason. Nothing was published. */
  | 'failed'

/**
 * The helper, verbatim. Sent on stdin; never written to disk.
 *
 * It resolves the symbol, calls it once, and exits with a code. It prints
 * nothing on either stream, so no filesystem text can travel back through it.
 */
export const HELPER_SOURCE = `import ctypes, os, sys
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
export function atomicRenameNoReplace(from: string, to: string): AtomicRenameOutcome {
  if (process.platform !== 'darwin') return 'unavailable'
  try {
    execFileSync(PYTHON3, ['-', from, to], {
      input: HELPER_SOURCE,
      // Nothing comes back but the exit code: no stdout, no stderr, no path
      // echoed into an error this repository would then log.
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: HELPER_TIMEOUT_MS,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    })
    return 'published'
  } catch (e) {
    const status = (e as { status?: unknown }).status
    if (status === HELPER_DESTINATION_EXISTS) return 'destination-exists'
    if (status === HELPER_UNAVAILABLE) return 'unavailable'
    // A missing interpreter surfaces as a spawn error with no status at all.
    if (typeof status !== 'number') return 'unavailable'
    return 'failed'
  }
}
