import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { config } from './config.js';
import { previewToken } from './logger.js';
import type {
  ActivityListItem,
  ActivityRecord,
  PushToStartTokenRecord,
  RemoteStartContextRecord,
  ScheduledJobKind,
  ScheduledJobRecord,
  ScheduledJobStatus
} from './types.js';

type SqlValue = string | number | null;
type SqlRow = Record<string, unknown>;

interface StatementSync {
  run(...values: SqlValue[]): { changes: number };
  get(...values: SqlValue[]): SqlRow | undefined;
  all(...values: SqlValue[]): SqlRow[];
}

interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
}

const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };

export interface UpsertScheduledJobInput {
  id: string;
  kind: ScheduledJobKind;
  userId: string;
  deviceId: string;
  dueAt: number;
  payload: unknown;
  maxAttempts?: number;
}

export class ActivityStore {
  private readonly db: DatabaseSync;

  constructor(databasePath = config.databasePath) {
    const resolvedPath = resolve(databasePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath);
    this.migrate();
  }

  upsert(activity: ActivityRecord): ActivityRecord {
    this.db.prepare(`
      INSERT INTO activities (
        activity_id, user_id, device_id, push_token, course_name, course_id,
        class_start_date, class_end_date, display_class_start_date, display_class_end_date,
        end_transition_date, dismissal_date, current_phase, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        user_id = excluded.user_id,
        device_id = excluded.device_id,
        push_token = excluded.push_token,
        course_name = excluded.course_name,
        course_id = excluded.course_id,
        class_start_date = excluded.class_start_date,
        class_end_date = excluded.class_end_date,
        display_class_start_date = excluded.display_class_start_date,
        display_class_end_date = excluded.display_class_end_date,
        end_transition_date = excluded.end_transition_date,
        dismissal_date = excluded.dismissal_date,
        current_phase = excluded.current_phase,
        updated_at = excluded.updated_at
    `).run(
      activity.activityId,
      activity.userId,
      activity.deviceId,
      activity.pushToken,
      activity.courseName,
      activity.courseId,
      activity.classStartDate,
      activity.classEndDate,
      activity.displayClassStartDate ?? null,
      activity.displayClassEndDate ?? null,
      activity.endTransitionDate ?? null,
      activity.dismissalDate ?? null,
      activity.currentPhase,
      activity.createdAt,
      activity.updatedAt
    );
    return activity;
  }

  get(activityId: string): ActivityRecord | undefined {
    const row = this.db.prepare('SELECT * FROM activities WHERE activity_id = ?').get(activityId);
    return row ? toActivityRecord(row) : undefined;
  }

  delete(activityId: string): boolean {
    const result = this.db.prepare('DELETE FROM activities WHERE activity_id = ?').run(activityId);
    this.db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'cancelled', updated_at = ?
      WHERE kind IN ('activity_start', 'activity_end')
        AND status IN ('queued', 'processing', 'failed')
        AND json_extract(payload_json, '$.activityId') = ?
    `).run(nowSeconds(), activityId);
    return result.changes > 0;
  }

  list(): ActivityListItem[] {
    return this.db.prepare('SELECT * FROM activities ORDER BY updated_at DESC').all().map((row) => {
      const activity = toActivityRecord(row);
      return {
        userId: activity.userId,
        deviceId: activity.deviceId,
        activityId: activity.activityId,
        pushTokenPreview: previewToken(activity.pushToken),
        courseName: activity.courseName,
        courseId: activity.courseId,
        classStartDate: activity.classStartDate,
        classEndDate: activity.classEndDate,
        currentPhase: activity.currentPhase,
        createdAt: activity.createdAt,
        updatedAt: activity.updatedAt
      };
    });
  }

  upsertPushToStartToken(record: Omit<PushToStartTokenRecord, 'updatedAt' | 'active'>): PushToStartTokenRecord {
    const updatedAt = nowSeconds();
    this.db.prepare(`
      INSERT INTO push_to_start_tokens (
        user_id, device_id, token, server_minus_client_seconds, registered_at, updated_at, active
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(user_id, device_id) DO UPDATE SET
        token = excluded.token,
        server_minus_client_seconds = excluded.server_minus_client_seconds,
        registered_at = excluded.registered_at,
        updated_at = excluded.updated_at,
        active = 1
    `).run(
      record.userId,
      record.deviceId,
      record.token,
      record.serverMinusClientSeconds,
      record.registeredAt,
      updatedAt
    );

    return { ...record, updatedAt, active: true };
  }

  getPushToStartToken(userId: string, deviceId: string): PushToStartTokenRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM push_to_start_tokens
      WHERE user_id = ? AND device_id = ? AND active = 1
    `).get(userId, deviceId);
    return row ? toPushToStartTokenRecord(row) : undefined;
  }

