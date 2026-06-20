-- PPBF Supabase Schema v1.1 (Full)
CREATE TABLE governance_manifest (id SERIAL PRIMARY KEY, active_source TEXT, status TEXT);
CREATE TABLE participant_profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), full_name TEXT, participant_type TEXT, baseline JSONB, risk JSONB);
CREATE TABLE session_logs (id UUID PRIMARY KEY, participant_id UUID, session_date DATE, intensity_rpe INT, skill_focus TEXT[], safety_flags TEXT[]);
CREATE TABLE development_routes (id UUID PRIMARY KEY, participant_id UUID, goal_intake JSONB, assigned_route TEXT, task_dimensions JSONB, lifecycle_tags TEXT[]);
ALTER TABLE participant_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_logs ENABLE ROW LEVEL SECURITY;