# PPBF Stamp & Ledger Schema

**Version:** 1.0  
**Status:** P0  
**Purpose:** Canonical data model for every status change and the append-only Continuity Ledger (Layers 23–25).

All stamp actions MUST write a ledger event. The ledger is the single source of truth for history.

---

## 1. Stamp Vocabulary (canonical labels)

| Code              | Display Label   | Color Token          | Typical Actor     | Notes |
|-------------------|-----------------|----------------------|-------------------|-------|
| `CLEARED`         | CLEARED         | `--stamp-cleared`    | Coach, Admin, Med | Positive terminal |
| `HOLD`            | HOLD            | `--stamp-hold`       | Coach, Med        | Temporary pause |
| `RESTRICTED`      | RESTRICTED      | `--stamp-restricted` | Admin, Med        | Access / safety block |
| `ESCALATE`        | ESCALATE        | `--stamp-restricted` | Coach             | Hand-off to higher authority |
| `PRESENT`         | PRESENT         | `--stamp-present`    | Coach, Volunteer  | Attendance |
| `LATE`            | LATE            | `--stamp-hold`       | Coach, Volunteer  | Attendance |
| `ABSENT`          | ABSENT          | `--stamp-neutral`    | System / Coach    | Attendance |
| `START_ROUND`     | START ROUND     | `--brass`            | Coach             | Sparring timer |
| `END_ROUND`       | END ROUND       | `--brass`            | Coach             | Sparring timer |
| `SUBMITTED`       | SUBMITTED       | `--stamp-neutral`    | Athlete, Coach    | Form / log entry |
| `APPROVED`        | APPROVED        | `--stamp-cleared`    | Admin, Board      | Governance |
| `WATCH`           | WATCH           | `--stamp-hold`       | Med, Coach        | Observation flag |
| `PENDING_SYNC`    | PENDING SYNC    | `--stamp-hold`       | System            | Offline queue |

New codes require a design-system update and migration note.

---

## 2. Stamp Event (write model)

Every time a user presses a stamp, the client (or offline queue) emits:

```ts
interface StampEvent {
  /** Client-generated UUID v4 — stable across offline sync */
  clientEventId: string;

  /** Server-assigned after accept (null while pending) */
  serverEventId?: string;

  /** ISO-8601 with offset, original client time (never rewritten) */
  occurredAt: string;

  /** Actor */
  actorUserId: string;
  actorRole: "athlete" | "coach" | "parent" | "admin" | "board" | "volunteer" | "system";
  actorDisplayName: string;          // denormalized for ledger readability

  /** Target */
  targetType: "case" | "athlete" | "pin" | "session" | "round" | "organization" | "document";
  targetId: string;
  targetLabel?: string;              // human-readable, e.g. "J. Rivera · Case #47"

  /** The stamp itself */
  stampCode: string;                 // from vocabulary above
  previousStampCode?: string | null; // for transitions

  /** Context */
  gymId: string;
  sessionId?: string;                // if inside a live session
  deviceId?: string;
  offline: boolean;

  /** Optional free-text note attached to this stamp */
  note?: string;

  /** Extra payload (punch counts, timer duration, etc.) */
  payload?: Record<string, unknown>;
}
```

### Validation rules
- `stampCode` must be in the vocabulary.
- `occurredAt` is client time; server stores both `occurredAt` and `receivedAt`.
- Destructive stamps (`RESTRICTED`, `ESCALATE`) may require a confirmation flag or dual control later.
- Once written, a stamp event is **immutable**. Corrections are new compensating events.

---

## 3. Ledger Entry (read / projection model)

The Continuity Ledger is an append-only projection of stamp events + system events.

```ts
interface LedgerEntry {
  id: string;                        // server ID
  sequence: number;                  // monotonic per gym (or global)
  occurredAt: string;                // original client time
  receivedAt: string;                // server accept time
  gymId: string;

  /** Render-ready mono line */
  summary: string;
  // Example: "14:22  COACH M.  STAMPED CLEARED  Case #47  Athlete: J. Rivera"

  actorUserId: string;
  actorDisplayName: string;
  actorRole: string;

  stampCode?: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;

  note?: string;
  payload?: Record<string, unknown>;

  /** Link back to the raw event */
  sourceEventId: string;
  offlineOrigin: boolean;
}
```

### Rendering rules for `.ledger-tape`
- Always mono.
- Format: `HH:mm  ACTOR  VERB  TARGET  (optional note)`
- Newest entries at the bottom (teletype style) or top — pick one and keep it forever.
- System events (sync, auto-lock, etc.) use actorRole = `system`.

---

## 4. Offline Queue

```ts
interface OfflineStampQueueItem {
  clientEventId: string;
  stampEvent: StampEvent;            // full event with offline: true
  createdAt: string;
  attempts: number;
  lastError?: string;
  status: "pending" | "syncing" | "failed" | "acked";
}
```

**Sync algorithm (simple)**
1. On reconnect, send queue in `occurredAt` order.
2. Server deduplicates by `clientEventId`.
3. On ACK, mark `acked` and remove from local queue.
4. On conflict (target already in terminal state), server returns compensating event; client shows brass plate “CONFLICT — see ledger”.

---

## 5. Permissions Matrix (who may stamp what)

| Stamp Code     | Athlete | Coach | Parent | Admin | Med | Board | Volunteer |
|----------------|---------|-------|--------|-------|-----|-------|-----------|
| CLEARED        |         | ✓     |        | ✓     | ✓   |       |           |
| HOLD           |         | ✓     |        | ✓     | ✓   |       |           |
| RESTRICTED     |         |       |        | ✓     | ✓   |       |           |
| ESCALATE       |         | ✓     |        | ✓     |     |       |           |
| PRESENT / LATE |         | ✓     |        | ✓     |     |       | ✓         |
| START/END ROUND|         | ✓     |        |       |     |       |           |
| SUBMITTED      | ✓       | ✓     |        |       |     |       |           |
| APPROVED       |         |       |        | ✓     |     | ✓     |           |
| WATCH          |         | ✓     |        |       | ✓   |       |           |

Board never stamps individual athletes — only aggregate compliance.

---

## 6. Minimal API Surface (P0)

```
POST   /api/stamps                  // body: StampEvent (or offline batch)
GET    /api/ledger?gymId=&since=    // cursor / sequence based
GET    /api/targets/:type/:id/stamps
POST   /api/stamps/offline-batch    // array of client events
```

All responses return the created `LedgerEntry` (or list) so the UI can append to `.ledger-tape` immediately.

---

## 7. Implementation Notes

- Store raw events in an append-only table (`stamp_events`).
- Project into `ledger_entries` (or materialize on read for small gyms).
- Never UPDATE or DELETE stamp events. Corrections = new events with `previousStampCode`.
- Index: `(gymId, sequence)`, `(targetType, targetId, occurredAt)`, `(clientEventId)` unique.
- Retention: permanent for compliance (or per board policy).

---

**P0 complete when:** TypeScript types exist in the codebase, the two API endpoints accept a stamp and return a ledger entry, and a unit test proves offline deduplication by `clientEventId`.
