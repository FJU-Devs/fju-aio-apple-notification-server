export type ActivityPhase = 'before' | 'during' | 'ended';

export interface RegisterActivityPayload {
  userId: string;
  deviceId: string;
  activityId: string;
  pushToken: string;
  courseName: string;
  courseId: string;
  classStartDate: number;
  classEndDate: number;
}

export interface PushToStartRegistrationPayload {
  userId: string;
  deviceId: string;
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
  userId: string;
  deviceId: string;
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
  userId: string;
  deviceId: string;
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

export type ScheduledJobKind = 'push_start' | 'activity_start' | 'activity_end';
export type ScheduledJobStatus = 'queued' | 'processing' | 'sent' | 'failed' | 'cancelled';

export interface ScheduledJobRecord {
  id: string;
  kind: ScheduledJobKind;
  status: ScheduledJobStatus;
  userId: string;
  deviceId: string;
  dueAt: number;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  lockedUntil?: number;
  lastError?: string;
  apnsStatus?: number;
  apnsReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PushToStartTokenRecord {
  userId: string;
  deviceId: string;
  token: string;
  serverMinusClientSeconds: number;
  registeredAt: number;
  updatedAt: number;
  active: boolean;
}

export interface RemoteStartContextRecord {
  key: string;
  userId: string;
  deviceId: string;
  courseId: string;
  clientClassStartDate: number;
  clientClassEndDate: number;
  serverClassStartDate: number;
  serverClassEndDate: number;
  serverEndTransitionDate?: number;
  serverDismissalDate?: number;
  sendStartTransition: boolean;
  createdAt: number;
  consumedAt?: number;
}
