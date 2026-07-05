type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const COLORS: Record<Level, string> = {
  INFO:  '\x1b[36m',   // cyan
  WARN:  '\x1b[33m',   // yellow
  ERROR: '\x1b[31m',   // red
  DEBUG: '\x1b[90m',   // gray
};
const RESET = '\x1b[0m';

const isTTY = process.stdout.isTTY ?? false;
const isDebug = process.env.DEBUG === 'true';

function color(level: Level, text: string): string {
  return isTTY ? `${COLORS[level]}${text}${RESET}` : text;
}

function ts(): string {
  return new Date().toISOString();
}

function formatData(data: unknown): string {
  if (data === undefined) return '';
  const str = JSON.stringify(data, null, 2);
  return '\n' + str.split('\n').map(l => '    ' + l).join('\n');
}

function emit(level: Level, source: string, message: string, data?: unknown): void {
  const line = `${ts()} ${color(level, `[${level}]`)} [${source}] ${message}${formatData(data)}`;
  if (level === 'ERROR') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  info:  (source: string, msg: string, data?: unknown) => emit('INFO',  source, msg, data),
  warn:  (source: string, msg: string, data?: unknown) => emit('WARN',  source, msg, data),
  error: (source: string, msg: string, data?: unknown) => emit('ERROR', source, msg, data),
  debug: (source: string, msg: string, data?: unknown) => { if (isDebug) emit('DEBUG', source, msg, data); },
};
