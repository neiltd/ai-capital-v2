import { writeFileSync, renameSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { dirname } from 'path';

// ── Atomic JSON write ──────────────────────────────────────────────────────
//
// Writes to a temp file in the same directory, then renames it into place.
// A rename on the same filesystem is atomic: a crash before the rename
// leaves the original file completely untouched, and a crash after the
// rename means the write fully succeeded. There is no window where the
// destination path holds a truncated/partial file.

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, path);
}

// ── Safe JSON read ──────────────────────────────────────────────────────────
//
// If the file doesn't exist yet, this is a legitimate "first run" case —
// return the caller-supplied default. If the file DOES exist but fails to
// parse, that means it was corrupted (e.g. truncated by a crash mid-write)
// — do NOT silently treat that as empty, since the next write would then
// overwrite the real file and permanently destroy all prior accumulated
// history. Throw instead so the problem surfaces immediately.

export function readJsonOr<T>(path: string, defaultVal: T): T {
  if (!existsSync(path)) return defaultVal;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    throw new Error(
      `Corrupt data file at ${path} — refusing to silently reset to empty (this would destroy accumulated history). Manual recovery required.`,
    );
  }
}
