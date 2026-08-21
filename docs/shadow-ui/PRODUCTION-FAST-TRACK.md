# PRODUCTION FAST TRACK — P0 to deployed production
**For:** Claude Code in VS Code · Jason reviews **only on live URL**  
**Date:** 19 Aug 2026  
**Tagline:** OBSERVE. DECIDE. EXECUTE. REPEAT.

## Goal
Ship **P0.1–P0.6** to **deployed production**. No mid-loop Jason mock reviews.

## Branch
`p0-production`

## Scope (ONLY this)
| # | Surface | Pass criteria |
|---|---------|----------------|
| P0.1 | The Bell login | Microsoft / Email link / PIN real fields; exact errors; WAIT **brass** not medical-red theater |
| P0.2 | Shadow DENY | Title + body + **Dashboard** + **Logout** only — no library, no mode badge, no chat, no Master Mode |
| P0.3 | Shadow ALLOWED | Scout / Architect / Omega **labels only** — no Master Mode toggle |
| P0.4 | Training Hold | **Brass**, path back, non-punitive |
| P0.5 | Escalations | **Red only** on critical severity; empty copy exact where coded |
| P0.6 | Role landings | `pilotRoleRouting` correct destinations |

**Out of scope:** full catalog polish, new features, Floor Card data model, more AF art, Master Mode.

## Room DNA (no two rooms alike)
| Room | Feel | Eggs |
|------|------|------|
| office | desk, roster, forms | chalk OK |
| floor | brick, train, coach | primary eggs |
| board | formal, aggregate | NEVER + no SHADOW chat |
| file | cork, evidence | NEVER |
| clinic | green-cool care | NEVER; brass holds |
| night | dark SHADOW machine | never on deny |

## Rules
1. Real `ppbf.css` / design-system symbols — mocks are north star only
   (mocks live in Drive: Claude-Instructions / AF set)  
2. Do **not** wait for Jason between P0 items  
3. Do **not** expand past P0  
4. Build must pass (lint/typecheck/test if present)  
5. Staging smoke before production promote  

## Pipeline
1. Create/use branch `p0-production`  
2. Implement P0.1 → P0.6 completely  
3. Build green  
4. Deploy **staging** → smoke click path  
5. Fix until smoke passes  
6. Open PR → merge to main (or prod branch) for **PRODUCTION**  
7. Reply: `READY FOR PRODUCTION` + URL + click path  

## Smoke path (staging then prod)
1. `/` loads  
2. `/login` Bell — one method works; one error path visible  
3. Role lands correctly  
4. Non-privileged `/shadow` → deny minimal only  
5. Coach `/shadow` → labels only, no Master Mode toggle  
6. Logout works  

## Production definition of done
- [ ] Merged to production  
- [ ] Production URL loads  
- [ ] Login works  
- [ ] Shadow deny minimal  
- [ ] Shadow allowed sane  
- [ ] Role landings sane  
- [ ] Jason can click on phone/laptop  

## Rollback only if
- Nobody can log in  
- Wrong people see athlete medical/chat  
- Data corruption  

**Do not rollback for:** spacing, missing eggs, PLANNED pages.

## Jason
Reviews **only after** production (or staging if merge needs his click). Notes → next PR, not block ship.

## Related docs in repo
- `docs/shadow-ui/ROOM-PURPOSE-DNA.md`
- `docs/shadow-ui/P0-LIVE-SHOT-AND-ROOMS.md`
- `docs/shadow-ui/EGGS-LOAD-FIRST-12.md`
- `docs/shadow-ui/PRODUCTION-FAST-TRACK.md` (this file)
