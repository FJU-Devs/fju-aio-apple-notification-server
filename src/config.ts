import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return 3000;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT must be a positive integer.');
  }

  return port;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function optionalIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export const config = {
  port: parsePort(process.env.PORT),
  apnsKeyId: requireEnv('APNS_KEY_ID'),
  apnsTeamId: requireEnv('APNS_TEAM_ID'),
  apnsKeyPath: requireEnv('APNS_KEY_PATH'),
  apnsTopic: requireEnv('APNS_TOPIC'),
  apnsUseSandbox: process.env.APNS_USE_SANDBOX === 'true',
  logLevel: process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  databasePath: process.env.DATABASE_PATH?.trim() || './data/apple-notification.sqlite',
  appAuthToken: optionalEnv('APP_AUTH_TOKEN'),
  schedulerPollMs: optionalIntegerEnv('SCHEDULER_POLL_MS', 250),
  schedulerBatchSize: optionalIntegerEnv('SCHEDULER_BATCH_SIZE', 25),
  schedulerLockSeconds: optionalIntegerEnv('SCHEDULER_LOCK_SECONDS', 60)
};
