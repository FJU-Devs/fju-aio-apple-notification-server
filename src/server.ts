import express, { type NextFunction, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';

import { logApnsConfiguration } from './apns.js';
import { config } from './config.js';
import { logDebug, logError, logInfo, previewToken } from './logger.js';
import { openApiDocument } from './openapi.js';
import { ActivityScheduler, buildPushStartJobPayload } from './scheduler.js';
import {
  ActivityStore,
  pushStartJobKey,
  remoteStartContextKey
} from './store.js';
import type {
  ActivityPhase,
  PushToStartSchedulePayload,
  PushToStartRegistrationPayload,
  PushToStartSemesterSyncPayload,
  RegisterActivityPayload,
  RemoteStartPayload,
  RemoteStartSchedulePayload
} from './types.js';

const EXPECTED_KEYS = [
  'userId',
  'deviceId',
  'activityId',
  'pushToken',
  'courseName',
  'courseId',
  'classStartDate',
  'classEndDate'
] as const;
const PUSH_TO_START_REGISTER_KEYS = ['userId', 'deviceId', 'pushToStartToken', 'clientUnixTime'] as const;
const CANCEL_DEVICE_KEYS = ['userId', 'deviceId', 'deactivateToken'] as const;
const REMOTE_START_KEYS = ['userId', 'deviceId', 'courseName', 'courseId', 'location', 'instructor'] as const;
const PUSH_TO_START_SCHEDULE_KEYS = ['schedules'] as const;
const PUSH_TO_START_SEMESTER_SYNC_KEYS = ['userId', 'deviceId', 'semester', 'semesterEndDate', 'schedules'] as const;
const REMOTE_START_SCHEDULE_KEYS = [
  'userId',
  'deviceId',
  'semester',
  'courseName',
  'courseId',
  'location',
  'instructor',
  'pushAt',
  'classStartDate',
  'classEndDate',
  'initialPhase',
  'endAt',
  'dismissalDate'
] as const;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_SEMESTER_SYNC_SECONDS = 220 * 24 * 60 * 60;
const FULL_CYCLE_HIDDEN_SECONDS = 30;
const FULL_CYCLE_BEFORE_SECONDS = 30;
const FULL_CYCLE_DURING_SECONDS = 30;

const app = express();
const store = new ActivityStore();
const scheduler = new ActivityScheduler(store);

type SchedulableRegisterPayload = RegisterActivityPayload & {
  displayClassStartDate?: number;
  displayClassEndDate?: number;
  endTransitionDate?: number;
  dismissalDate?: number;
};

type IdentifiedRemoteStartPayload = RemoteStartPayload & {
  userId: string;
  deviceId: string;
};

app.use(express.json());
app.use(requireAppAuth);

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
  const smoothSchedule = store.consumeRemoteStartContext(
    payload.userId,
    payload.deviceId,
    payload.courseId,
    payload.classStartDate,
    payload.classEndDate
  );
  const schedulePayload: SchedulableRegisterPayload = smoothSchedule
    ? {
        ...payload,
        classStartDate: smoothSchedule.serverClassStartDate,
        classEndDate: smoothSchedule.serverClassEndDate,
        displayClassStartDate: payload.classStartDate,
        displayClassEndDate: payload.classEndDate,
        endTransitionDate: smoothSchedule.serverEndTransitionDate,
        dismissalDate: smoothSchedule.serverDismissalDate
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
    userId: payload.userId,
    deviceId: payload.deviceId,
    activityId: payload.activityId,
    courseId: payload.courseId,
    currentPhase,
    isReplace: Boolean(current),
    classStartDate: payload.classStartDate,
    classEndDate: payload.classEndDate,
    scheduleClassStartDate: schedulePayload.classStartDate,
    scheduleClassEndDate: schedulePayload.classEndDate,
    endTransitionDate: schedulePayload.endTransitionDate,
    dismissalDate: schedulePayload.dismissalDate,
    isSmoothRemoteStart: Boolean(smoothSchedule),
    pushTokenPreview: previewToken(payload.pushToken)
  });

  store.upsert(activity);
  scheduler.schedule(activity, {
    sendStartTransition: smoothSchedule?.sendStartTransition ?? true
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
  const registration = store.upsertPushToStartToken({
    userId: parsed.payload.userId,
    deviceId: parsed.payload.deviceId,
    token: parsed.payload.pushToStartToken,
    serverMinusClientSeconds: serverNow - parsed.payload.clientUnixTime,
    registeredAt: serverNow
  });
  logInfo('Registered push-to-start token.', {
    userId: registration.userId,
    deviceId: registration.deviceId,
    pushToStartTokenPreview: previewToken(parsed.payload.pushToStartToken),
    clientUnixTime: parsed.payload.clientUnixTime,
    serverUnixTime: serverNow,
    serverMinusClientSeconds: registration.serverMinusClientSeconds
  });
  response.status(201).json({
    pushToStartTokenPreview: previewToken(parsed.payload.pushToStartToken),
    serverUnixTime: serverNow,
    serverMinusClientSeconds: registration.serverMinusClientSeconds
  });
});

