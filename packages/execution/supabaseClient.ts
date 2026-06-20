import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey);

// Typed interfaces
export interface Participant {
  id: string;
  full_name: string;
  participant_type: string;
  baseline_assessment?: any;
  risk_profile?: any;
}

export interface SessionLog {
  id: string;
  participant_id: string;
  session_date: string;
  intensity_rpe: number;
  skill_focus: string[];
  safety_flags: string[];
  coach_review_status: string;
}
