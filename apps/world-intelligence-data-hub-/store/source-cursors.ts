import type { CursorState, SourceCursor } from '../lib/types.ts';
import { PATHS } from '../lib/paths.ts';
import { logger } from '../lib/logger.ts';
import { writeJsonAtomic, readJsonOr } from '../lib/atomic-fs.ts';

function load(): CursorState {
  return readJsonOr<CursorState>(PATHS.store.cursors, {});
}

function save(state: CursorState): void {
  writeJsonAtomic(PATHS.store.cursors, state);
}

export function getCursor(source: string): SourceCursor | undefined {
  return load()[source];
}

export function setCursor(source: string, cursor: SourceCursor): void {
  const state = load();
  state[source] = cursor;
  save(state);
  logger.debug('cursors', `Cursor updated for ${source}`, cursor);
}
