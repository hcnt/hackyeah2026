# Attend Now oracle API (v1)

The oracle recognises opted-in attendees on an event camera and triggers their payout. This document is the
contract between the oracle (backend) and its clients: the embeddable widget, the main web app, the event camera
page and the stage screen. Wallet connection is the client's job; the oracle only verifies signatures.

- Base path: `/api/v1`. JSON in and out, UTF-8. Timestamps are ISO 8601 in UTC (`2026-10-04T10:12:03Z`).
- `event_id` is the event account's public key (base58). `wallet` is a Solana public key (base58).
- Images are JPEG, base64-encoded (no `data:` prefix), at most 1280 px on the long side. Request bodies are capped
  at 4 MB.
- CORS: every origin is allowed. There are no cookies; identity comes only from wallet signatures.

## Widget flow

```
event details ──▶ show event + consent text ──yes──▶
open camera ──▶ test (≈2×/s) ──ok──▶ take the photo
                    │                     │
                 issues → show hint       ▼
                             MetaMask signMessage ──▶ submit ──▶ "You're on the list"
```

## Signatures

Calls that act for a wallet carry a signature made with the wallet's `signMessage` (Solana ed25519 over the
UTF-8 bytes of the message below). The signature is base58-encoded.

```
Attend Now
Action: <join | camera-token>
Event: <event_id>
Wallet: <wallet>
Consent: <consent version>          ← only for Action: join
Time: <signed_at>
```

Lines are separated by `\n`, with no trailing newline. The oracle rebuilds this text from the request fields and
rejects the call unless:

1. the signature is valid for `wallet`,
2. `signed_at` is no more than 5 minutes in the past and no more than 1 minute in the future,
3. the same signature has not been used before.

The signed join message is kept as the record of consent until the event's face data is deleted.

## Endpoints

### Event details

`GET /events/{event_id}` — no signature. What a client shows before "I'm going", including the consent text it
must display. Show `consent.text` as given and sign `consent.version`.

`200`:

```json
{
  "event_id": "…",
  "name": "HackYeah Day 2 Opening",
  "venue": "Tauron Arena",
  "organizer": "Hx3d…Qp71",
  "starts_at": "2026-10-04T08:00:00Z",
  "ends_at": "2026-10-04T16:00:00Z",
  "status": "live",
  "joining_open": true,
  "min_seen_secs": 3,
  "reward_lamports": 50000000,
  "max_payouts": 100,
  "going": 37,
  "paid": 21,
  "spots_left": 79,
  "consent": { "version": "2026-10-03", "text": "Use your face to get paid at this event?\n\nWe create …" }
}
```

- `status` is `upcoming`, `live` or `ended`, worked out from the times when the request is made.
- `joining_open` is `true` until the event ends (joining before it starts is allowed).
- `name`, `venue`, `reward_lamports`, `max_payouts` and `spots_left` may be `null` when the event source doesn't
  provide them. 1 SOL = 1 000 000 000 lamports.
- `consent.text` uses `\n` for line breaks; the first line is the heading.

### Test a photo

`POST /events/{event_id}/attendance/test` — no signature. Stateless: nothing is stored.

```json
{ "image": "<base64 JPEG>" }
```

The photo must show one face looking straight at the camera.

`200`:

```json
{
  "ok": false,
  "issues": [{ "code": "too_dark", "message": "Too dark — face a light" }],
  "face": { "bbox": [412.0, 188.5, 590.2, 410.7], "confidence": 0.91, "yaw": 0.03 }
}
```

`face` is `null` when no face was found. `bbox` is `[x1, y1, x2, y2]` in image pixels; `yaw` is negative for left,
positive for right, roughly −0.5…0.5 (straight is within ±0.15). `ok` is `true` exactly when `issues` is empty.

### Submit attendance ("I'm going")

`POST /events/{event_id}/attendance` — signature with `Action: join`.

```json
{
  "wallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "signed_at": "2026-10-04T10:12:03Z",
  "signature": "<base58>",
  "consent": { "version": "2026-10-03", "accepted": true },
  "image": "<base64 JPEG>"
}
```

The photo is checked like `test`. Submitting again for the same wallet replaces the earlier entry. There is no liveness check in this
version: production adds a certified liveness provider in front of submit.

`201`:

```json
{ "status": "on_list", "event_id": "…", "wallet": "…" }
```

A join cannot be cancelled: the entry stays until the event ends. The oracle keeps the signed join message with it
and sends it with every sighting report; the program checks it on chain (`check_join_proof` in contracts/on_sight/lib.rs).

### Status

`GET /events/{event_id}/attendance/{wallet}` — no signature (payouts are public on-chain anyway).

`200`:

```json
{ "status": "not_joined", "tx": null }
```

`status` is `not_joined`, `on_list` or `paid`; `tx` is the payout transaction signature once paid.

### Camera pairing (organizer)

`POST /events/{event_id}/camera-token` — signature with `Action: camera-token`; `wallet` must be the event's
organizer.

```json
{ "wallet": "…", "signed_at": "…", "signature": "<base58>" }
```

`200`:

```json
{ "camera_token": "…", "stage_token": "…", "camera_path": "/camera/…" }
```

