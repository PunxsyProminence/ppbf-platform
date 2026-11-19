-- ---------------------------------------------------------------------------
-- The contact_medical_clearance gate's lesson names the Clearance Board.
--
-- OWNER DECISION. Jason's card OW25-45 (2026-11-19), his answer verbatim:
-- "B: Coaches and the office" -- "Both set it, on the Clearance Board, and the
-- words say so." The Set Status control moved from the Decision Loop's Medical
-- Administrative Status panel to the Clearance Board (lane SH, PR SH-2). The
-- gate's stored lesson still told people to "Set status to 'cleared' in the
-- Medical Status panel", a panel that no longer sets anything; the athlete's
-- sparring log shows that lesson after contact is logged with no clearance on
-- file. Overwatch (2026-11-19) ruled this update into SH-2, with the wording
-- "Set the athlete's clearance on the Clearance Board (a coach or the office)."
--
-- WHAT THIS DOES. One UPDATE of pilot.safety_gates.requirement_text (and its
-- updated_at), for gate_key 'contact_medical_clearance' only, and ONLY where
-- the stored text is still exactly the old seed string, byte for byte. A gym
-- that edited its own lesson keeps its own words. No other column, gate or
-- table is touched. The new seed text is the same string safetyGateSeeds.ts
-- and the safety-gate-matrix migration now insert for a new gym.
--
-- IDEMPOTENT. After one run no row holds the old string, so a re-run updates
-- nothing; a database with no such row (or no table) is left as it is.
-- ---------------------------------------------------------------------------

do $$
declare
  old_lesson constant text :=
    'This athlete needs an explicit ''cleared'' medical administrative status on file before taking contact. Set status to ''cleared'' in the Medical Status panel once a clearance decision has been made; the observation is kept either way, and contact logged without a current clearance raises a near miss for coach/admin review.';
  new_lesson constant text :=
    'This athlete needs an explicit ''cleared'' medical administrative status on file before taking contact. Set the athlete''s clearance on the Clearance Board (a coach or the office) once a clearance decision has been made; the observation is kept either way, and contact logged without a current clearance raises a near miss for coach/admin review.';
begin
  if to_regclass('pilot.safety_gates') is null then
    raise exception 'CONTACT_CLEARANCE_LESSON_NOT_READY: pilot.safety_gates does not exist -- apply the safety gate matrix migration first';
  end if;

  update pilot.safety_gates
     set requirement_text = new_lesson,
         updated_at = now()
   where gate_key = 'contact_medical_clearance'
     and requirement_text = old_lesson;
end $$;
