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
