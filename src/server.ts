import express, { type NextFunction, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';

import { logApnsConfiguration, sendActivityStart } from './apns.js';
import { config } from './config.js';
import { logDebug, logError, logInfo, previewToken } from './logger.js';
import { openApiDocument } from './openapi.js';
import { ActivityScheduler } from './scheduler.js';
import { ActivityStore } from './store.js';
import type {
  ActivityPhase,
  PushToStartRegistrationPayload,
  RegisterActivityPayload,
  RemoteStartPayload
} from './types.js';

const EXPECTED_KEYS = [
  'activityId',
  'pushToken',
  'courseName',
  'courseId',
  'classStartDate',
  'classEndDate'
] as const;
const PUSH_TO_START_REGISTER_KEYS = ['pushToStartToken', 'clientUnixTime'] as const;
const REMOTE_START_KEYS = ['courseName', 'courseId', 'location', 'instructor'] as const;
const MAX_TIMEOUT_MS = 2_147_483_647;
const FULL_CYCLE_HIDDEN_SECONDS = 30;
const FULL_CYCLE_BEFORE_SECONDS = 30;
const FULL_CYCLE_DURING_SECONDS = 30;

const app = express();
const store = new ActivityStore();
const scheduler = new ActivityScheduler(store);
let latestPushToStartRegistration: PushToStartRegistration | undefined;
const smoothRemoteStarts = new Map<string, SmoothRemoteStartSchedule>();
const remoteStartQueue = new Map<string, RemoteStartJob>();
const remoteStartTicker = setInterval(processRemoteStartQueue, 250);
remoteStartTicker.unref?.();

interface RemoteStartJob {
  id: string;
  serverPushAt: number;
  pushToStartToken: string;
  payload: RemoteStartPayload;
  serverClassStartDate: number;
  serverClassEndDate: number;
  clientClassStartDate: number;
  clientClassEndDate: number;
}

interface PushToStartRegistration {
  token: string;
  serverMinusClientSeconds: number;
  registeredAt: number;
}

interface SmoothRemoteStartSchedule {
  serverClassStartDate: number;
  serverClassEndDate: number;
}

app.use(express.json());

app.get('/docs/openapi.json', (_request: Request, response: Response) => {
  response.json(openApiDocument);
});

app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument, {
    customSiteTitle: 'Apple Server API Docs'
  })
);

app.get('/activities', (_request: Request, response: Response) => {
  const activities = store.list();
  logDebug('Listed activities.', { count: activities.length });
  response.json({ activities });
});