  deactivatePushToStartToken(userId: string, deviceId: string): void {
    this.db.prepare(`
      UPDATE push_to_start_tokens
      SET active = 0, updated_at = ?
      WHERE user_id = ? AND device_id = ?
    `).run(nowSeconds(), userId, deviceId);
  }

  upsertRemoteStartContext(context: RemoteStartContextRecord): void {
    this.db.prepare(`
      INSERT INTO remote_start_contexts (
        context_key, user_id, device_id, course_id, client_class_start_date, client_class_end_date,
        server_class_start_date, server_class_end_date, server_end_transition_date,
        server_dismissal_date, send_start_transition, created_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(context_key) DO UPDATE SET
        server_class_start_date = excluded.server_class_start_date,
        server_class_end_date = excluded.server_class_end_date,
        server_end_transition_date = excluded.server_end_transition_date,
        server_dismissal_date = excluded.server_dismissal_date,
        send_start_transition = excluded.send_start_transition,
        consumed_at = NULL
    `).run(
      context.key,
      context.userId,
      context.deviceId,
      context.courseId,
      context.clientClassStartDate,
      context.clientClassEndDate,
      context.serverClassStartDate,
      context.serverClassEndDate,
      context.serverEndTransitionDate ?? null,
      context.serverDismissalDate ?? null,
      context.sendStartTransition ? 1 : 0,
      context.createdAt,
      context.consumedAt ?? null
    );
  }

  consumeRemoteStartContext(
    userId: string,
    deviceId: string,
    courseId: string,
    clientClassStartDate: number,
    clientClassEndDate: number
  ): RemoteStartContextRecord | undefined {
    const key = remoteStartContextKey(userId, deviceId, courseId, clientClassStartDate, clientClassEndDate);
    const row = this.db.prepare(`
      SELECT * FROM remote_start_contexts
      WHERE context_key = ? AND consumed_at IS NULL
    `).get(key);
    if (!row) {
      return undefined;
    }

    this.db.prepare(`
      UPDATE remote_start_contexts SET consumed_at = ? WHERE context_key = ? AND consumed_at IS NULL
    `).run(nowSeconds(), key);
    return toRemoteStartContextRecord(row);
  }

  upsertScheduledJob(input: UpsertScheduledJobInput): void {
    const now = nowSeconds();
    this.db.prepare(`
      INSERT INTO scheduled_jobs (
        id, kind, status, user_id, device_id, due_at, payload_json,
        attempts, max_attempts, locked_until, last_error, apns_status, apns_reason, created_at, updated_at
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        status = 'queued',
        user_id = excluded.user_id,
        device_id = excluded.device_id,
        due_at = excluded.due_at,
        payload_json = excluded.payload_json,
        max_attempts = excluded.max_attempts,
        locked_until = NULL,
        last_error = NULL,
        apns_status = NULL,
        apns_reason = NULL,
        updated_at = excluded.updated_at
      WHERE scheduled_jobs.status IN ('queued', 'failed', 'cancelled')
    `).run(
      input.id,
      input.kind,
      input.userId,
      input.deviceId,
      input.dueAt,
      JSON.stringify(input.payload),
      input.maxAttempts ?? 5,
      now,
      now
    );
  }

