import { sendActivityEnded, sendActivityUpdate } from './apns.js';
import { logApnsError } from './apns.js';
import { logInfo } from './logger.js';
import { ActivityStore } from './store.js';
import type { ActivityPhase, ActivityRecord } from './types.js';

interface ActivityTimers {
  startTimer?: NodeJS.Timeout;
  endTimer?: NodeJS.Timeout;
}

const RETRY_DELAY_MS = 60_000;

export class ActivityScheduler {
  private readonly timers = new Map<string, ActivityTimers>();

  constructor(private readonly store: ActivityStore) {}

  schedule(activity: ActivityRecord): void {
    this.clear(activity.activityId);
    const now = Math.floor(Date.now() / 1000);
    const startDelayMs = Math.max(0, (activity.classStartDate - now) * 1000);
    const endDelayMs = Math.max(0, (activity.classEndDate - now) * 1000);

    const nextPhase = determinePhase(now, activity.classStartDate, activity.classEndDate);
    this.store.upsert({
      ...activity,
      currentPhase: nextPhase,
      updatedAt: now
    });

    const timerState: ActivityTimers = {};

    if (now < activity.classStartDate) {
      timerState.startTimer = setTimeout(() => {
        void this.runStartTransition(activity.activityId);
      }, startDelayMs);
      logInfo('Scheduled class start push.', { activityId: activity.activityId, startDelayMs });
    } else if (now < activity.classEndDate) {
      void this.runImmediateDuring(activity.activityId);
    }

    if (now < activity.classEndDate) {
      timerState.endTimer = setTimeout(() => {
        void this.runEndTransition(activity.activityId);
      }, endDelayMs);
      logInfo('Scheduled class end push.', { activityId: activity.activityId, endDelayMs });
    } else {
      void this.runEndTransition(activity.activityId);
    }

    this.timers.set(activity.activityId, timerState);
  }

  clear(activityId: string): void {
    const existing = this.timers.get(activityId);
    if (!existing) {
      return;
    }

    if (existing.startTimer) {
      clearTimeout(existing.startTimer);
    }
    if (existing.endTimer) {
      clearTimeout(existing.endTimer);
    }

    this.timers.delete(activityId);
  }

  private async runStartTransition(activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity || activity.currentPhase === 'during' || activity.currentPhase === 'ended') {
      return;
    }

    try {
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
    } catch (error: unknown) {
      logApnsError(`Failed to send start transition for ${activityId}.`, error);
      this.retryStartTransition(activityId);
    }
  }

  private async runImmediateDuring(activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity || activity.currentPhase === 'ended') {
      return;
    }

    try {
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
    } catch (error: unknown) {
      logApnsError(`Failed to send immediate during update for ${activityId}.`, error);
      this.retryStartTransition(activityId);
    }
  }

  private async runEndTransition(activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity || activity.currentPhase === 'ended') {
      return;
    }

    try {
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
  }

  private retryEndTransition(activityId: string): void {
    const timers = this.timers.get(activityId) ?? {};
    timers.endTimer = setTimeout(() => {
      void this.runEndTransition(activityId);
    }, RETRY_DELAY_MS);
    this.timers.set(activityId, timers);
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