app.post('/activity/register', (request: Request, response: Response) => {
  logDebug('Received register request.', {
    hasBody: request.body != null,
    receivedKeys: getReceivedKeys(request.body)
  });

  const parsed = validateRegisterPayload(request.body);
  if (!parsed.valid) {
    logDebug('Rejected register request during validation.', {
      error: parsed.error,
      receivedKeys: getReceivedKeys(request.body)
    });
    response.status(400).json({ error: parsed.error });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = parsed.payload;
  const current = store.get(payload.activityId);
  const smoothSchedule = consumeSmoothRemoteStart(payload.courseId, payload.classStartDate, payload.classEndDate);
  const schedulePayload = smoothSchedule
    ? {
        ...payload,
        classStartDate: smoothSchedule.serverClassStartDate,
        classEndDate: smoothSchedule.serverClassEndDate
      }
    : payload;
  const currentPhase: ActivityPhase = now < schedulePayload.classStartDate ? 'before' : now < schedulePayload.classEndDate ? 'during' : 'ended';
  const activity = {
    ...schedulePayload,
    currentPhase,
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  };

  logDebug('Accepted register request.', {
    activityId: payload.activityId,
    courseId: payload.courseId,
    currentPhase,
    isReplace: Boolean(current),
    classStartDate: payload.classStartDate,
    classEndDate: payload.classEndDate,
    scheduleClassStartDate: schedulePayload.classStartDate,
    scheduleClassEndDate: schedulePayload.classEndDate,
    isSmoothRemoteStart: Boolean(smoothSchedule),
    pushTokenPreview: previewToken(payload.pushToken)
  });

  store.upsert(activity);
  scheduler.schedule(activity, {
    sendStartTransition: !smoothSchedule
  });
  logInfo('Registered live activity.', {
    activityId: activity.activityId,
    courseId: activity.courseId,
    courseName: activity.courseName,
    classStartDate: activity.classStartDate,
    classEndDate: activity.classEndDate
  });

  response.status(201).json({
    activityId: activity.activityId,
    currentPhase: activity.currentPhase,
    classStartDate: activity.classStartDate,
    classEndDate: activity.classEndDate
  });
});

app.post('/push-to-start/register', (request: Request, response: Response) => {
  const parsed = validatePushToStartRegistrationPayload(request.body);
  if (!parsed.valid) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const serverNow = Math.floor(Date.now() / 1000);
  latestPushToStartRegistration = {
    token: parsed.payload.pushToStartToken,
    serverMinusClientSeconds: serverNow - parsed.payload.clientUnixTime,
    registeredAt: serverNow
  };
  logInfo('Registered push-to-start token.', {
    pushToStartTokenPreview: previewToken(parsed.payload.pushToStartToken),
    clientUnixTime: parsed.payload.clientUnixTime,
    serverUnixTime: serverNow,
    serverMinusClientSeconds: latestPushToStartRegistration.serverMinusClientSeconds
  });
  response.status(201).json({
    pushToStartTokenPreview: previewToken(parsed.payload.pushToStartToken),
    serverUnixTime: serverNow,
    serverMinusClientSeconds: latestPushToStartRegistration.serverMinusClientSeconds
  });
});

app.post('/push-to-start/full-cycle', (request: Request, response: Response) => {
  const parsed = validateRemoteStartPayload(request.body);
  if (!parsed.valid) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  if (!latestPushToStartRegistration) {
    response.status(409).json({ error: 'No push-to-start token has been registered yet.' });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const serverPushAt = now + FULL_CYCLE_HIDDEN_SECONDS;
  const serverClassStartDate = serverPushAt + FULL_CYCLE_BEFORE_SECONDS;
  const serverClassEndDate = serverClassStartDate + FULL_CYCLE_DURING_SECONDS;
  const clientClassStartDate = serverClassStartDate - latestPushToStartRegistration.serverMinusClientSeconds;
  const clientClassEndDate = serverClassEndDate - latestPushToStartRegistration.serverMinusClientSeconds;
  const pushToStartToken = latestPushToStartRegistration.token;
  const jobId = smoothRemoteStartKey(parsed.payload.courseId, clientClassStartDate, clientClassEndDate);
  smoothRemoteStarts.set(jobId, {
    serverClassStartDate,
    serverClassEndDate
  });

  remoteStartQueue.set(jobId, {
    id: jobId,
    serverPushAt,
    pushToStartToken,
    payload: parsed.payload,
    serverClassStartDate,
    serverClassEndDate,
    clientClassStartDate,
    clientClassEndDate
  });

  logInfo('Scheduled push-to-start full-cycle test.', {
    courseId: parsed.payload.courseId,
    courseName: parsed.payload.courseName,
    serverPushAt,
    serverClassStartDate,
    serverClassEndDate,
    clientClassStartDate,
    clientClassEndDate,
    serverMinusClientSeconds: latestPushToStartRegistration.serverMinusClientSeconds
  });

  response.status(202).json({
    serverPushAt,
    serverClassStartDate,
    serverClassEndDate,
    clientClassStartDate,
    clientClassEndDate,
    serverMinusClientSeconds: latestPushToStartRegistration.serverMinusClientSeconds
  });
});

app.delete('/activity/:activityId', (request: Request, response: Response) => {
  const { activityId } = request.params;
  const existing = store.get(activityId);
  if (!existing) {
    logDebug('Delete requested for unknown activity.', { activityId });
    response.status(404).json({ error: 'Activity not found.' });
    return;
  }

  scheduler.clear(activityId);
  store.delete(activityId);
  logInfo('Deleted live activity registration.', { activityId, previousPhase: existing.currentPhase });
  response.status(204).send();
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  logError('Unhandled request error.', error);
  response.status(500).json({ error: 'Internal server error.' });
});

app.listen(config.port, () => {
  logApnsConfiguration();
  logInfo(`Server listening on port ${config.port}.`, { logLevel: config.logLevel });
});

function validateRegisterPayload(value: unknown):
  | { valid: true; payload: RegisterActivityPayload }
  | { valid: false; error: string } {
  if (!isPlainObject(value)) {
    logDebug('Register payload rejected: body is not a plain object.');
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const keys = Object.keys(value).sort();
  const expectedKeys = [...EXPECTED_KEYS].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) {
    logDebug('Register payload rejected: unexpected field set.', {
      receivedKeys: keys,
      expectedKeys
    });
    return {
      valid: false,
      error: `Request body must contain exactly these fields: ${EXPECTED_KEYS.join(', ')}`
    };
  }

  const { activityId, pushToken, courseName, courseId, classStartDate, classEndDate } = value;

  if (!isNonEmptyString(activityId)) {
    logDebug('Register payload rejected: invalid activityId.', { receivedKeys: keys });
    return { valid: false, error: 'activityId must be a non-empty string.' };
  }
  if (!isNonEmptyString(pushToken)) {
    logDebug('Register payload rejected: invalid pushToken presence.', {
      activityId,
      pushTokenLength: typeof pushToken === 'string' ? pushToken.length : undefined
    });
    return { valid: false, error: 'pushToken must be a non-empty string.' };
  }
  if (!isNonEmptyString(courseName)) {
    logDebug('Register payload rejected: invalid courseName.', { activityId });
    return { valid: false, error: 'courseName must be a non-empty string.' };
  }
  if (!isNonEmptyString(courseId)) {
    logDebug('Register payload rejected: invalid courseId.', { activityId });
    return { valid: false, error: 'courseId must be a non-empty string.' };
  }
  if (!isUnixTimestamp(classStartDate)) {
    logDebug('Register payload rejected: invalid classStartDate.', { activityId, classStartDate });
    return { valid: false, error: 'classStartDate must be a Unix timestamp in seconds.' };
  }
  if (!isUnixTimestamp(classEndDate)) {
    logDebug('Register payload rejected: invalid classEndDate.', { activityId, classEndDate });
    return { valid: false, error: 'classEndDate must be a Unix timestamp in seconds.' };
  }
  if (classEndDate <= classStartDate) {
    logDebug('Register payload rejected: end date must be after start date.', {
      activityId,
      classStartDate,
      classEndDate
    });
    return { valid: false, error: 'classEndDate must be greater than classStartDate.' };
  }

  const now = Math.floor(Date.now() / 1000);
  const furthestScheduledDate = Math.max(classStartDate, classEndDate);
  if ((furthestScheduledDate - now) * 1000 > MAX_TIMEOUT_MS) {
    logDebug('Register payload rejected: schedule window is too far in the future.', {
      activityId,
      classStartDate,
      classEndDate,
      now
    });
    return {
      valid: false,
      error: 'classStartDate and classEndDate must be within 24.8 days of the current server time.'
    };
  }

  if (!isHexPushToken(pushToken)) {
    logDebug('Register payload rejected: invalid push token format.', {
      activityId,
      pushTokenLength: pushToken.length
    });
    return { valid: false, error: 'pushToken must be a hex-encoded string.' };
  }

  return {
    valid: true,
    payload: {
      activityId,
      pushToken,
      courseName,
      courseId,
      classStartDate,
      classEndDate
    }
  };
}

function validatePushToStartRegistrationPayload(value: unknown):
  | { valid: true; payload: PushToStartRegistrationPayload }
  | { valid: false; error: string } {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const keys = Object.keys(value).sort();
  const expectedKeys = [...PUSH_TO_START_REGISTER_KEYS].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) {
    return {
      valid: false,
      error: `Request body must contain exactly these fields: ${PUSH_TO_START_REGISTER_KEYS.join(', ')}`
    };
  }

  const { pushToStartToken, clientUnixTime } = value;
  if (!isNonEmptyString(pushToStartToken)) {
    return { valid: false, error: 'pushToStartToken must be a non-empty string.' };
  }
  if (!isHexPushToken(pushToStartToken)) {
    return { valid: false, error: 'pushToStartToken must be a hex-encoded string.' };
  }
  if (!isUnixTimestamp(clientUnixTime)) {
    return { valid: false, error: 'clientUnixTime must be a Unix timestamp in seconds.' };
  }

  return {
    valid: true,
    payload: { pushToStartToken, clientUnixTime }
  };
}

function validateRemoteStartPayload(value: unknown):
  | { valid: true; payload: RemoteStartPayload }
  | { valid: false; error: string } {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const keys = Object.keys(value).sort();
  const expectedKeys = [...REMOTE_START_KEYS].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) {
    return {
      valid: false,
      error: `Request body must contain exactly these fields: ${REMOTE_START_KEYS.join(', ')}`
    };
  }

  const { courseName, courseId, location, instructor } = value;
  if (!isNonEmptyString(courseName)) {
    return { valid: false, error: 'courseName must be a non-empty string.' };
  }
  if (!isNonEmptyString(courseId)) {
    return { valid: false, error: 'courseId must be a non-empty string.' };
  }
  if (typeof location !== 'string') {
    return { valid: false, error: 'location must be a string.' };
  }
  if (typeof instructor !== 'string') {
    return { valid: false, error: 'instructor must be a string.' };
  }

  return {
    valid: true,
    payload: {
      courseName,
      courseId,
      location,
      instructor
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUnixTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isHexPushToken(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

function smoothRemoteStartKey(courseId: string, classStartDate: number, classEndDate: number): string {
  return `${courseId}:${classStartDate}:${classEndDate}`;
}

function consumeSmoothRemoteStart(
  courseId: string,
  classStartDate: number,
  classEndDate: number
): SmoothRemoteStartSchedule | undefined {
  const key = smoothRemoteStartKey(courseId, classStartDate, classEndDate);
  const schedule = smoothRemoteStarts.get(key);
  if (!schedule) {
    return undefined;
  }

  smoothRemoteStarts.delete(key);
  return schedule;
}

function processRemoteStartQueue(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const job of remoteStartQueue.values()) {
    if (job.serverPushAt > now) {
      continue;
    }

    remoteStartQueue.delete(job.id);
    void sendActivityStart({
      pushToStartToken: job.pushToStartToken,
      courseName: job.payload.courseName,
      courseId: job.payload.courseId,
      location: job.payload.location,
      instructor: job.payload.instructor,
      classStartDate: job.clientClassStartDate,
      classEndDate: job.clientClassEndDate
    }).catch((error: unknown) => {
      logError('Failed to send push-to-start full-cycle start event.', error);
    });
  }
}

function getReceivedKeys(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return [];
  }

  return Object.keys(value).sort();
}
