import express, { type NextFunction, type Request, type Response } from 'express';

import { logApnsConfiguration } from './apns.js';
import { config } from './config.js';
import { logError, logInfo } from './logger.js';
import { ActivityScheduler } from './scheduler.js';
import { ActivityStore } from './store.js';
import type { ActivityPhase, RegisterActivityPayload } from './types.js';

const EXPECTED_KEYS = [
  'activityId',
  'pushToken',
  'courseName',
  'courseId',
  'classStartDate',
  'classEndDate'
] as const;
const MAX_TIMEOUT_MS = 2_147_483_647;

const app = express();
const store = new ActivityStore();
const scheduler = new ActivityScheduler(store);

app.use(express.json());

app.get('/activities', (_request: Request, response: Response) => {
  response.json({ activities: store.list() });
});

app.post('/activity/register', (request: Request, response: Response) => {
  const parsed = validateRegisterPayload(request.body);
  if (!parsed.valid) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = parsed.payload;
  const current = store.get(payload.activityId);
  const currentPhase: ActivityPhase = now < payload.classStartDate ? 'before' : now < payload.classEndDate ? 'during' : 'ended';
  const activity = {
    ...payload,
    currentPhase,
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  };

  store.upsert(activity);
  scheduler.schedule(activity);
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

app.delete('/activity/:activityId', (request: Request, response: Response) => {
  const { activityId } = request.params;
  const existing = store.get(activityId);
  if (!existing) {
    response.status(404).json({ error: 'Activity not found.' });
    return;
  }

  scheduler.clear(activityId);
  store.delete(activityId);
  logInfo('Deleted live activity registration.', { activityId });
  response.status(204).send();
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  logError('Unhandled request error.', error);
  response.status(500).json({ error: 'Internal server error.' });
});

app.listen(config.port, () => {
  logApnsConfiguration();
  logInfo(`Server listening on port ${config.port}.`);
});

function validateRegisterPayload(value: unknown):
  | { valid: true; payload: RegisterActivityPayload }
  | { valid: false; error: string } {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const keys = Object.keys(value).sort();
  const expectedKeys = [...EXPECTED_KEYS].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) {
    return {
      valid: false,
      error: `Request body must contain exactly these fields: ${EXPECTED_KEYS.join(', ')}`
    };
  }

  const { activityId, pushToken, courseName, courseId, classStartDate, classEndDate } = value;

  if (!isNonEmptyString(activityId)) {
    return { valid: false, error: 'activityId must be a non-empty string.' };
  }
  if (!isNonEmptyString(pushToken)) {
    return { valid: false, error: 'pushToken must be a non-empty string.' };
  }
  if (!isNonEmptyString(courseName)) {
    return { valid: false, error: 'courseName must be a non-empty string.' };
  }
  if (!isNonEmptyString(courseId)) {
    return { valid: false, error: 'courseId must be a non-empty string.' };
  }
  if (!isUnixTimestamp(classStartDate)) {
    return { valid: false, error: 'classStartDate must be a Unix timestamp in seconds.' };
  }
  if (!isUnixTimestamp(classEndDate)) {
    return { valid: false, error: 'classEndDate must be a Unix timestamp in seconds.' };
  }
  if (classEndDate <= classStartDate) {
    return { valid: false, error: 'classEndDate must be greater than classStartDate.' };
  }

  const now = Math.floor(Date.now() / 1000);
  const furthestScheduledDate = Math.max(classStartDate, classEndDate);
  if ((furthestScheduledDate - now) * 1000 > MAX_TIMEOUT_MS) {
    return {
      valid: false,
      error: 'classStartDate and classEndDate must be within 24.8 days of the current server time.'
    };
  }

  if (!isHexPushToken(pushToken)) {
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
