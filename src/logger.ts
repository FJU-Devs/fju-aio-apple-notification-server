type LogLevel = 'debug' | 'info';

const currentLogLevel: LogLevel = process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info';

export function logDebug(message: string, details?: unknown): void {
  if (currentLogLevel !== 'debug') {
    return;
  }

  if (details === undefined) {
    console.debug(`[DEBUG] ${message}`);
    return;
  }

  console.debug(`[DEBUG] ${message}`, details);
}

export function logInfo(message: string, details?: unknown): void {
  if (details === undefined) {
    console.log(`[INFO] ${message}`);
    return;
  }

  console.log(`[INFO] ${message}`, details);
}

export function logError(message: string, details?: unknown): void {
  if (details === undefined) {
    console.error(`[ERROR] ${message}`);
    return;
  }

  console.error(`[ERROR] ${message}`, details);
}

export function previewToken(token: string): string {
  if (token.length <= 10) {
    return 'redacted';
  }

  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}
