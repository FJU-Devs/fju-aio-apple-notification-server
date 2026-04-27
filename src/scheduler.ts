import { sendActivityEnded, sendActivityUpdate } from './apns.js';
import { logApnsError } from './apns.js';
import { logDebug, logInfo, previewToken } from './logger.js';
import { ActivityStore } from './store.js';
import type { ActivityPhase, ActivityRecord } from './types.js';

interface ActivityTimers {
  startTimer?: NodeJS.Timeout;
  endTimer?: NodeJS.Timeout;
}

interface ScheduleOptions {
  sendStartTransition?: boolean;
}

const RETRY_DELAY_MS = 60_000;

export class ActivityScheduler {
  private readonly timers = new Map<string, ActivityTimers>();

  constructor(private readonly store: ActivityStore) {}

  schedule(activity: ActivityRecord, options: ScheduleOptions = {}): void {
    this.clear(activity.activityId);
    const now = Math.floor(Date.now() / 1000);
    const startDelayMs = Math.max(0, (activity.classStartDate - now) * 1000);
    const endDelayMs = Math.max(0, (activity.classEndDate - now) * 1000);
    const sendStartTransition = options.sendStartTransition ?? true;

    const nextPhase = determinePhase(now, activity.classStartDate, activity.classEndDate);
    logDebug('Scheduling activity transitions.', {
      activityId: activity.activityId,
      previousPhase: activity.currentPhase,
      nextPhase,
      now,
      startDelayMs,
      endDelayMs,
      pushTokenPreview: previewToken(activity.pushToken)
    });

    this.store.upsert({
      ...activity,
      currentPhase: nextPhase,
      updatedAt: now
    });

    const timerState: ActivityTimers = {};

    if (!sendStartTransition) {
      logInfo('Skipping class start push; client will derive phase from schedule.', {
        activityId: activity.activityId,
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate
      });
    } else if (now < activity.classStartDate) {
      timerState.startTimer = setTimeout(() => {
        void this.runStartTransition(activity.activityId);
      }, startDelayMs);
      logInfo('Scheduled class start push.', { activityId: activity.activityId, startDelayMs });
    } else if (now < activity.classEndDate) {
      logDebug('Running immediate during transition.', { activityId: activity.activityId, now });
      void this.runImmediateDuring(activity.activityId);
    }

    if (now < activity.classEndDate) {
      timerState.endTimer = setTimeout(() => {
        void this.runEndTransition(activity.activityId);
      }, endDelayMs);
      logInfo('Scheduled class end push.', { activityId: activity.activityId, endDelayMs });
    } else {
      logDebug('Running immediate end transition.', { activityId: activity.activityId, now });
      void this.runEndTransition(activity.activityId);
    }

    this.timers.set(activity.activityId, timerState);
  }

  clear(activityId: string): void {
    const existing = this.timers.get(activityId);
    if (!existing) {
      logDebug('No scheduled timers found to clear.', { activityId });
      return;
    }

    if (existing.startTimer) {
      clearTimeout(existing.startTimer);
    }
    if (existing.endTimer) {
      clearTimeout(existing.endTimer);
    }

    this.timers.delete(activityId);
    logDebug('Cleared scheduled timers.', {
      activityId,
      clearedStartTimer: Boolean(existing.startTimer),
      clearedEndTimer: Boolean(existing.endTimer)
    });
  }

  private async runStartTransition(activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity) {
      logDebug('Skipped start transition.', { activityId, reason: 'missing' });
      return;
    }

    if (activity.currentPhase === 'during' || activity.currentPhase === 'ended') {
      logDebug('Skipped start transition.', { activityId, reason: `already-${activity.currentPhase}` });
      return;
    }

    try {
      logDebug('Dispatching start transition APNs update.', {
        activityId,
        phaseFrom: activity.currentPhase,
        phaseTo: 'during',
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate,
        pushTokenPreview: previewToken(activity.pushToken)
      });

      await sendActivityUpdate({
        pushToken: activity.pushToken,
        courseName: activity.courseName,
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate
      });

      const now = Math.floor(Date.now() / 1000);
      this.store.upsert({
        ...activity,
        currentPhase: 'during',
        updatedAt: now
      });
      logDebug('Marked activity as during after APNs success.', { activityId, updatedAt: now });
    } catch (error: unknown) {
      logApnsError(`Failed to send start transition for ${activityId}.`, error);
      this.retryStartTransition(activityId);
    }
  }

  private async runImmediateDuring(activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity) {
      logDebug('Skipped immediate during transition.', { activityId, reason: 'missing' });
      return;
    }

    if (activity.currentPhase === 'ended') {
      logDebug('Skipped immediate during transition.', { activityId, reason: 'already-ended' });
      return;
    }

    try {
      logDebug('Dispatching immediate during APNs update.', {
        activityId,
        phaseFrom: activity.currentPhase,
        phaseTo: 'during',
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate,
        pushTokenPreview: previewToken(activity.pushToken)
      });

      await sendActivityUpdate({
        pushToken: activity.pushToken,
        courseName: activity.courseName,
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate
      });

      const now = Math.floor(Date.now() / 1000);
      this.store.upsert({
        ...activity,
        currentPhase: 'during',
        updatedAt: now
      });
      logDebug('Marked activity as during after immediate APNs success.', { activityId, updatedAt: now });
    } catch (error: unknown) {
      logApnsError(`Failed to send immediate during update for ${activityId}.`, error);
      this.retryStartTransition(activityId);
    }
  }

  private async runEndTransition(activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity) {
      logDebug('Skipped end transition.', { activityId, reason: 'missing' });
      return;
    }

    if (activity.currentPhase === 'ended') {
      logDebug('Skipped end transition.', { activityId, reason: 'already-ended' });
      return;
    }

    try {
      logDebug('Dispatching end transition APNs sequence.', {
        activityId,
        phaseFrom: activity.currentPhase,
        phaseTo: 'ended',
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate,
        pushTokenPreview: previewToken(activity.pushToken)
      });

      await sendActivityEnded({
        pushToken: activity.pushToken,
        courseName: activity.courseName,
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate
      });

      const now = Math.floor(Date.now() / 1000);
      this.store.upsert({
        ...activity,
        currentPhase: 'ended',
        updatedAt: now
      });
      this.clear(activityId);
      logDebug('Marked activity as ended after APNs success.', { activityId, updatedAt: now });
    } catch (error: unknown) {
      logApnsError(`Failed to send end transition for ${activityId}.`, error);
      this.retryEndTransition(activityId);
    }
  }

  private retryStartTransition(activityId: string): void {
    const timers = this.timers.get(activityId) ?? {};
    timers.startTimer = setTimeout(() => {
      void this.runStartTransition(activityId);
    }, RETRY_DELAY_MS);
    this.timers.set(activityId, timers);
    logDebug('Scheduled retry for start transition.', { activityId, retryDelayMs: RETRY_DELAY_MS });
  }

  private retryEndTransition(activityId: string): void {
    const timers = this.timers.get(activityId) ?? {};
    timers.endTimer = setTimeout(() => {
      void this.runEndTransition(activityId);
    }, RETRY_DELAY_MS);
    this.timers.set(activityId, timers);
    logDebug('Scheduled retry for end transition.', { activityId, retryDelayMs: RETRY_DELAY_MS });
  }
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