app.post('/push-to-start/full-cycle', (request: Request, response: Response) => {
  const parsed = validateRemoteStartPayload(request.body);
  if (!parsed.valid) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  const registration = store.getPushToStartToken(parsed.payload.userId, parsed.payload.deviceId);
  if (!registration) {
    response.status(409).json({ error: 'No push-to-start token has been registered for this user/device yet.' });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const serverPushAt = now + FULL_CYCLE_HIDDEN_SECONDS;
  const serverClassStartDate = serverPushAt + FULL_CYCLE_BEFORE_SECONDS;
  const serverClassEndDate = serverClassStartDate + FULL_CYCLE_DURING_SECONDS;
  const clientClassStartDate = serverClassStartDate - registration.serverMinusClientSeconds;
  const clientClassEndDate = serverClassEndDate - registration.serverMinusClientSeconds;
  const jobId = pushStartJobKey(parsed.payload.userId, parsed.payload.deviceId, parsed.payload.courseId, clientClassStartDate);
  const contextKey = remoteStartContextKey(
    parsed.payload.userId,
    parsed.payload.deviceId,
    parsed.payload.courseId,
    clientClassStartDate,
    clientClassEndDate
  );

  store.upsertRemoteStartContext({
    key: contextKey,
    userId: parsed.payload.userId,
    deviceId: parsed.payload.deviceId,
    courseId: parsed.payload.courseId,
    clientClassStartDate,
    clientClassEndDate,
    serverClassStartDate,
    serverClassEndDate,
    serverDismissalDate: serverClassEndDate + 30,
    sendStartTransition: true,
    createdAt: now
  });

  store.upsertScheduledJob({
    id: jobId,
    kind: 'push_start',
    userId: parsed.payload.userId,
    deviceId: parsed.payload.deviceId,
    dueAt: serverPushAt,
    payload: buildPushStartJobPayload({
      ...parsed.payload,
      initialPhase: 'before',
      clientClassStartDate,
      clientClassEndDate
    })
  });

  logInfo('Scheduled push-to-start full-cycle test.', {
    userId: parsed.payload.userId,
    deviceId: parsed.payload.deviceId,
    courseId: parsed.payload.courseId,
    courseName: parsed.payload.courseName,
    serverPushAt,
    serverClassStartDate,
    serverClassEndDate,
    clientClassStartDate,
    clientClassEndDate,
    serverMinusClientSeconds: registration.serverMinusClientSeconds
  });

  response.status(202).json({
    serverPushAt,
    serverClassStartDate,
    serverClassEndDate,
    clientClassStartDate,
    clientClassEndDate,
    serverMinusClientSeconds: registration.serverMinusClientSeconds
  });
});

app.post('/push-to-start/schedule', (request: Request, response: Response) => {
  const parsed = validatePushToStartSchedulePayload(request.body);
  if (!parsed.valid) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const scheduled = parsed.payload.schedules.map((schedule) => upsertPushStartSchedule(schedule));

  logInfo('Scheduled push-to-start course workflow.', {
    count: scheduled.length
  });

  response.status(202).json({
    schedules: scheduled
  });
});

app.post('/push-to-start/sync-semester', (request: Request, response: Response) => {
  const parsed = validatePushToStartSemesterSyncPayload(request.body);
  if (!parsed.valid) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const scheduled = parsed.payload.schedules.map((schedule) => upsertPushStartSchedule({
    ...schedule,
    semester: parsed.payload.semester
  }));
  const activeJobIds = scheduled.map((schedule) => schedule.jobId);
  const cancelledJobs = store.cancelStalePushStartJobsForSemester(
    parsed.payload.userId,
    parsed.payload.deviceId,
    parsed.payload.semester,
    activeJobIds
  );

  logInfo('Synced semester push-to-start workflow.', {
    userId: parsed.payload.userId,
    deviceId: parsed.payload.deviceId,
    semester: parsed.payload.semester,
    semesterEndDate: parsed.payload.semesterEndDate,
    scheduledJobs: scheduled.length,
    cancelledJobs
  });

  response.status(202).json({
    semester: parsed.payload.semester,
    semesterEndDate: parsed.payload.semesterEndDate,
    scheduledJobs: scheduled.length,
    cancelledJobs
  });
});

app.post('/push-to-start/cancel', (request: Request, response: Response) => {
  const parsed = validateCancelDevicePayload(request.body);
  if (!parsed.valid) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const cancelledJobs = store.cancelFutureJobsForDevice(parsed.payload.userId, parsed.payload.deviceId);
  if (parsed.payload.deactivateToken) {
    store.deactivatePushToStartToken(parsed.payload.userId, parsed.payload.deviceId);
  }

  logInfo('Cancelled future push-to-start jobs for device.', {
    userId: parsed.payload.userId,
    deviceId: parsed.payload.deviceId,
    cancelledJobs,
    deactivatedToken: parsed.payload.deactivateToken
  });
  response.status(200).json({ cancelledJobs });
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

function upsertPushStartSchedule(schedule: RemoteStartSchedulePayload): {
  jobId: string;
  userId: string;
  deviceId: string;
  courseId: string;
  courseName: string;
  initialPhase: ActivityPhase;
  serverPushAt: number;
  serverClassStartDate: number;
  serverClassEndDate: number;
  serverEndTransitionDate?: number;
  serverDismissalDate?: number;
  clientPushAt: number;
  clientClassStartDate: number;
  clientClassEndDate: number;
  clientEndAt?: number;
  clientDismissalDate?: number;
  serverMinusClientSeconds: number;
  hasPushToStartToken: boolean;
} {
  const registration = store.getPushToStartToken(schedule.userId, schedule.deviceId);
  const serverMinusClientSeconds = registration?.serverMinusClientSeconds ?? 0;
  const serverPushAt = schedule.pushAt + serverMinusClientSeconds;
  const serverClassStartDate = schedule.classStartDate + serverMinusClientSeconds;
  const serverClassEndDate = schedule.classEndDate + serverMinusClientSeconds;
  const serverEndTransitionDate =
    schedule.endAt === undefined ? undefined : schedule.endAt + serverMinusClientSeconds;
  const serverDismissalDate =
    schedule.dismissalDate === undefined ? undefined : schedule.dismissalDate + serverMinusClientSeconds;
  const jobId = pushStartJobKey(schedule.userId, schedule.deviceId, schedule.courseId, schedule.classStartDate);
  const contextKey = remoteStartContextKey(
    schedule.userId,
    schedule.deviceId,
    schedule.courseId,
    schedule.classStartDate,
    schedule.classEndDate
  );

  store.upsertRemoteStartContext({
    key: contextKey,
    userId: schedule.userId,
    deviceId: schedule.deviceId,
    courseId: schedule.courseId,
    clientClassStartDate: schedule.classStartDate,
    clientClassEndDate: schedule.classEndDate,
    serverClassStartDate,
    serverClassEndDate,
    serverEndTransitionDate,
    serverDismissalDate,
    sendStartTransition: schedule.initialPhase === 'before' && (schedule.endAt ?? schedule.classEndDate) > schedule.classStartDate,
    createdAt: Math.floor(Date.now() / 1000)
  });

  store.upsertScheduledJob({
    id: jobId,
    kind: 'push_start',
    userId: schedule.userId,
    deviceId: schedule.deviceId,
    dueAt: serverPushAt,
    payload: buildPushStartJobPayload({
      userId: schedule.userId,
      deviceId: schedule.deviceId,
      semester: schedule.semester,
      courseName: schedule.courseName,
      courseId: schedule.courseId,
      location: schedule.location,
      instructor: schedule.instructor,
      initialPhase: schedule.initialPhase,
      clientClassStartDate: schedule.classStartDate,
      clientClassEndDate: schedule.classEndDate
    })
  });

  return {
    jobId,
    userId: schedule.userId,
    deviceId: schedule.deviceId,
    courseId: schedule.courseId,
    courseName: schedule.courseName,
    initialPhase: schedule.initialPhase,
    serverPushAt,
    serverClassStartDate,
    serverClassEndDate,
    serverEndTransitionDate,
    serverDismissalDate,
    clientPushAt: schedule.pushAt,
    clientClassStartDate: schedule.classStartDate,
    clientClassEndDate: schedule.classEndDate,
    clientEndAt: schedule.endAt,
    clientDismissalDate: schedule.dismissalDate,
    serverMinusClientSeconds,
    hasPushToStartToken: Boolean(registration)
  };
}

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

  const { userId, deviceId, activityId, pushToken, courseName, courseId, classStartDate, classEndDate } = value;

  if (!isNonEmptyString(userId)) {
    return { valid: false, error: 'userId must be a non-empty string.' };
  }
  if (!isNonEmptyString(deviceId)) {
    return { valid: false, error: 'deviceId must be a non-empty string.' };
  }
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
      userId,
      deviceId,
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

  const { userId, deviceId, pushToStartToken, clientUnixTime } = value;
  if (!isNonEmptyString(userId)) {
    return { valid: false, error: 'userId must be a non-empty string.' };
  }
  if (!isNonEmptyString(deviceId)) {
    return { valid: false, error: 'deviceId must be a non-empty string.' };
  }
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
    payload: { userId, deviceId, pushToStartToken, clientUnixTime }
  };
}

function validateCancelDevicePayload(value: unknown):
  | { valid: true; payload: { userId: string; deviceId: string; deactivateToken: boolean } }
  | { valid: false; error: string } {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const keys = Object.keys(value).sort();
  const requiredKeys = CANCEL_DEVICE_KEYS.filter((key) => key !== 'deactivateToken');
  const allowedKeys = [...CANCEL_DEVICE_KEYS];
  if (!keys.every((key) => allowedKeys.includes(key as (typeof CANCEL_DEVICE_KEYS)[number]))) {
    return { valid: false, error: `Request body may only contain these fields: ${CANCEL_DEVICE_KEYS.join(', ')}` };
  }
  if (!requiredKeys.every((key) => keys.includes(key))) {
    return { valid: false, error: `Request body must contain these fields: ${requiredKeys.join(', ')}` };
  }

  const { userId, deviceId, deactivateToken } = value;
  if (!isNonEmptyString(userId)) {
    return { valid: false, error: 'userId must be a non-empty string.' };
  }
  if (!isNonEmptyString(deviceId)) {
    return { valid: false, error: 'deviceId must be a non-empty string.' };
  }
  if (deactivateToken !== undefined && typeof deactivateToken !== 'boolean') {
    return { valid: false, error: 'deactivateToken must be a boolean when provided.' };
  }

  return {
    valid: true,
    payload: {
      userId,
      deviceId,
      deactivateToken: deactivateToken === true
    }
  };
}

function validateRemoteStartPayload(value: unknown):
  | { valid: true; payload: IdentifiedRemoteStartPayload }
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

  const { userId, deviceId, courseName, courseId, location, instructor } = value;
  if (!isNonEmptyString(userId)) {
    return { valid: false, error: 'userId must be a non-empty string.' };
  }
  if (!isNonEmptyString(deviceId)) {
    return { valid: false, error: 'deviceId must be a non-empty string.' };
  }
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
      userId,
      deviceId,
      courseName,
      courseId,
      location,
      instructor
    }
  };
}

