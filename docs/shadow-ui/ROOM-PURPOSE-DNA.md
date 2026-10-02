# ROOM PURPOSE DNA — no two rooms feel alike

> **What this is (OD-2026-10-02-004):** how each room was first drawn, kept as a starting point. Nothing in the UI is tied down, so the "Feel", "Motion", "Copy voice", chrome and easter-egg rows describe the rooms and do not limit a change. Three things below are floor items and do bind, whatever the room looks like: the board room shows aggregates and no athlete detail; `--locked` means a medical stop; nothing playful sits beside a medical hold, a safeguarding matter or a refusal.

> **Scope (2026-09-28):** the six rooms below are today's (`apps/web/components/buildingMap.ts` also files a seventh, `teach`); the target rooms and build order are `docs/ROOM-MAP.md` (OD-2026-09-28-009), and for training rooms (the Floor) how a room looks is `docs/REAL-GYM-REFERENCE-LOCK.md` — where a training room's **Feel** row below disagrees with it, the lock wins; other rooms follow `docs/ROOM-MAP.md`.

**Date:** 19 Aug 2026 · Grok · Jason: each room must feel like its purpose  
**Tagline:** OBSERVE. DECIDE. EXECUTE. REPEAT.

---

## The idea
Every screen sits in one room.  
If two screens feel interchangeable, the difference is better made with tokens and chrome than with more wallpaper.

---

## The six rooms, as first drawn

### 1. Front Office — `.room--office`
| | |
|--|--|
| **Purpose** | Records, families, roster, notices, admin desk work |
| **Feel** | Plank wall, desk lamp, paper forms, riveted cards |
| **Motion** | Forms, tables, invite buttons, “Nobody here yet” |
| **Copy voice** | Clerk / front desk — clear, procedural, kind |
| **Chrome it was drawn with** | Notice banners, photo slots, chalk, roster badges |
| **Kept out when first drawn** | Clinic green, night telemetry, board wainscot, heavy bag floor drama |
| **Easter eggs?** | Yes — chalk/notices/photos. Not medical drama. |

### 2. Gym Floor — `.room--floor`
| | |
|--|--|
| **Purpose** | Training, coaching decisions, wall TV, athlete work |
| **Feel** | Open bags + ring edge + fluorescent (`docs/REAL-GYM-REFERENCE-LOCK.md` §2, §5 — never brick + caged lamps, which the lock forbids), gloves/bags as DNA not clutter |
| **Motion** | Cards by urgency, kiosk big taps, session scripts, drills |
| **Copy voice** | Coach in the corner — short, direct, kid-first |
| **Chrome it was drawn with** | Chalk, WordsOnTheWall, CLEARED badges, floor cards |
| **Kept out when first drawn** | Board tables, file cork, clinic green, night admin console |
| **Easter eggs?** | **Primary home** |

### 3. Board Room — `.room--board`
| | |
|--|--|
| **Purpose** | Governance, aggregate only, seat workspaces |
| **Feel** | Painted wainscot, plaster, dark ink, formal quiet |
| **Motion** | Count tiles, PLANNED tabs, no athlete names |
| **Copy voice** | Fiduciary — calm, aggregate, no gossip |
| **Binds (floor)** | No athlete detail: the board is served aggregates |
| **Kept out when first drawn** | Ask SHADOW chat, floor eggs, clinic red theater |
| **Easter eggs?** | None as drawn |

### 4. File Room — `.room--file`
| | |
|--|--|
| **Purpose** | Evidence, research, knowledge, audit ledger |
| **Feel** | Cork wall, gooseneck lamp, pins, dossiers |
| **Motion** | Queues, Observation→Lesson columns, approve/reject |
| **Copy voice** | Archivist / scientist — precise, sourced, no hype |
| **Easter eggs?** | None as drawn |

### 5. Clinic — `.room--clinic`
| | |
|--|--|
| **Purpose** | Medical clearance, holds, compliance, safeguarding |
| **Feel** | Varnished cabinetry, cooler green-tinted light |
| **Copy voice** | Care + safety — non-punitive, clear path back |
| **Binds (floor)** | `--locked` only for a medical stop (red itself is not reserved, OD-2026-09-29-001); no “tough it out” jokes, wall sayings or banter beside a hold or a safeguarding matter |
| **Chrome it was drawn with** | Brass Training Hold |
| **Easter eggs?** | None (floor item above) |

### 6. After Hours — `.room--night`
| | |
|--|--|
| **Purpose** | SHADOW intelligence, scout, admin console |
| **Feel** | Dark ink ground, low lamp, telemetry |
| **Copy voice** | SHADOW OBSERVED / COACH DECIDES — spare, exact |
| **Binds (floor)** | A denied role is shown a refusal and nothing behind it (no library, no Master Mode toggle); nothing playful on a deny |
| **Chrome it was drawn with** | Mode **labels** only (Scout / Architect / Omega), deny minimal |

## Questions worth asking
| Question | If yes |
|----------|---------|
| Could this screen be mistaken for another room? | Consider whether its tokens and chrome say where the user is |
| Is something playful sitting beside a hold, a safeguarding matter or a refusal? | Remove it (floor item) |
| Does the board show athlete detail? | Remove it (floor item) |

## Shared chrome
Stamp geometry, btn variants, tagline OBSERVE. DECIDE. EXECUTE. REPEAT., SHADOW by Punxsy Prominence naming.
