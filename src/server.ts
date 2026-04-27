import express, { type NextFunction, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';

import { logApnsConfiguration } from './apns.js';
import { config } from './config.js';
import { logDebug, logError, logInfo, previewToken } from './logger.js';
import { openApiDocument } from './openapi.js';
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
  const currentPhase: ActivityPhase = now < payload.classStartDate ? 'before' : now < payload.classEndDate ? 'during' : 'ended';
  const activity = {
    ...payload,
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
    pushTokenPreview: previewToken(payload.pushToken)
  });

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

function getReceivedKeys(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return [];
  }

  return Object.keys(value).sort();
}
