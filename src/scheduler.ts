import { randomUUID } from 'node:crypto';

import {
  ApnsRequestError,
  isPermanentApnsTokenError,
  logApnsError,
  sendActivityEnded,
  sendActivityStart,
  sendActivityUpdate
} from './apns.js';
import { config } from './config.js';
import { logDebug, logInfo, previewToken } from './logger.js';
import {
  ActivityStore,
  activityTransitionJobKey
} from './store.js';
import type { ActivityPhase, ActivityRecord, RemoteStartPayload, ScheduledJobRecord } from './types.js';

interface ScheduleOptions {
  sendStartTransition?: boolean;
}

interface PushStartJobPayload extends RemoteStartPayload {
  userId: string;
  deviceId: string;
  semester?: string;
  initialPhase: ActivityPhase;
  clientClassStartDate: number;
  clientClassEndDate: number;
}

interface ActivityTransitionJobPayload {
  activityId: string;
  transition: 'start' | 'end';
}

const BASE_RETRY_DELAY_SECONDS = 30;
const MAX_RETRY_DELAY_SECONDS = 10 * 60;

export class ActivityScheduler {
  private readonly workerId = randomUUID();
  private readonly tickTimer: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly store: ActivityStore) {
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, config.schedulerPollMs);
    this.tickTimer.unref?.();
    void this.tick();
  }

  schedule(activity: ActivityRecord, options: ScheduleOptions = {}): void {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sendStartTransition = options.sendStartTransition ?? true;
    const endTransitionDate = activity.endTransitionDate ?? activity.classEndDate;
    const nextPhase = determinePhase(nowSeconds, activity.classStartDate, activity.classEndDate);

    logDebug('Persisting activity transition jobs.', {
      activityId: activity.activityId,
      userId: activity.userId,
      deviceId: activity.deviceId,
      previousPhase: activity.currentPhase,
      nextPhase,
      now: nowSeconds,
      classStartDate: activity.classStartDate,
      endTransitionDate,
      pushTokenPreview: previewToken(activity.pushToken)
    });

    this.store.upsert({
      ...activity,
      currentPhase: nextPhase,
      updatedAt: nowSeconds
    });

    if (!sendStartTransition) {
      logInfo('Skipping class start push; client will derive phase from schedule.', {
        activityId: activity.activityId,
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate
      });
    } else if (nowSeconds < activity.classEndDate) {
      this.store.upsertScheduledJob({
        id: activityTransitionJobKey(activity.activityId, 'start'),
        kind: 'activity_start',
        userId: activity.userId,
        deviceId: activity.deviceId,
        dueAt: Math.max(nowSeconds, activity.classStartDate),
        payload: {
          activityId: activity.activityId,
          transition: 'start'
        } satisfies ActivityTransitionJobPayload
      });
    }

    this.store.upsertScheduledJob({
      id: activityTransitionJobKey(activity.activityId, 'end'),
      kind: 'activity_end',
      userId: activity.userId,
      deviceId: activity.deviceId,
      dueAt: Math.max(nowSeconds, endTransitionDate),
      payload: {
        activityId: activity.activityId,
        transition: 'end'
      } satisfies ActivityTransitionJobPayload
    });

    void this.tick();
  }

  clear(activityId: string): void {
    const deleted = this.store.delete(activityId);
    logDebug('Cleared persisted activity registration.', { activityId, deleted });
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }

    this.ticking = true;
    try {
      const jobs = this.store.claimDueJobs(
        this.workerId,
        config.schedulerBatchSize,
        config.schedulerLockSeconds
      );
      for (const job of jobs) {
        await this.runJob(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runJob(job: ScheduledJobRecord): Promise<void> {
    try {
      if (job.kind === 'push_start') {
        await this.runPushStart(job, parsePushStartPayload(job.payload));
      } else {
        await this.runActivityTransition(job, parseActivityTransitionPayload(job.payload));
      }
      this.store.markJobSent(job.id);
    } catch (error: unknown) {
      this.handleJobError(job, error);
    }
  }

  private async runPushStart(job: ScheduledJobRecord, payload: PushStartJobPayload): Promise<void> {
    const token = this.store.getPushToStartToken(payload.userId, payload.deviceId);
    if (!token) {
      throw new Error(`No active push-to-start token for user ${payload.userId} device ${payload.deviceId}.`);
    }

    logDebug('Dispatching persisted push-to-start job.', {
      jobId: job.id,
      userId: payload.userId,
      deviceId: payload.deviceId,
      courseId: payload.courseId,
      initialPhase: payload.initialPhase,
      pushToStartTokenPreview: previewToken(token.token)
    });

    await sendActivityStart({
      pushToStartToken: token.token,
      courseName: payload.courseName,
      courseId: payload.courseId,
      location: payload.location,
      instructor: payload.instructor,
      classStartDate: payload.clientClassStartDate,
      classEndDate: payload.clientClassEndDate,
      phase: payload.initialPhase
    });
  }

  private async runActivityTransition(job: ScheduledJobRecord, payload: ActivityTransitionJobPayload): Promise<void> {
    if (payload.transition === 'start') {
      await this.runStartTransition(job, payload.activityId);
      return;
    }

    await this.runEndTransition(job, payload.activityId);
  }

  private async runStartTransition(job: ScheduledJobRecord, activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity) {
      logDebug('Skipped start transition.', { jobId: job.id, activityId, reason: 'missing' });
      return;
    }

    if (activity.currentPhase === 'during' || activity.currentPhase === 'ended') {
      logDebug('Skipped start transition.', { jobId: job.id, activityId, reason: `already-${activity.currentPhase}` });
      return;
    }

    logDebug('Dispatching persisted start transition APNs update.', {
      jobId: job.id,
      activityId,
      phaseFrom: activity.currentPhase,
      phaseTo: 'during',
      displayClassStartDate: displayClassStartDate(activity),
      displayClassEndDate: displayClassEndDate(activity),
      pushTokenPreview: previewToken(activity.pushToken)
    });

    await sendActivityUpdate({
      pushToken: activity.pushToken,
      courseName: activity.courseName,
      classStartDate: displayClassStartDate(activity),
      classEndDate: displayClassEndDate(activity)
    });

    const now = Math.floor(Date.now() / 1000);
    this.store.upsert({
      ...activity,
      currentPhase: 'during',
      updatedAt: now
    });
  }

  private async runEndTransition(job: ScheduledJobRecord, activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity) {
      logDebug('Skipped end transition.', { jobId: job.id, activityId, reason: 'missing' });
      return;
    }

    if (activity.currentPhase === 'ended') {
      logDebug('Skipped end transition.', { jobId: job.id, activityId, reason: 'already-ended' });
      return;
    }

    logDebug('Dispatching persisted end transition APNs sequence.', {
      jobId: job.id,
      activityId,
      phaseFrom: activity.currentPhase,
      phaseTo: 'ended',
      displayClassStartDate: displayClassStartDate(activity),
      displayClassEndDate: displayClassEndDate(activity),
      pushTokenPreview: previewToken(activity.pushToken)
    });

    await sendActivityEnded({
      pushToken: activity.pushToken,
      courseName: activity.courseName,
      classStartDate: displayClassStartDate(activity),
      classEndDate: displayClassEndDate(activity),
      dismissalDate: activity.dismissalDate ?? activity.classEndDate + 30
    });

    const now = Math.floor(Date.now() / 1000);
    this.store.upsert({
      ...activity,
      currentPhase: 'ended',
      updatedAt: now
    });
  }

  private handleJobError(job: ScheduledJobRecord, error: unknown): void {
    logApnsError(`Failed to process scheduled job ${job.id}.`, error);

    const apnsStatus = error instanceof ApnsRequestError ? error.status : undefined;
    const apnsReason = error instanceof ApnsRequestError ? error.reason : undefined;
    if (job.kind === 'push_start' && isPermanentApnsTokenError(error)) {
      this.store.deactivatePushToStartToken(job.userId, job.deviceId);
      this.store.markJobFailed(job.id, errorMessage(error), { apnsStatus, apnsReason });
      return;
    }

    if (isPermanentApnsTokenError(error)) {
      this.store.markJobFailed(job.id, errorMessage(error), { apnsStatus, apnsReason });
      return;
    }

    this.store.markJobFailed(job.id, errorMessage(error), {
      retryAt: Math.floor(Date.now() / 1000) + retryDelaySeconds(job.attempts),
      apnsStatus,
      apnsReason
    });
  }
}

