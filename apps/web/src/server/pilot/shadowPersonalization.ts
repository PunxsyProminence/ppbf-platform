// Personal SHADOW personalization engine
// Builds role-specific system prompts that incorporate user's SHADOW context

import { getOrCreateShadowUserProfile, buildUserShadowContext } from './shadowUserProfile';
import { query } from './db';
import type { PilotRole } from './contracts';

export interface PersonalShadowPrompt {
  systemPrompt: string;
  userContext: string;
}

// ─── Role-Specific Personal SHADOW Prompts ────────────────────────────────

const COACH_PERSONAL_SHADOW = `You are a personalized AI coaching assistant (SHADOW Coach) tailored specifically to THIS COACH's development philosophy and athlete portfolio.

Your role:
- Understand this coach's coaching style, athlete management patterns, and program philosophy
- Provide coaching strategies that align with their approach
- Analyze their specific athletes' patterns and progression
- Offer practical, actionable recommendations for the athletes they manage
- Support evidence-based training methodologies and athlete development
- Help this coach optimize their program based on real athlete data and outcomes

Remember: You are THIS COACH's personal AI assistant - your advice should be tailored to their coaching context, not generic coaching advice.

Safety: If asked about medical diagnosis or treatment, redirect to medical professionals. Always prioritize athlete safety and wellbeing.`;

const ATHLETE_PERSONAL_SHADOW = `You are a personalized AI training assistant (SHADOW Athlete) created specifically for THIS ATHLETE's development journey.

Your role:
- Understand this athlete's personal goals, strengths, weaknesses, and progression path
- Provide training guidance tailored to their specific situation and aspirations
- Help them understand their performance data and what it means for their progress
- Offer mindset support and encouragement for their athletic development
- Suggest practical next steps aligned with their personal goals
- Keep explanations clear, direct, and motivational

Remember: You are THIS ATHLETE's personal AI companion - your advice is specifically for them, based on their unique path and challenges.

Safety: If anything feels physically wrong or you have health concerns, talk to your coach or doctor. You come first.`;

const BOARD_PERSONAL_SHADOW = `You are a personalized AI governance assistant (SHADOW Board) for THIS BOARD MEMBER's organization oversight responsibilities.

Your role:
- Support governance, policy, and compliance decision-making
- Provide strategic insights on organizational health and patterns
- Help analyze data for board-level decision making
- Support compliance monitoring and policy effectiveness review
- Identify organizational trends and opportunities
- Support evidence-based governance

Remember: You are THIS BOARD MEMBER's personal governance AI - your insights support their board responsibilities.

Safety: Always recommend legal/compliance review for significant decisions. Governance must remain transparent and accountable.`;

const INDIVIDUAL_PERSONAL_SHADOW = `You are a personalized family engagement assistant (SHADOW Family) created specifically for THIS PARENT/GUARDIAN's involvement in their youth athlete's development.

Your role:
- Help you understand your athlete's development journey and progress
- Provide insights on how you can best support your young athlete
- Offer guidance on family engagement in youth athletics
- Answer questions about youth athletic development and safety
- Help you stay informed and connected to your athlete's journey
- Keep everything age-appropriate and safety-focused

Remember: You are THIS FAMILY's personal AI companion - your role is to help you support and understand your young athlete.

Safety: Always prioritize youth safety and wellbeing. Recommend professional support (coaches, sports medicine, counselors) for specialized needs.`;

// ─── Build Personal SHADOW Prompt for User ────────────────────────────────

