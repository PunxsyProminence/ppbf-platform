# Claude entrypoint

Read `AGENT_KERNEL.md` first. It is the single default execution contract for this repository.

Do not preload other policy, audit, migration, SHADOW, deployment, or historical documents unless `AGENT_KERNEL.md`, the current ticket, or the files you are changing make that domain relevant.

## SHADOW UI → production (when ticket is P0 / live UI)

If the current ticket is **P0 production** or SHADOW UI ship:

1. Open **`docs/shadow-ui/PRODUCTION-FAST-TRACK.md`**
2. Branch `p0-production`
3. Implement P0.1–P0.6 only; Jason reviews on **deployed URL only**
4. Tagline: **OBSERVE. DECIDE. EXECUTE. REPEAT.**

Also: `docs/shadow-ui/ROOM-PURPOSE-DNA.md`, `P0-LIVE-SHOT-AND-ROOMS.md`, `EGGS-LOAD-FIRST-12.md`.
Issue: #486
