import { sendActivityEnded, sendActivityUpdate } from './apns.js';
import { logApnsError } from './apns.js';
import { logDebug, logInfo, previewToken } from './logger.js';
import { ActivityStore } from './store.js';
import type { ActivityPhase, ActivityRecord } from './types.js';

interface ScheduledActivity {
  activityId: string;
  startDueAtMs?: number;
  endDueAtMs?: number;
  startInFlight: boolean;
  endInFlight: boolean;
}

interface ScheduleOptions {
  sendStartTransition?: boolean;
}

const RETRY_DELAY_MS = 60_000;
const TICK_INTERVAL_MS = 250;

export class ActivityScheduler {
  private readonly scheduled = new Map<string, ScheduledActivity>();
  private readonly tickTimer: NodeJS.Timeout;

  constructor(private readonly store: ActivityStore) {
    this.tickTimer = setInterval(() => {
      this.tick();
    }, TICK_INTERVAL_MS);
    this.tickTimer.unref?.();
  }

  schedule(activity: ActivityRecord, options: ScheduleOptions = {}): void {
    this.clear(activity.activityId);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const nowMs = Date.now();
    const sendStartTransition = options.sendStartTransition ?? true;
    const startDueAtMs = activity.classStartDate * 1000;
    const endTransitionDate = activity.endTransitionDate ?? activity.classEndDate;
    const endDueAtMs = endTransitionDate * 1000;

    const nextPhase = determinePhase(nowSeconds, activity.classStartDate, activity.classEndDate);
    logDebug('Scheduling activity transitions.', {
      activityId: activity.activityId,
      previousPhase: activity.currentPhase,
      nextPhase,
      now: nowSeconds,
      startDelayMs: Math.max(0, startDueAtMs - nowMs),
      endDelayMs: Math.max(0, endDueAtMs - nowMs),
      endTransitionDate,
      pushTokenPreview: previewToken(activity.pushToken)
    });

    this.store.upsert({
      ...activity,
      currentPhase: nextPhase,
      updatedAt: nowSeconds
    });

    const scheduled: ScheduledActivity = {
      activityId: activity.activityId,
      startInFlight: false,
      endInFlight: false
    };

    if (!sendStartTransition) {
      logInfo('Skipping class start push; client will derive phase from schedule.', {
        activityId: activity.activityId,
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate
      });
    } else if (nowSeconds < activity.classStartDate) {
      scheduled.startDueAtMs = startDueAtMs;
      logInfo('Scheduled class start push.', {
        activityId: activity.activityId,
        startDueAtMs,
        startDelayMs: Math.max(0, startDueAtMs - nowMs)
      });
    } else if (nowSeconds < activity.classEndDate) {
      scheduled.startDueAtMs = nowMs;
      logDebug('Queued immediate during transition.', { activityId: activity.activityId, now: nowSeconds });
    }

    if (nowSeconds < endTransitionDate) {
      scheduled.endDueAtMs = endDueAtMs;
      logInfo('Scheduled class end push.', {
        activityId: activity.activityId,
        endDueAtMs,
        endDelayMs: Math.max(0, endDueAtMs - nowMs),
        endTransitionDate
      });
    } else {
      scheduled.endDueAtMs = nowMs;
      logDebug('Queued immediate end transition.', { activityId: activity.activityId, now: nowSeconds });
    }

    this.scheduled.set(activity.activityId, scheduled);
    this.tick();
  }

  clear(activityId: string): void {
    const deleted = this.scheduled.delete(activityId);
    if (deleted) {
      logDebug('Cleared scheduled transitions.', { activityId });
    } else {
      logDebug('No scheduled transitions found to clear.', { activityId });
    }
  }

  private tick(): void {
    const nowMs = Date.now();
    for (const scheduled of this.scheduled.values()) {
      if (
        scheduled.startDueAtMs !== undefined &&
        scheduled.startDueAtMs <= nowMs &&
        !scheduled.startInFlight
      ) {
        scheduled.startInFlight = true;
        scheduled.startDueAtMs = undefined;
        void this.runStartTransition(scheduled.activityId);
      }

      if (
        scheduled.endDueAtMs !== undefined &&
        scheduled.endDueAtMs <= nowMs &&
        !scheduled.endInFlight
      ) {
        scheduled.endInFlight = true;
        scheduled.endDueAtMs = undefined;
        void this.runEndTransition(scheduled.activityId);
      }
    }
  }

  private async runStartTransition(activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity) {
      logDebug('Skipped start transition.', { activityId, reason: 'missing' });
      this.markStartComplete(activityId);
      return;
    }

    if (activity.currentPhase === 'during' || activity.currentPhase === 'ended') {
      logDebug('Skipped start transition.', { activityId, reason: `already-${activity.currentPhase}` });
      this.markStartComplete(activityId);
      return;
    }

    try {
      logDebug('Dispatching start transition APNs update.', {
        activityId,
        phaseFrom: activity.currentPhase,
        phaseTo: 'during',
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate,
        displayClassStartDate: displayClassStartDate(activity),
        displayClassEndDate: displayClassEndDate(activity),
        dismissalDate: activity.dismissalDate,
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
      this.markStartComplete(activityId);
      logDebug('Marked activity as during after APNs success.', { activityId, updatedAt: now });
    } catch (error: unknown) {
      logApnsError(`Failed to send start transition for ${activityId}.`, error);
      this.retryStartTransition(activityId);
    }
  }

  private async runEndTransition(activityId: string): Promise<void> {
    const activity = this.store.get(activityId);
    if (!activity) {
      logDebug('Skipped end transition.', { activityId, reason: 'missing' });
      this.clear(activityId);
      return;
    }

    if (activity.currentPhase === 'ended') {
      logDebug('Skipped end transition.', { activityId, reason: 'already-ended' });
      this.clear(activityId);
      return;
    }

    try {
      logDebug('Dispatching end transition APNs sequence.', {
        activityId,
        phaseFrom: activity.currentPhase,
        phaseTo: 'ended',
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate,
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
      this.clear(activityId);
      logDebug('Marked activity as ended after APNs success.', { activityId, updatedAt: now });
    } catch (error: unknown) {
      logApnsError(`Failed to send end transition for ${activityId}.`, error);
      this.retryEndTransition(activityId);
    }
  }

  private markStartComplete(activityId: string): void {
    const scheduled = this.scheduled.get(activityId);
    if (!scheduled) {
      return;
    }

    scheduled.startInFlight = false;
    if (scheduled.startDueAtMs === undefined && scheduled.endDueAtMs === undefined) {
      this.scheduled.delete(activityId);
    }
  }

  private retryStartTransition(activityId: string): void {
    const scheduled = this.scheduled.get(activityId);
    if (!scheduled) {
      return;
    }

    scheduled.startInFlight = false;
    scheduled.startDueAtMs = Date.now() + RETRY_DELAY_MS;
    logDebug('Scheduled retry for start transition.', { activityId, retryDelayMs: RETRY_DELAY_MS });
  }

  private retryEndTransition(activityId: string): void {
    const scheduled = this.scheduled.get(activityId);
    if (!scheduled) {
      return;
    }

    scheduled.endInFlight = false;
    scheduled.endDueAtMs = Date.now() + RETRY_DELAY_MS;
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

function displayClassStartDate(activity: ActivityRecord): number {
  return activity.displayClassStartDate ?? activity.classStartDate;
}

function displayClassEndDate(activity: ActivityRecord): number {
  return activity.displayClassEndDate ?? activity.classEndDate;
}
