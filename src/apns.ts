import { readFileSync } from 'node:fs';
import { connect, type ClientHttp2Session, type IncomingHttpHeaders } from 'node:http2';
import { createPrivateKey, createSign } from 'node:crypto';

import { config } from './config.js';
import { logDebug, logError, logInfo, previewToken } from './logger.js';
import type {
  ActivityPhase,
  ApnsSendResult,
  CourseActivityAttributesPayload,
  CourseActivityContentState
} from './types.js';

const APNS_ORIGIN = config.apnsUseSandbox
  ? 'https://api.sandbox.push.apple.com'
  : 'https://api.push.apple.com';
const APPLE_REFERENCE_DATE_UNIX_SECONDS = 978_307_200;
const ENDED_DISMISSAL_DELAY_SECONDS = 30;

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
    logDebug('Reusing cached APNs JWT.', { issuedAt: cachedJwt.issuedAt });
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
  logDebug('Generated new APNs JWT.', { issuedAt: now });
  return token;
}

function getPrivateKey(): ReturnType<typeof createPrivateKey> {
  if (!cachedPrivateKey) {
    cachedPrivateKey = createPrivateKey(readFileSync(config.apnsKeyPath, 'utf8'));
    logDebug('Loaded APNs private key into cache.');
  }

  return cachedPrivateKey;
}

function createApnsSession(): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    logDebug('Opening APNs HTTP/2 session.', { origin: APNS_ORIGIN });
    const session = connect(APNS_ORIGIN);
    const onError = (error: Error): void => {
      session.removeListener('connect', onConnect);
      logError('Failed to connect APNs HTTP/2 session before request dispatch.', error);
      reject(error);
    };
    const onConnect = (): void => {
      session.removeListener('error', onError);
      logDebug('APNs HTTP/2 session connected.', { origin: APNS_ORIGIN });
      resolve(session);
    };

    session.once('error', onError);
    session.once('connect', onConnect);
  });
}

function buildAlert(phase: ActivityPhase, courseName: string): { title: string; body: string } {
  if (phase === 'before') {
    return {
      title: '即將上課',
      body: `${courseName} 即將開始。`
    };
  }

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

function toAppleReferenceDateSeconds(unixSeconds: number): number {
  return unixSeconds - APPLE_REFERENCE_DATE_UNIX_SECONDS;
}

async function sendLiveActivityEvent(args: {
  pushToken: string;
  event: 'start' | 'update' | 'end';
  phase: ActivityPhase;
  courseName: string;
  classStartDate: number;
  classEndDate: number;
  dismissalDate?: number;
  attributes?: CourseActivityAttributesPayload;
  inputPushToken?: boolean;
  includeAlert?: boolean;
}): Promise<ApnsSendResult> {
  const session = await createApnsSession();
  const jwt = getJwt();
  const contentState: CourseActivityContentState = {
    phase: args.phase,
    classStartDate: toAppleReferenceDateSeconds(args.classStartDate),
    classEndDate: toAppleReferenceDateSeconds(args.classEndDate)
  };
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    event: args.event,
    'content-state': contentState
  };

  if (args.event === 'end') {
    aps['dismissal-date'] = args.dismissalDate ?? args.classEndDate + ENDED_DISMISSAL_DELAY_SECONDS;
  }

  if (args.event === 'start') {
    aps['attributes-type'] = 'CourseActivityAttributes';
    aps.attributes = args.attributes;
    if (args.inputPushToken) {
      aps['input-push-token'] = 1;
    }
  }

  if (args.includeAlert !== false) {
    aps.alert = buildAlert(args.phase, args.courseName);
  }

  const payload = JSON.stringify({
    aps
  });
  const requestSummary = {
    event: args.event,
    phase: args.phase,
    apnsTopic: config.apnsTopic,
    hasAlert: args.includeAlert !== false,
    payloadSizeBytes: Buffer.byteLength(payload),
    pushTokenPreview: previewToken(args.pushToken),
    contentState
  };

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

    logDebug('Sending APNs live activity request.', requestSummary);

    const request = session.request({
      ':method': 'POST',
      ':path': `/3/device/${args.pushToken}`,
      authorization: `bearer ${jwt}`,
      'apns-push-type': 'liveactivity',
      'apns-topic': config.apnsTopic,
      'apns-priority': '10',
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
      logDebug('Received APNs response headers.', {
        event: args.event,
        phase: args.phase,
        status: headers[':status'],
        apnsId: headers['apns-id']
      });
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
      const reason = parseApnsReason(body);

      logDebug('Completed APNs live activity request.', {
        event: args.event,
        phase: args.phase,
        status,
        apnsId,
        bodyLength: body.length,
        reason
      });

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
      logError('APNs request stream failed.', {
        event: args.event,
        phase: args.phase,
        pushTokenPreview: previewToken(args.pushToken),
        error
      });
      session.destroy();
      reject(error);
    });

    request.end(payload);
  });
}

export async function sendActivityStart(args: {
  pushToStartToken: string;
  courseName: string;
  courseId: string;
  location: string;
  instructor: string;
  classStartDate: number;
  classEndDate: number;
}): Promise<void> {
  const { pushToStartToken, ...activity } = args;
  const result = await sendLiveActivityEvent({
    pushToken: pushToStartToken,
    event: 'start',
    phase: 'before',
    courseName: activity.courseName,
    classStartDate: activity.classStartDate,
    classEndDate: activity.classEndDate,
    attributes: {
      courseName: activity.courseName,
      courseId: activity.courseId,
      location: activity.location,
      instructor: activity.instructor
    },
    inputPushToken: true
  });
  logInfo('Sent APNs live activity start event.', result);
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
  dismissalDate?: number;
}): Promise<void> {
  logDebug('Sending quiet ended-state update before final end event.', {
    pushTokenPreview: previewToken(args.pushToken),
    classStartDate: args.classStartDate,
    classEndDate: args.classEndDate
  });
  const updateResult = await sendLiveActivityEvent({
    ...args,
    event: 'update',
    phase: 'ended',
    includeAlert: false
  });
  logInfo('Sent APNs live activity ended update.', updateResult);

  logDebug('Sending final APNs end event.', {
    pushTokenPreview: previewToken(args.pushToken),
    classStartDate: args.classStartDate,
    classEndDate: args.classEndDate
  });
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
    topic: config.apnsTopic,
    logLevel: config.logLevel
  });
}

export function logApnsError(message: string, error: unknown): void {
  logError(message, error);
}

function parseApnsReason(body: string): string | undefined {
  if (!body) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}
