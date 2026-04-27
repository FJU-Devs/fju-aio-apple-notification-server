import { readFileSync } from 'node:fs';
import { connect, type ClientHttp2Session, type IncomingHttpHeaders } from 'node:http2';
import { createPrivateKey, createSign } from 'node:crypto';

import { config } from './config.js';
import { logError, logInfo } from './logger.js';
import type { ActivityPhase, ApnsSendResult, CourseActivityContentState } from './types.js';

const APNS_ORIGIN = config.apnsUseSandbox
  ? 'https://api.sandbox.push.apple.com'
  : 'https://api.push.apple.com';

let cachedJwt: { token: string; issuedAt: number } | undefined;
let cachedPrivateKey: ReturnType<typeof createPrivateKey> | undefined;

function base64UrlEncode(value: string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.issuedAt < 50 * 60) {
    return cachedJwt.token;
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', kid: config.apnsKeyId }));
  const claims = base64UrlEncode(JSON.stringify({ iss: config.apnsTeamId, iat: now }));
  const unsignedToken = `${header}.${claims}`;
  const signer = createSign('sha256');
  signer.update(unsignedToken);
  signer.end();
  const signature = signer
    .sign(getPrivateKey())
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  const token = `${unsignedToken}.${signature}`;
  cachedJwt = { token, issuedAt: now };
  return token;
}

function getPrivateKey(): ReturnType<typeof createPrivateKey> {
  if (!cachedPrivateKey) {
    cachedPrivateKey = createPrivateKey(readFileSync(config.apnsKeyPath, 'utf8'));
  }

  return cachedPrivateKey;
}

function createApnsSession(): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = connect(APNS_ORIGIN);
    const onError = (error: Error): void => {
      session.removeListener('connect', onConnect);
      reject(error);
    };
    const onConnect = (): void => {
      session.removeListener('error', onError);
      resolve(session);
    };

    session.once('error', onError);
    session.once('connect', onConnect);
  });
}

function buildAlert(phase: ActivityPhase, courseName: string): { title: string; body: string } {
  if (phase === 'during') {
    return {
      title: '上課中',
      body: `${courseName} 已開始上課。`
    };
  }

  return {
    title: '下課了',
    body: `${courseName} 已結束。`
  };
}

async function sendLiveActivityEvent(args: {
  pushToken: string;
  event: 'update' | 'end';
  phase: ActivityPhase;
  courseName: string;
  classStartDate: number;
  classEndDate: number;
  includeAlert?: boolean;
}): Promise<ApnsSendResult> {
  const session = await createApnsSession();
  const jwt = getJwt();
  const contentState: CourseActivityContentState = {
    phase: args.phase,
    classStartDate: args.classStartDate,
    classEndDate: args.classEndDate
  };
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    event: args.event,
    'content-state': contentState
  };

  if (args.includeAlert !== false) {
    aps.alert = buildAlert(args.phase, args.courseName);
  }

  const payload = JSON.stringify({
    aps
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const handleSessionError = (error: Error): void => {
      if (settled) {
        logError('APNs session error after request completion.', error);
        return;
      }

      settled = true;
      session.destroy();
      reject(error);
    };

    session.on('error', handleSessionError);

    const request = session.request({
      ':method': 'POST',
      ':path': `/3/device/${args.pushToken}`,
      authorization: `bearer ${jwt}`,
      'apns-push-type': 'liveactivity',
      'apns-topic': config.apnsTopic,
      'content-type': 'application/json'
    });

    const chunks: Buffer[] = [];
    let responseHeaders: IncomingHttpHeaders = {};

    const cleanup = (): void => {
      session.off('error', handleSessionError);
    };

    request.setEncoding('utf8');
    request.on('response', (headers) => {
      responseHeaders = headers;
    });
    request.on('data', (chunk: string) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      if (settled) {
        cleanup();
        return;
      }

      settled = true;
      cleanup();
      session.close();
      const statusHeader = responseHeaders[':status'];
      const status = typeof statusHeader === 'number' ? statusHeader : Number(statusHeader ?? 0);
      const body = Buffer.concat(chunks).toString('utf8');
      const apnsIdHeader = responseHeaders['apns-id'];
      const apnsId = typeof apnsIdHeader === 'string' ? apnsIdHeader : undefined;
      const result = { status, body, apnsId };

      if (status >= 200 && status < 300) {
        resolve(result);
        return;
      }

      reject(new Error(`APNs request failed with status ${status}: ${body || 'no response body'}`));
    });
    request.on('error', (error) => {
      if (settled) {
        cleanup();
        return;
      }

      settled = true;
      cleanup();
      session.destroy();
      reject(error);
    });

    request.end(payload);
  });
}

export async function sendActivityUpdate(args: {
  pushToken: string;
  courseName: string;
  classStartDate: number;
  classEndDate: number;
}): Promise<void> {
  const result = await sendLiveActivityEvent({
    ...args,
    event: 'update',
    phase: 'during'
  });
  logInfo('Sent APNs live activity update.', result);
}

export async function sendActivityEnded(args: {
  pushToken: string;
  courseName: string;
  classStartDate: number;
  classEndDate: number;
}): Promise<void> {
  const updateResult = await sendLiveActivityEvent({
    ...args,
    event: 'update',
    phase: 'ended',
    includeAlert: false
  });
  logInfo('Sent APNs live activity ended update.', updateResult);

  const endResult = await sendLiveActivityEvent({
    ...args,
    event: 'end',
    phase: 'ended'
  });
  logInfo('Sent APNs live activity end event.', endResult);
}

export function logApnsConfiguration(): void {
  logInfo('APNs client ready.', {
    environment: config.apnsUseSandbox ? 'sandbox' : 'production',
    topic: config.apnsTopic
  });
}

export function logApnsError(message: string, error: unknown): void {
  logError(message, error);
}
