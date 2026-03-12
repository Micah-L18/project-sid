/**
 * Simple structured logger with context prefix and level filtering.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let globalLevel: LogLevel = 'info';

export function setGlobalLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  debug(msg: string, ...args: unknown[]): void {
    this.log('debug', msg, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    this.log('info', msg, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.log('warn', msg, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.log('error', msg, ...args);
  }

  private log(level: LogLevel, msg: string, ...args: unknown[]): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[globalLevel]) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${this.context}]`;

    switch (level) {
      case 'debug': console.debug(prefix, msg, ...args); break;
      case 'info':  console.info(prefix, msg, ...args);  break;
      case 'warn':  console.warn(prefix, msg, ...args);  break;
      case 'error': console.error(prefix, msg, ...args); break;
    }
  }
}
