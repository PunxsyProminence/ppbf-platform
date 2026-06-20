-- PPBF Supabase Schema - Core Tables (Aligned with 25-Capability Architecture)

-- Layer 0: Governance & Audit
CREATE TABLE IF NOT EXISTS governance_manifest (
    id SERIAL PRIMARY KEY,
    active_source TEXT NOT NULL,
    last_promotion TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    promoted_by TEXT,
    status TEXT CHECK (status IN ('ACTIVE', 'REVIEW_REQUIRED', 'DRAFT', 'SUPERSEDED', 'ARCHIVE'))
);

-- Core Platform
CREATE TABLE IF NOT EXISTS participant_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id),
    full_name TEXT,
    participant_type TEXT, -- youth, adaptive, AF_SPECOPS, etc.
    baseline_assessment JSONB,
    risk_profile JSONB,
    consent_status BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID REFERENCES participant_profiles(id),
    session_date DATE,
    intensity_rpe INTEGER,
    skill_focus TEXT[],
    reflections TEXT,
    safety_flags TEXT[],
    coach_review_status TEXT
);

-- Routing & Development
CREATE TABLE IF NOT EXISTS development_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID REFERENCES participant_profiles(id),
    goal_intake JSONB,
    assigned_route TEXT, -- e.g., Adaptive, AF_SPECOPS
    task_dimensions JSONB,
    lifecycle_tags TEXT[]
);

-- Enable Row Level Security (RLS)
ALTER TABLE participant_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_logs ENABLE ROW LEVEL SECURITY;

-- Sample RLS Policies (Coach/Admin View)
CREATE POLICY "Coaches can view participants" ON participant_profiles
    FOR SELECT USING (auth.role() = 'coach' OR auth.role() = 'admin');

-- Indexes for Performance
CREATE INDEX idx_participant_type ON participant_profiles(participant_type);
CREATE INDEX idx_session_date ON session_logs(session_date);