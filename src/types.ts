export type ActivityPhase = 'before' | 'during' | 'ended';

export interface RegisterActivityPayload {
  activityId: string;
  pushToken: string;
  courseName: string;
  courseId: string;
  classStartDate: number;
  classEndDate: number;
}

export interface CourseActivityContentState {
  phase: ActivityPhase;
  classStartDate: number;
  classEndDate: number;
}

export interface ActivityRecord extends RegisterActivityPayload {
  currentPhase: ActivityPhase;
  createdAt: number;
  updatedAt: number;
}

export interface ActivityListItem {
  activityId: string;
  pushTokenPreview: string;
  courseName: string;
  courseId: string;
  classStartDate: number;
  classEndDate: number;
  currentPhase: ActivityPhase;
  createdAt: number;
  updatedAt: number;
}

export interface ApnsSendResult {
  status: number;
  body: string;
  apnsId?: string;
}