  claimDueJobs(workerId: string, limit: number, lockSeconds: number): ScheduledJobRecord[] {
    const now = nowSeconds();
    const lockUntil = now + lockSeconds;
    this.db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'queued', locked_until = NULL, updated_at = ?
      WHERE status = 'processing' AND locked_until IS NOT NULL AND locked_until < ?
    `).run(now, now);

    const ids = this.db.prepare(`
      SELECT id FROM scheduled_jobs
      WHERE status = 'queued' AND due_at <= ?
      ORDER BY due_at ASC, created_at ASC
      LIMIT ?
    `).all(now, limit).map((row) => requiredString(row.id, 'id'));

    const claimed: ScheduledJobRecord[] = [];
    for (const id of ids) {
      const result = this.db.prepare(`
        UPDATE scheduled_jobs
        SET status = 'processing',
            attempts = attempts + 1,
            locked_until = ?,
            last_error = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(lockUntil, now, id);
      if (result.changes === 0) {
        continue;
      }

      const row = this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id);
      if (row) {
        claimed.push(toScheduledJobRecord(row));
      }
    }

    void workerId;
    return claimed;
  }

  markJobSent(id: string, apnsStatus?: number, apnsReason?: string): void {
    this.db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'sent',
          locked_until = NULL,
          apns_status = ?,
          apns_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(apnsStatus ?? null, apnsReason ?? null, nowSeconds(), id);
  }

  markJobFailed(id: string, error: string, options: { retryAt?: number; apnsStatus?: number; apnsReason?: string } = {}): void {
    const row = this.db.prepare('SELECT attempts, max_attempts FROM scheduled_jobs WHERE id = ?').get(id);
    const attempts = row ? requiredNumber(row.attempts, 'attempts') : 1;
    const maxAttempts = row ? requiredNumber(row.max_attempts, 'max_attempts') : 1;
    const willRetry = options.retryAt !== undefined && attempts < maxAttempts;
    this.db.prepare(`
      UPDATE scheduled_jobs
      SET status = ?,
          due_at = COALESCE(?, due_at),
          locked_until = NULL,
          last_error = ?,
          apns_status = ?,
          apns_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      willRetry ? 'queued' : 'failed',
      willRetry ? options.retryAt ?? null : null,
      error,
      options.apnsStatus ?? null,
      options.apnsReason ?? null,
      nowSeconds(),
      id
    );
  }

  cancelFutureJobsForDevice(userId: string, deviceId: string): number {
    const result = this.db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'cancelled', locked_until = NULL, updated_at = ?
      WHERE user_id = ? AND device_id = ? AND status IN ('queued', 'processing', 'failed')
    `).run(nowSeconds(), userId, deviceId);
    this.db.prepare(`
      UPDATE remote_start_contexts
      SET consumed_at = ?
      WHERE user_id = ? AND device_id = ? AND consumed_at IS NULL
    `).run(nowSeconds(), userId, deviceId);
    return result.changes;
  }

  cancelStalePushStartJobsForSemester(
    userId: string,
    deviceId: string,
    semester: string,
    activeJobIds: string[]
  ): number {
    const now = nowSeconds();
    if (activeJobIds.length === 0) {
      return this.db.prepare(`
        UPDATE scheduled_jobs
        SET status = 'cancelled', locked_until = NULL, updated_at = ?
        WHERE user_id = ?
          AND device_id = ?
          AND kind = 'push_start'
          AND status IN ('queued', 'processing', 'failed')
          AND json_extract(payload_json, '$.semester') = ?
      `).run(now, userId, deviceId, semester).changes;
    }

    const placeholders = activeJobIds.map(() => '?').join(', ');
    return this.db.prepare(`
      UPDATE scheduled_jobs
      SET status = 'cancelled', locked_until = NULL, updated_at = ?
      WHERE user_id = ?
        AND device_id = ?
        AND kind = 'push_start'
        AND status IN ('queued', 'processing', 'failed')
        AND json_extract(payload_json, '$.semester') = ?
        AND id NOT IN (${placeholders})
    `).run(now, userId, deviceId, semester, ...activeJobIds).changes;
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS push_to_start_tokens (
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        token TEXT NOT NULL,
        server_minus_client_seconds INTEGER NOT NULL,
        registered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS activities (
        activity_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        push_token TEXT NOT NULL,
        course_name TEXT NOT NULL,
        course_id TEXT NOT NULL,
        class_start_date INTEGER NOT NULL,
        class_end_date INTEGER NOT NULL,
        display_class_start_date INTEGER,
        display_class_end_date INTEGER,
        end_transition_date INTEGER,
        dismissal_date INTEGER,
        current_phase TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS remote_start_contexts (
        context_key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        client_class_start_date INTEGER NOT NULL,
        client_class_end_date INTEGER NOT NULL,
        server_class_start_date INTEGER NOT NULL,
        server_class_end_date INTEGER NOT NULL,
        server_end_transition_date INTEGER,
        server_dismissal_date INTEGER,
        send_start_transition INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        locked_until INTEGER,
        last_error TEXT,
        apns_status INTEGER,
        apns_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
        ON scheduled_jobs(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_user_device
        ON scheduled_jobs(user_id, device_id, status);
      CREATE INDEX IF NOT EXISTS idx_activities_user_device
        ON activities(user_id, device_id);
      CREATE INDEX IF NOT EXISTS idx_remote_start_contexts_lookup
        ON remote_start_contexts(user_id, device_id, course_id, client_class_start_date, client_class_end_date, consumed_at);
    `);
  }
}

export function remoteStartContextKey(
  userId: string,
  deviceId: string,
  courseId: string,
  classStartDate: number,
  classEndDate: number
): string {
  return `${userId}:${deviceId}:${courseId}:${classStartDate}:${classEndDate}`;
}

export function pushStartJobKey(userId: string, deviceId: string, courseId: string, classStartDate: number): string {
  return `push_start:${userId}:${deviceId}:${courseId}:${classStartDate}`;
}

export function activityTransitionJobKey(activityId: string, transition: 'start' | 'end'): string {
  return `activity_${transition}:${activityId}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toActivityRecord(row: SqlRow): ActivityRecord {
  return {
    userId: requiredString(row.user_id, 'user_id'),
    deviceId: requiredString(row.device_id, 'device_id'),
    activityId: requiredString(row.activity_id, 'activity_id'),
    pushToken: requiredString(row.push_token, 'push_token'),
    courseName: requiredString(row.course_name, 'course_name'),
    courseId: requiredString(row.course_id, 'course_id'),
    classStartDate: requiredNumber(row.class_start_date, 'class_start_date'),
    classEndDate: requiredNumber(row.class_end_date, 'class_end_date'),
    displayClassStartDate: optionalNumber(row.display_class_start_date),
    displayClassEndDate: optionalNumber(row.display_class_end_date),
    endTransitionDate: optionalNumber(row.end_transition_date),
    dismissalDate: optionalNumber(row.dismissal_date),
    currentPhase: requiredString(row.current_phase, 'current_phase') as ActivityRecord['currentPhase'],
    createdAt: requiredNumber(row.created_at, 'created_at'),
    updatedAt: requiredNumber(row.updated_at, 'updated_at')
  };
}

function toPushToStartTokenRecord(row: SqlRow): PushToStartTokenRecord {
  return {
    userId: requiredString(row.user_id, 'user_id'),
    deviceId: requiredString(row.device_id, 'device_id'),
    token: requiredString(row.token, 'token'),
    serverMinusClientSeconds: requiredNumber(row.server_minus_client_seconds, 'server_minus_client_seconds'),
    registeredAt: requiredNumber(row.registered_at, 'registered_at'),
    updatedAt: requiredNumber(row.updated_at, 'updated_at'),
    active: requiredNumber(row.active, 'active') === 1
  };
}

function toRemoteStartContextRecord(row: SqlRow): RemoteStartContextRecord {
  return {
    key: requiredString(row.context_key, 'context_key'),
    userId: requiredString(row.user_id, 'user_id'),
    deviceId: requiredString(row.device_id, 'device_id'),
    courseId: requiredString(row.course_id, 'course_id'),
    clientClassStartDate: requiredNumber(row.client_class_start_date, 'client_class_start_date'),
    clientClassEndDate: requiredNumber(row.client_class_end_date, 'client_class_end_date'),
    serverClassStartDate: requiredNumber(row.server_class_start_date, 'server_class_start_date'),
    serverClassEndDate: requiredNumber(row.server_class_end_date, 'server_class_end_date'),
    serverEndTransitionDate: optionalNumber(row.server_end_transition_date),
    serverDismissalDate: optionalNumber(row.server_dismissal_date),
    sendStartTransition: requiredNumber(row.send_start_transition, 'send_start_transition') === 1,
    createdAt: requiredNumber(row.created_at, 'created_at'),
    consumedAt: optionalNumber(row.consumed_at)
  };
}

function toScheduledJobRecord(row: SqlRow): ScheduledJobRecord {
  return {
    id: requiredString(row.id, 'id'),
    kind: requiredString(row.kind, 'kind') as ScheduledJobKind,
    status: requiredString(row.status, 'status') as ScheduledJobStatus,
    userId: requiredString(row.user_id, 'user_id'),
    deviceId: requiredString(row.device_id, 'device_id'),
    dueAt: requiredNumber(row.due_at, 'due_at'),
    payload: JSON.parse(requiredString(row.payload_json, 'payload_json')) as unknown,
    attempts: requiredNumber(row.attempts, 'attempts'),
    maxAttempts: requiredNumber(row.max_attempts, 'max_attempts'),
    lockedUntil: optionalNumber(row.locked_until),
    lastError: optionalString(row.last_error),
    apnsStatus: optionalNumber(row.apns_status),
    apnsReason: optionalString(row.apns_reason),
    createdAt: requiredNumber(row.created_at, 'created_at'),
    updatedAt: requiredNumber(row.updated_at, 'updated_at')
  };
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
