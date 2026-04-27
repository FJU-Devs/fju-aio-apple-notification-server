export type ActivityPhase = 'before' | 'during' | 'ended';

export interface RegisterActivityPayload {
  activityId: string;
  pushToken: string;
  courseName: string;
  courseId: string;
  classStartDate: number;
  classEndDate: number;
}

export interface PushToStartRegistrationPayload {
  pushToStartToken: string;
}

export interface RemoteStartPayload {
  courseName: string;
  courseId: string;
  location: string;
  instructor: string;
}

export interface CourseActivityAttributesPayload extends RemoteStartPayload {}

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
