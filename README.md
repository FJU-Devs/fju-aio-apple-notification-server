# apple-server

Minimal Node.js + TypeScript Express server for ActivityKit Live Activity remote updates via raw APNs HTTP/2.

## Features

- `POST /activity/register` to register or replace a persisted Live Activity record
- `POST /push-to-start/register` to store push-to-start tokens per user/device
- `POST /push-to-start/schedule` to upsert durable scheduled jobs per user/device/course/start time
- `POST /push-to-start/cancel` to cancel future jobs for a user/device
- `DELETE /activity/:activityId` to remove a persisted registration and cancel jobs
- `GET /activities` to inspect current registrations with redacted token previews
- Stores ActivityKit tokens, active registrations, scheduled jobs, retry state, APNs failures, and clock offsets in SQLite
- Polls persisted due jobs and retries transient APNs/network failures with backoff
- Uses APNs token-based `.p8` authentication with a manually signed JWT
- Uses raw `node:http2` requests, not `node-apn`

## Requirements

- Node.js 22.5+ for built-in SQLite support
- APNs Auth Key (`.p8`)
- Live Activity topic:
  - `com.nelsongx.apps.fju-aio.push-type.liveactivity`

## Environment Variables

Copy `.env.example` to `.env` and update values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | no | HTTP server port, defaults to `3000` |
| `APNS_KEY_ID` | yes | Apple APNs key ID |
| `APNS_TEAM_ID` | yes | Apple Developer team ID |
| `APNS_KEY_PATH` | yes | Absolute path to the APNs `.p8` file |
| `APNS_TOPIC` | yes | Live Activity topic, e.g. `com.nelsongx.apps.fju-aio.push-type.liveactivity` |
| `APNS_USE_SANDBOX` | no | Set `true` for sandbox APNs |
| `LOG_LEVEL` | no | Set to `debug` for detailed request, scheduler, and APNs logs |
| `DATABASE_PATH` | no | SQLite database path, defaults to `./data/apple-notification.sqlite` |
| `APP_AUTH_TOKEN` | no | If set, protected endpoints require `Authorization: Bearer <token>` |
| `SCHEDULER_POLL_MS` | no | Scheduler polling interval, defaults to `250` |
| `SCHEDULER_BATCH_SIZE` | no | Max jobs claimed per poll, defaults to `25` |
| `SCHEDULER_LOCK_SECONDS` | no | Processing lock timeout for crashed workers, defaults to `60` |

## Install

```bash
npm install
```

## Run

Development:

```bash
npm run dev
```

Build and start:

```bash
npm run build
npm start
```

## API

Interactive API documentation is available at `/docs`.

The raw OpenAPI document is served at `/docs/openapi.json`.

### `POST /activity/register`

Registers or replaces a single Live Activity entry in SQLite.

Request body must contain **exactly** these fields:

- `activityId`
- `userId`
- `deviceId`
- `pushToken`
- `courseName`
- `courseId`
- `classStartDate`
- `classEndDate`

Example:

```json
{
  "userId": "111111111",
  "deviceId": "8D6B8C7E-8143-46E6-B61F-8E4E4C853111",
  "activityId": "6D56B540-30F0-4B4A-9D78-7EE9802A741D",
  "pushToken": "abcdef1234567890",
  "courseName": "資料庫系統",
  "courseId": "CS401",
  "classStartDate": 1760000400,
  "classEndDate": 1760007600
}
```

Validation rules:

- all string fields must be non-empty strings
- `pushToken` must be a hex-encoded string with an even number of characters
- `classStartDate` and `classEndDate` must be Unix timestamps in seconds
- `classEndDate` must be greater than `classStartDate`
- `classStartDate` and `classEndDate` must be within 24.8 days of the current server time

Response:

```json
{
  "activityId": "6D56B540-30F0-4B4A-9D78-7EE9802A741D",
  "currentPhase": "before",
  "classStartDate": 1760000400,
  "classEndDate": 1760007600
}
```

### `DELETE /activity/:activityId`

Deletes a registration and cancels pending persisted jobs for that activity.

### `GET /activities`

Returns current persisted registrations with redacted token previews.

### `POST /push-to-start/register`

Stores the push-to-start token for one user/device and records the server/client clock offset.

### `POST /push-to-start/schedule`

Upserts future push-to-start jobs. The stable dedupe key is:

```text
userId + deviceId + courseId + classStartDate
```

### `POST /push-to-start/cancel`

Cancels future queued/processing/failed jobs for one user/device. Pass `deactivateToken: true` when notifications are disabled or the user logs out.

## APNs Behavior

This server sends to APNs path:

```text
/3/device/{pushToken}
```

Headers used:

- `authorization: bearer <jwt>`
- `apns-push-type: liveactivity`
- `apns-topic: <APNS_TOPIC>`

At `classStartDate` it sends an APNs `update` event with content state:

```json
{
  "phase": "during",
  "classStartDate": 1760000400,
  "classEndDate": 1760007600
}
```

At `classEndDate` it sends:

1. an APNs `update` event with `phase: "ended"` and no alert, so the Live Activity can transition quietly
2. an APNs `end` event with `phase: "ended"` and the final alert

The final `end` payload includes the user-visible alert title/body, and `aps.timestamp` always uses current Unix seconds.

## iOS-side changes required

Your iOS app and widget must already support Live Activities for these bundle IDs:

- App bundle ID: `com.nelsongx.apps.fju-aio`
- Widget bundle ID: `com.nelsongx.apps.fju-aio.CourseWidget`

Required client flow:

1. Start the Live Activity locally with push support:

   ```swift
   let activity = try Activity<CourseActivityAttributes>.request(
       attributes: attributes,
       contentState: initialState,
       pushType: .token
   )
   ```

2. Observe `pushTokenUpdates` and convert the token data to a hex string.

3. Use the actual ActivityKit `activity.id` as `activityId`, then POST the token and schedule data to this server using `/activity/register`.

4. When the Live Activity is ended locally or no longer needed, call:

   ```text
   DELETE /activity/{activityId}
   ```

5. Keep the `CourseActivityAttributes` model exactly:

   ```swift
   struct CourseActivityAttributes: ActivityAttributes {
       let courseName: String
       let location: String
       let instructor: String

       struct ContentState: Codable, Hashable {
           var phase: CoursePhase
           var classStartDate: Date
           var classEndDate: Date
       }
   }

   enum CoursePhase: String, Codable, Hashable {
       case before, during, ended
   }
   ```

   The server payload must still encode `content-state.phase` as `before | during | ended`, and `classStartDate` / `classEndDate` should be sent as Unix timestamps so they decode into the `Date` fields above.

6. Make sure the iOS target and widget extension are configured for Live Activities before expecting remote updates to work:

   - enable the Live Activities capability for the app and widget targets
   - set `NSSupportsLiveActivities` in the relevant Info.plist
   - keep push notifications enabled for the app that creates the activity

## Project structure

```text
.
├── .env.example
├── package.json
├── README.md
├── src
│   ├── apns.ts
│   ├── config.ts
│   ├── logger.ts
│   ├── scheduler.ts
│   ├── server.ts
│   ├── store.ts
│   └── types.ts
└── tsconfig.json
```
