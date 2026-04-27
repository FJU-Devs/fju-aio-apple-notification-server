import type { ActivityListItem, ActivityRecord } from './types.js';

export class ActivityStore {
  private readonly activities = new Map<string, ActivityRecord>();

  upsert(activity: ActivityRecord): ActivityRecord {
    this.activities.set(activity.activityId, activity);
    return activity;
  }

  get(activityId: string): ActivityRecord | undefined {
    return this.activities.get(activityId);
  }

  delete(activityId: string): boolean {
    return this.activities.delete(activityId);
  }

  list(): ActivityListItem[] {
    return Array.from(this.activities.values()).map((activity) => ({
      activityId: activity.activityId,
      pushTokenPreview: redactToken(activity.pushToken),
      courseName: activity.courseName,
      courseId: activity.courseId,
      classStartDate: activity.classStartDate,
      classEndDate: activity.classEndDate,
      currentPhase: activity.currentPhase,
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt
    }));
  }
}

function redactToken(token: string): string {
  if (token.length <= 10) {
    return 'redacted';
  }

  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}