export async function buildPersonalShadowPrompt(
  accountId: string,
  organizationId: string,
  role: PilotRole,
  userQuery = '',
): Promise<PersonalShadowPrompt> {
  try {
    // Load or create user's SHADOW profile
    const profile = await getOrCreateShadowUserProfile(accountId, organizationId, role);
    
    // Build contextualized user insights
    const userContext = buildUserShadowContext(profile, userQuery);

    // Select role-specific base prompt
    const rolePrompts: Record<PilotRole, string> = {
      coach: COACH_PERSONAL_SHADOW,
      athlete: ATHLETE_PERSONAL_SHADOW,
      organization_admin: BOARD_PERSONAL_SHADOW,
      admin: BOARD_PERSONAL_SHADOW,
      parent: INDIVIDUAL_PERSONAL_SHADOW,
      volunteer: INDIVIDUAL_PERSONAL_SHADOW,
      staff: INDIVIDUAL_PERSONAL_SHADOW,
      platform_owner: BOARD_PERSONAL_SHADOW,
    };

    const basePrompt = rolePrompts[role] || COACH_PERSONAL_SHADOW;

    // Combine base prompt + user context
    const systemPrompt = `${basePrompt}${userContext}`;

    return {
      systemPrompt,
      userContext,
    };
  } catch (error) {
    console.error('Failed to build personal SHADOW prompt:', error);
    // Fallback to basic role prompt
    const rolePrompts: Record<PilotRole, string> = {
      coach: COACH_PERSONAL_SHADOW,
      athlete: ATHLETE_PERSONAL_SHADOW,
      organization_admin: BOARD_PERSONAL_SHADOW,
      admin: BOARD_PERSONAL_SHADOW,
      parent: INDIVIDUAL_PERSONAL_SHADOW,
      volunteer: INDIVIDUAL_PERSONAL_SHADOW,
      staff: INDIVIDUAL_PERSONAL_SHADOW,
      platform_owner: BOARD_PERSONAL_SHADOW,
    };
    return {
      systemPrompt: rolePrompts[role] || COACH_PERSONAL_SHADOW,
      userContext: '',
    };
  }
}

// ─── Get Assigned Entities for Role (for context loading) ────────────────

export async function getCoachAssignedAthletes(
  coachAccountId: string,
  organizationId: string,
): Promise<Array<{ athlete_id: string; full_name: string }>> {
  try {
    const rows = await query(
      `SELECT athlete_id, full_name FROM pilot.athletes
       WHERE coach_id = $1 AND organization_id = $2 AND active_flag = true
       ORDER BY full_name ASC`,
      [coachAccountId, organizationId],
    );
    return rows as Array<{ athlete_id: string; full_name: string }>;
  } catch (error) {
    console.error('Failed to get coach assigned athletes:', error);
    return [];
  }
}

export async function getAthleteGoals(
  athleteId: string,
  organizationId: string,
): Promise<Array<{ goal_id: string; title: string; status: string; target_date: string }>> {
  try {
    const rows = await query(
      `SELECT goal_id, title, status, target_date FROM pilot.goals
       WHERE athlete_id = $1 AND organization_id = $2
       ORDER BY target_date DESC`,
      [athleteId, organizationId],
    );
    return rows as Array<{ goal_id: string; title: string; status: string; target_date: string }>;
  } catch (error) {
    console.error('Failed to get athlete goals:', error);
    return [];
  }
}

export async function getAthleteRecentSessions(
  athleteId: string,
  organizationId: string,
  limit = 5,
): Promise<Array<{ session_id: string; date: string; rpe: number; notes: string }>> {
  try {
    const rows = await query(
      `SELECT session_id, date, rpe, notes FROM pilot.sessions
       WHERE athlete_id = $1 AND organization_id = $2 AND completed_flag = true
       ORDER BY date DESC
       LIMIT $3`,
      [athleteId, organizationId, limit],
    );
    return rows as Array<{ session_id: string; date: string; rpe: number; notes: string }>;
  } catch (error) {
    console.error('Failed to get athlete recent sessions:', error);
    return [];
  }
}

export async function getParentAssignedAthletes(
  parentId: string,
  organizationId: string,
): Promise<Array<{ athlete_id: string; full_name: string }>> {
  try {
    const rows = await query(
      `SELECT a.athlete_id, a.full_name
       FROM pilot.athletes a
       JOIN pilot.guardian_links gl ON a.organization_id = gl.organization_id AND a.athlete_id = gl.athlete_id
       WHERE gl.parent_id = $1 AND a.organization_id = $2 AND a.active_flag = true
       ORDER BY a.full_name ASC`,
      [parentId, organizationId],
    );
    return rows as Array<{ athlete_id: string; full_name: string }>;
  } catch (error) {
    console.error('Failed to get parent assigned athletes:', error);
    return [];
  }
}
