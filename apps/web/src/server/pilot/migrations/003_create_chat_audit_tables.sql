-- Migration: Create chat audit tables for coach, athlete, board, and individual chats
-- Executed after SHADOW chat audit table exists

-- Coach chat audit table
CREATE TABLE IF NOT EXISTS pilot.coach_chat_audit (
  coach_chat_audit_id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  coach_id UUID NOT NULL,
  athlete_id UUID,
  message TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_coach_chat_org FOREIGN KEY (organization_id) REFERENCES pilot.organizations(organization_id),
  CONSTRAINT fk_coach_chat_coach FOREIGN KEY (coach_id) REFERENCES pilot.accounts(account_id),
  CONSTRAINT fk_coach_chat_athlete FOREIGN KEY (athlete_id) REFERENCES pilot.accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_coach_chat_audit_org_created ON pilot.coach_chat_audit(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coach_chat_audit_coach_created ON pilot.coach_chat_audit(coach_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coach_chat_audit_athlete_created ON pilot.coach_chat_audit(athlete_id, created_at DESC);

-- Athlete chat audit table
CREATE TABLE IF NOT EXISTS pilot.athlete_chat_audit (
  athlete_chat_audit_id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  athlete_id UUID NOT NULL,
  message TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_athlete_chat_org FOREIGN KEY (organization_id) REFERENCES pilot.organizations(organization_id),
  CONSTRAINT fk_athlete_chat_athlete FOREIGN KEY (athlete_id) REFERENCES pilot.accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_athlete_chat_audit_org_created ON pilot.athlete_chat_audit(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_athlete_chat_audit_athlete_created ON pilot.athlete_chat_audit(athlete_id, created_at DESC);

-- Board chat audit table
CREATE TABLE IF NOT EXISTS pilot.board_chat_audit (
  board_chat_audit_id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  board_member_id UUID NOT NULL,
  message TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_board_chat_org FOREIGN KEY (organization_id) REFERENCES pilot.organizations(organization_id),
  CONSTRAINT fk_board_chat_member FOREIGN KEY (board_member_id) REFERENCES pilot.accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_board_chat_audit_org_created ON pilot.board_chat_audit(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_chat_audit_member_created ON pilot.board_chat_audit(board_member_id, created_at DESC);

-- Individual chat audit table
CREATE TABLE IF NOT EXISTS pilot.individual_chat_audit (
  individual_chat_audit_id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL,
  message TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_individual_chat_org FOREIGN KEY (organization_id) REFERENCES pilot.organizations(organization_id),
  CONSTRAINT fk_individual_chat_user FOREIGN KEY (user_id) REFERENCES pilot.accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_individual_chat_audit_org_created ON pilot.individual_chat_audit(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_individual_chat_audit_user_created ON pilot.individual_chat_audit(user_id, created_at DESC);
