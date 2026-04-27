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
  clientUnixTime: number;
}

export interface RemoteStartPayload {
  courseName: string;
  courseId: string;
  location: string;
  instructor: string;
}

export interface RemoteStartSchedulePayload extends RemoteStartPayload {
  pushAt: number;
  classStartDate: number;
  classEndDate: number;
  initialPhase: ActivityPhase;
  endAt?: number;
  dismissalDate?: number;
}

export interface PushToStartSchedulePayload {
  schedules: RemoteStartSchedulePayload[];
}

export interface CourseActivityAttributesPayload extends RemoteStartPayload {}

export interface CourseActivityContentState {
  phase: ActivityPhase;
  classStartDate: number;
  classEndDate: number;
}

export interface ActivityRecord extends RegisterActivityPayload {
  displayClassStartDate?: number;
  displayClassEndDate?: number;
  endTransitionDate?: number;
  dismissalDate?: number;
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