The tokens are fixed per event until it ends: calling again returns the same pair, so reloading the stage screen
does not disconnect phones. Build the QR code from `origin + camera_path`.

## WebSockets

### Event camera — `WS /api/v1/camera/{camera_token}`

The phone sends one binary JPEG (≤ 1280 px), waits for the reply, then sends the next.

```json
{ "type": "ack", "faces": 3, "ms": 412 }
{ "type": "error", "message": "not a decodable image" }
```

An `error` reply does not close the socket.

### Stage screen — `WS /api/v1/events/{event_id}/live?stage_token=…`

Server to client only:

```json
{ "type": "frame", "jpeg": "<base64>", "width": 960, "height": 540,
  "faces": [{ "bbox": [x1, y1, x2, y2], "state": "tracking", "name": "7xKX…gAsU", "seen_secs": 2.1 }] }
{ "type": "payout", "wallet": "…", "name": "7xKX…gAsU", "tx": "…", "at": "2026-10-04T10:42:07Z" }
{ "type": "stats", "going": 37, "paid": 21 }
```

- `state` is `unknown`, `tracking` or `paid`. Unknown faces have `name: null` and `seen_secs: 0`; no score or
  identity is ever sent for them.
- Frames arrive at most 5 per second.
- `name` is the attendee's short wallet address (first 4 and last 4 characters); no personal name is collected.
- `payout.name` is always a string.

### Close codes (both sockets)

| Code | Meaning |
|---|---|
| 4401 | Token invalid |
| 4404 | Event not found or ended |

## Errors

Every non-2xx response has the same shape:

```json
{ "error": { "code": "photo_rejected", "message": "Too dark — face a light",
             "issues": [{ "code": "too_dark", "message": "Too dark — face a light" }] } }
```

`issues` is present only for `photo_rejected`.

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_request` | Body malformed or wrong field types |
| 401 | `bad_signature` | Signature does not verify for `wallet` |
| 401 | `signature_expired` | `signed_at` outside the allowed window |
| 401 | `signature_reused` | Signature already used |
| 403 | `not_organizer` | Camera pairing by a wallet that is not the organizer |
| 404 | `event_not_found` | Unknown `event_id` |
| 409 | `event_ended` | Event is over |
| 409 | `face_already_registered` | This face is already registered to another wallet for this event |
| 413 | `too_large` | Body over 4 MB |
| 422 | `consent_required` | `consent.accepted` is not `true` or the version is unknown |
| 422 | `photo_rejected` | The photo failed the photo checks |

## Photo issue codes

| `code` | Default message |
|---|---|
| `no_face` | We can't find a face — look at the camera |
| `multiple_faces` | Make sure only you are in the frame |
| `low_confidence` | We can't see your face clearly |
| `too_small` | Move closer |
| `out_of_frame` | Center your face in the oval |
| `blurry` | Hold still — the photo is blurry |
| `too_dark` | Too dark — face a light |
| `too_bright` | Too bright — move away from the light |
| `wrong_pose` | Look straight at the camera |

Clients may show their own text per `code`; `message` is a ready-to-use default in English.

## TypeScript types

```ts
export type IssueCode =
  | 'no_face' | 'multiple_faces' | 'low_confidence' | 'too_small' | 'out_of_frame'
  | 'blurry' | 'too_dark' | 'too_bright' | 'wrong_pose'
export interface Issue { code: IssueCode; message: string }

export interface TestRequest { image: string }
export interface TestResponse {
  ok: boolean
  issues: Issue[]
  face: { bbox: [number, number, number, number]; confidence: number; yaw: number } | null
}

export interface Signed { wallet: string; signed_at: string; signature: string }
export interface SubmitRequest extends Signed {
  consent: { version: string; accepted: true }
  image: string
}
export interface EventDetails {
  event_id: string
  name: string | null
  venue: string | null
  organizer: string
  starts_at: string
  ends_at: string
  status: 'upcoming' | 'live' | 'ended'
  joining_open: boolean
  min_seen_secs: number
  reward_lamports: number | null
  max_payouts: number | null
  going: number
  paid: number
  spots_left: number | null
  consent: { version: string; text: string }
}

export type AttendanceStatus = 'not_joined' | 'on_list' | 'paid'
export interface StatusResponse { status: AttendanceStatus; tx: string | null }

export interface ApiError {
  error: { code: string; message: string; issues?: Issue[] }
}

export function signedMessage(
  action: 'join' | 'camera-token',
  eventId: string, wallet: string, signedAt: string, consentVersion?: string,
): string {
  return [
    'Attend Now',
    `Action: ${action}`,
    `Event: ${eventId}`,
    `Wallet: ${wallet}`,
    ...(action === 'join' ? [`Consent: ${consentVersion}`] : []),
    `Time: ${signedAt}`,
  ].join('\n')
}
```

## Privacy rules the oracle follows

- Photos are never stored: each image is decoded in memory, turned into a face signature and dropped.
- Face signatures are kept per event, encrypted with a key held only in memory, and destroyed when the event ends
  (a join cannot be cancelled).
- Faces of people who are not on the event's list are discarded immediately and never sent to any client.
- Logs contain only event, wallet, transaction and status — never images or face signatures.
