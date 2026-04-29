# Security Review

Date: 2026-04-29

Scope: TypeScript Express APNs notification server in this repository.

## Summary

The codebase does not show obvious SQL injection, command injection, or dependency advisory issues. SQL queries are mostly parameterized, TypeScript builds successfully, and `npm audit --audit-level=low` reported `0 vulnerabilities`.

The important risks are API abuse and missing ownership checks. Because this server is intended for a public app, public registration itself is not a vulnerability. The main security question is whether one public user can affect another user's notifications, or make the server do unbounded work.

## Findings

### 1. Missing Per-Device Ownership Checks

Severity: High for public deployment

Current routes accept caller-supplied `userId` and `deviceId`. If those identifiers are known or guessable, a caller can submit requests for another user/device.

Affected examples:

- `POST /push-to-start/schedule`
- `POST /push-to-start/sync-semester`
- `POST /push-to-start/cancel`
- `DELETE /activity/:activityId`

Impact:

- Cancel another device's jobs.
- Replace or overwrite another device's schedules.
- Delete another user's activity registration if the `activityId` is known.

Recommended fix:

- Add an unguessable per-install secret or signed request proof.
- Store only a hash of the secret on the server.
- Require proof for all mutation routes after initial registration.
- Verify that the request's `userId` and `deviceId` match the stored credential.
- For `DELETE /activity/:activityId`, verify that the activity belongs to the authenticated `userId + deviceId`.

### 2. Admin/Inspection Endpoints Are Public When App Auth Is Disabled

Severity: Medium

`APP_AUTH_TOKEN` is optional. That may be acceptable for public registration routes, but not for operational routes.

Affected examples:

- `GET /activities`
- `DELETE /activity/:activityId`
- `POST /push-to-start/full-cycle`
- `/docs` if docs should not be public in production

Impact:

- Exposes activity metadata.
- Allows arbitrary deletion if combined with missing ownership checks.
- Exposes test/development workflows.

Recommended fix:

- Split public routes from admin routes.
- Require admin auth for `GET /activities`.
- Require admin auth or remove `/push-to-start/full-cycle` in production.
- Consider protecting `/docs` in production.

### 3. No Rate Limiting Or Quotas

Severity: Medium/High for public deployment

Public endpoints can be called repeatedly. Even with schedule count caps, repeated requests can grow database state, churn the scheduler, and trigger APNs work.

Affected examples:

- `POST /push-to-start/register`
- `POST /push-to-start/schedule`
- `POST /push-to-start/sync-semester`
- `POST /activity/register`

Impact:

- Database growth.
- Scheduler/APNs retry churn.
- Resource exhaustion.
- Abuse from a single IP or scripted client.

Recommended fix:

- Add IP-based rate limits.
- Add per-`userId + deviceId` rate limits after device registration.
- Add quotas for active jobs per device and per semester.
- Add cleanup for old jobs, consumed remote start contexts, inactive tokens, and ended activities.

### 4. No Explicit Field Length Limits

Severity: Medium

Validation checks that strings are non-empty, but does not limit length.

Affected fields include:

- `userId`
- `deviceId`
- `activityId`
- `courseName`
- `courseId`
- `location`
- `instructor`
- `semester`
- `pushToken`
- `pushToStartToken`

Impact:

- Large SQLite rows.
- Large job IDs.
- Oversized APNs payloads.
- Larger logs and error records.
- Avoidable memory and CPU work.

Recommended fix:

- Add per-field max lengths.
- Use realistic limits, for example:
  - IDs: 128 characters
  - semester: 32 characters
  - course name/location/instructor: 128 characters
  - APNs token hex string: a bounded expected range
- Reject payloads that would exceed APNs payload limits before scheduling.

### 5. Public OpenAPI Docs

Severity: Low if API is intentionally public

The docs bypass app auth. If this API is public by design, this is not automatically a vulnerability. It becomes a concern if admin, inspection, or test endpoints are documented or reachable in production.

Recommended fix:

- Keep docs public only for public routes.
- Hide or protect admin/test routes in production docs.
- Require admin auth for full internal docs.

### 6. Plain String Compare For Global Bearer Token

Severity: Low

The current global token check uses direct string equality. This is lower priority than ownership checks and rate limits.

Recommended fix:

- If keeping a global bearer token for admin routes, compare token bytes with `crypto.timingSafeEqual`.
- Keep admin auth separate from public device auth.

## Recommended Protection Model

Use per-install ownership tokens.

### Registration

On first app launch:

1. Generate a random 32-byte install secret.
2. Store it in the iOS Keychain.
3. Send it during initial device registration.

Example:

```json
{
  "userId": "123",
  "deviceId": "device-uuid",
  "pushToStartToken": "abcdef1234567890",
  "clientUnixTime": 1760000000,
  "installSecret": "base64url-random-secret"
}
```

Server behavior:

- Hash the secret with a password/KDF-style hash or HMAC server pepper.
- Store the hash for `userId + deviceId`.
- Do not store the raw install secret.

### Authenticated Device Requests

For later public mutation routes, require a signed request:

```http
X-User-Id: 123
X-Device-Id: device-uuid
X-Timestamp: 1760000000
X-Signature: hmac_sha256(installSecret, method + path + timestamp + body)
```

Server should reject when:

- Timestamp is outside a short window, for example 5 minutes.
- No active device credential exists.
- Signature does not match.
- Body `userId` or `deviceId` differs from the authenticated headers.

This prevents users from modifying other users' schedules just by knowing identifiers.

## Route Policy

Suggested route classification:

| Route | Policy |
| --- | --- |
| `POST /push-to-start/register` | Public bootstrap, rate-limited. Creates or rotates device credential. |
| `POST /activity/register` | Device-authenticated, verify activity belongs to `userId + deviceId`. |
| `POST /push-to-start/schedule` | Device-authenticated. |
| `POST /push-to-start/sync-semester` | Device-authenticated. |
| `POST /push-to-start/cancel` | Device-authenticated. |
| `DELETE /activity/:activityId` | Device-authenticated and ownership-checked, or admin-only. |
| `GET /activities` | Admin-only or disabled in production. |
| `POST /push-to-start/full-cycle` | Admin/dev-only or disabled in production. |
| `/docs` | Public docs only for public API, otherwise admin-only in production. |

## Implementation Checklist

- Add `device_credentials` table with `user_id`, `device_id`, secret hash, creation time, update time, and active flag.
- Extend `/push-to-start/register` to create or rotate the device credential.
- Add middleware for device HMAC verification.
- Apply device middleware to schedule, sync, cancel, and activity register/delete routes.
- Add an admin-auth middleware separate from device auth.
- Move `GET /activities` and `/push-to-start/full-cycle` behind admin auth.
- Add rate limiting by IP.
- Add rate limiting and quotas by `userId + deviceId`.
- Add string length validation.
- Add retention cleanup for old jobs, old contexts, inactive tokens, and ended activities.
- Add tests for cross-device access denial.

## Verification Performed

Commands run:

```bash
npm run build
npm audit --audit-level=low
```

Results:

- TypeScript build passed.
- npm audit reported `0 vulnerabilities`.