function validatePushToStartSchedulePayload(value: unknown):
  | { valid: true; payload: PushToStartSchedulePayload }
  | { valid: false; error: string } {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const keys = Object.keys(value).sort();
  const expectedKeys = [...PUSH_TO_START_SCHEDULE_KEYS].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) {
    return {
      valid: false,
      error: `Request body must contain exactly these fields: ${PUSH_TO_START_SCHEDULE_KEYS.join(', ')}`
    };
  }

  if (!Array.isArray(value.schedules)) {
    return { valid: false, error: 'schedules must be an array.' };
  }
  if (value.schedules.length === 0) {
    return { valid: false, error: 'schedules must contain at least one entry.' };
  }
  if (value.schedules.length > 20) {
    return { valid: false, error: 'schedules cannot contain more than 20 entries.' };
  }

  const schedules: RemoteStartSchedulePayload[] = [];
  for (const [index, schedule] of value.schedules.entries()) {
    const parsed = validateRemoteStartSchedulePayload(schedule, { allowSemesterRange: false });
    if (!parsed.valid) {
      return { valid: false, error: `schedules[${index}]: ${parsed.error}` };
    }
    schedules.push(parsed.payload);
  }

  return { valid: true, payload: { schedules } };
}

function validatePushToStartSemesterSyncPayload(value: unknown):
  | { valid: true; payload: PushToStartSemesterSyncPayload }
  | { valid: false; error: string } {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const keys = Object.keys(value).sort();
  const expectedKeys = [...PUSH_TO_START_SEMESTER_SYNC_KEYS].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])) {
    return {
      valid: false,
      error: `Request body must contain exactly these fields: ${PUSH_TO_START_SEMESTER_SYNC_KEYS.join(', ')}`
    };
  }

  const { userId, deviceId, semester, semesterEndDate, schedules } = value;
  if (!isNonEmptyString(userId)) {
    return { valid: false, error: 'userId must be a non-empty string.' };
  }
  if (!isNonEmptyString(deviceId)) {
    return { valid: false, error: 'deviceId must be a non-empty string.' };
  }
  if (!isNonEmptyString(semester)) {
    return { valid: false, error: 'semester must be a non-empty string.' };
  }
  if (!isUnixTimestamp(semesterEndDate)) {
    return { valid: false, error: 'semesterEndDate must be a Unix timestamp in seconds.' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (semesterEndDate < now) {
    return { valid: false, error: 'semesterEndDate must be in the future.' };
  }
  if (semesterEndDate - now > MAX_SEMESTER_SYNC_SECONDS) {
    return { valid: false, error: 'semesterEndDate cannot be more than 220 days in the future.' };
  }
  if (!Array.isArray(schedules)) {
    return { valid: false, error: 'schedules must be an array.' };
  }
  if (schedules.length > 1000) {
    return { valid: false, error: 'schedules cannot contain more than 1000 entries.' };
  }

  const parsedSchedules: RemoteStartSchedulePayload[] = [];
  for (const [index, schedule] of schedules.entries()) {
    const parsed = validateRemoteStartSchedulePayload(schedule, { allowSemesterRange: true });
    if (!parsed.valid) {
      return { valid: false, error: `schedules[${index}]: ${parsed.error}` };
    }
    if (parsed.payload.userId !== userId || parsed.payload.deviceId !== deviceId) {
      return { valid: false, error: `schedules[${index}]: userId and deviceId must match the sync payload.` };
    }
    if (parsed.payload.classStartDate > semesterEndDate || parsed.payload.pushAt > semesterEndDate) {
      return { valid: false, error: `schedules[${index}]: schedule must be before semesterEndDate.` };
    }
    parsedSchedules.push({
      ...parsed.payload,
      semester
    });
  }

  return {
    valid: true,
    payload: {
      userId,
      deviceId,
      semester,
      semesterEndDate,
      schedules: parsedSchedules
    }
  };
}

function validateRemoteStartSchedulePayload(
  value: unknown,
  options: { allowSemesterRange: boolean }
):
  | { valid: true; payload: RemoteStartSchedulePayload }
  | { valid: false; error: string } {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'schedule must be a JSON object.' };
  }

  const keys = Object.keys(value).sort();
  const requiredKeys = REMOTE_START_SCHEDULE_KEYS.filter((key) => key !== 'dismissalDate' && key !== 'endAt' && key !== 'semester');
  const expectedKeys = [...requiredKeys].sort();
  const allowedKeys = [...REMOTE_START_SCHEDULE_KEYS];
  if (!keys.every((key) => allowedKeys.includes(key as (typeof REMOTE_START_SCHEDULE_KEYS)[number]))) {
    return { valid: false, error: `schedule may only contain these fields: ${REMOTE_START_SCHEDULE_KEYS.join(', ')}` };
  }
  if (!expectedKeys.every((key) => keys.includes(key))) {
    return { valid: false, error: `schedule must contain these fields: ${requiredKeys.join(', ')}` };
  }

  const {
    userId,
    deviceId,
    semester,
    courseName,
    courseId,
    location,
    instructor,
    pushAt,
    classStartDate,
    classEndDate,
    initialPhase,
    endAt,
    dismissalDate
  } = value;
  if (!isNonEmptyString(userId)) {
    return { valid: false, error: 'userId must be a non-empty string.' };
  }
  if (!isNonEmptyString(deviceId)) {
    return { valid: false, error: 'deviceId must be a non-empty string.' };
  }
  if (semester !== undefined && !isNonEmptyString(semester)) {
    return { valid: false, error: 'semester must be a non-empty string when provided.' };
  }
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
  if (!isUnixTimestamp(pushAt)) {
    return { valid: false, error: 'pushAt must be a Unix timestamp in seconds.' };
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
  if (initialPhase !== 'before' && initialPhase !== 'during') {
    return { valid: false, error: 'initialPhase must be before or during.' };
  }
  if (initialPhase === 'before' && pushAt > classStartDate) {
    return { valid: false, error: 'pushAt must be before classStartDate when initialPhase is before.' };
  }
  if (initialPhase === 'during' && pushAt > classEndDate) {
    return { valid: false, error: 'pushAt must be before classEndDate when initialPhase is during.' };
  }
  if (endAt !== undefined && !isUnixTimestamp(endAt)) {
    return { valid: false, error: 'endAt must be a Unix timestamp in seconds.' };
  }
  if (typeof endAt === 'number' && endAt < pushAt) {
    return { valid: false, error: 'endAt must be greater than or equal to pushAt.' };
  }
  if (dismissalDate !== undefined && !isUnixTimestamp(dismissalDate)) {
    return { valid: false, error: 'dismissalDate must be a Unix timestamp in seconds.' };
  }
  if (typeof dismissalDate === 'number' && dismissalDate < (typeof endAt === 'number' ? endAt : classEndDate)) {
    return { valid: false, error: 'dismissalDate must be greater than or equal to endAt or classEndDate.' };
  }
  const parsedEndAt = typeof endAt === 'number' ? endAt : undefined;
  const parsedDismissalDate = typeof dismissalDate === 'number' ? dismissalDate : undefined;
  const now = Math.floor(Date.now() / 1000);
  const furthestScheduledDate = Math.max(
    pushAt,
    classStartDate,
    classEndDate,
    parsedEndAt ?? 0,
    parsedDismissalDate ?? 0
  );
  if ((furthestScheduledDate - now) * 1000 > MAX_TIMEOUT_MS) {
    if (!options.allowSemesterRange || furthestScheduledDate - now > MAX_SEMESTER_SYNC_SECONDS) {
      return { valid: false, error: options.allowSemesterRange
        ? 'schedule dates must be within 220 days of the current server time.'
        : 'schedule dates must be within 24.8 days of the current server time.' };
    }
  }

  return {
    valid: true,
    payload: {
      userId,
      deviceId,
      semester: typeof semester === 'string' ? semester : undefined,
      courseName,
      courseId,
      location,
      instructor,
      pushAt,
      classStartDate,
      classEndDate,
      initialPhase,
      endAt: parsedEndAt,
      dismissalDate: parsedDismissalDate
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

function requireAppAuth(request: Request, response: Response, next: NextFunction): void {
  if (!config.appAuthToken) {
    next();
    return;
  }

  if (request.path === '/docs/openapi.json' || request.path.startsWith('/docs')) {
    next();
    return;
  }

  const expected = `Bearer ${config.appAuthToken}`;
  if (request.header('authorization') !== expected) {
    response.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  next();
}