export function buildPushStartJobPayload(args: PushStartJobPayload): PushStartJobPayload {
  return args;
}

function determinePhase(now: number, classStartDate: number, classEndDate: number): ActivityPhase {
  if (now < classStartDate) {
    return 'before';
  }
  if (now < classEndDate) {
    return 'during';
  }
  return 'ended';
}

function displayClassStartDate(activity: ActivityRecord): number {
  return activity.displayClassStartDate ?? activity.classStartDate;
}

function displayClassEndDate(activity: ActivityRecord): number {
  return activity.displayClassEndDate ?? activity.classEndDate;
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_SECONDS, BASE_RETRY_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1));
}

function parsePushStartPayload(value: unknown): PushStartJobPayload {
  if (!isObject(value)) {
    throw new Error('Invalid push_start job payload.');
  }
  return {
    userId: requiredString(value.userId, 'userId'),
    deviceId: requiredString(value.deviceId, 'deviceId'),
    courseName: requiredString(value.courseName, 'courseName'),
    courseId: requiredString(value.courseId, 'courseId'),
    location: requiredString(value.location, 'location'),
    instructor: requiredString(value.instructor, 'instructor'),
    semester: optionalString(value.semester),
    initialPhase: requiredString(value.initialPhase, 'initialPhase') as ActivityPhase,
    clientClassStartDate: requiredNumber(value.clientClassStartDate, 'clientClassStartDate'),
    clientClassEndDate: requiredNumber(value.clientClassEndDate, 'clientClassEndDate')
  };
}

function parseActivityTransitionPayload(value: unknown): ActivityTransitionJobPayload {
  if (!isObject(value)) {
    throw new Error('Invalid activity transition job payload.');
  }
  const transition = requiredString(value.transition, 'transition');
  if (transition !== 'start' && transition !== 'end') {
    throw new Error('Invalid activity transition type.');
  }
  return {
    activityId: requiredString(value.activityId, 'activityId'),
    transition
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${name} to be a string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Expected ${name} to be a number.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
