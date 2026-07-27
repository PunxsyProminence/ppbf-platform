import { query, queryOne } from './db';

export type ShadowFeatureKey =
  | 'strong_personalization'
  | 'auto_library_updates'
  | 'aggressive_research_generation'
  | 'fine_tuning_pipeline';

export type ShadowMetricKey =
  | 'user_high_quality_interactions'
  | 'org_recommendation_outcomes'
  | 'org_resolved_scout_reports'
  | 'org_labeled_training_examples';

export type ActivationMode = 'disabled' | 'observation' | 'enabled';

export interface ShadowFeatureThreshold {
  organizationId: string;
  featureKey: ShadowFeatureKey;
  metricKey: ShadowMetricKey;
  minValue: number;
  activationMode: ActivationMode;
  description: string;
}

export interface ShadowFeatureStatus {
  featureKey: ShadowFeatureKey;
  unlocked: boolean;
  activationMode: ActivationMode;
  satisfied: boolean;
  currentValue: number;
  thresholdValue: number;
  metricKey: ShadowMetricKey;
}

export interface ShadowUnlockState {
  organizationId: string;
  accountId: string;
  evaluatedAt: string;
  features: Record<ShadowFeatureKey, ShadowFeatureStatus>;
}

const DEFAULT_THRESHOLD_CONFIG: Record<ShadowFeatureKey, {
  metricKey: ShadowMetricKey;
  minValue: number;
  activationMode: ActivationMode;
  description: string;
}> = {
  strong_personalization: {
    metricKey: 'user_high_quality_interactions',
    minValue: 20,
    activationMode: 'enabled',
    description: 'Enable deep user-level personalization after enough high-quality interactions.',
  },
  auto_library_updates: {
    metricKey: 'org_recommendation_outcomes',
    minValue: 40,
    activationMode: 'observation',
    description: 'Enable automatic promote/demote updates to SHADOW Library when recommendation outcome volume is adequate.',
  },
  aggressive_research_generation: {
    metricKey: 'org_resolved_scout_reports',
    minValue: 12,
    activationMode: 'observation',
    description: 'Enable stronger research-intake generation once scout reports show mature resolution flow.',
  },
  fine_tuning_pipeline: {
    metricKey: 'org_labeled_training_examples',
    minValue: 500,
    activationMode: 'disabled',
    description: 'Disabled until an approved training-data, evaluation, privacy, fairness, and drift-governance process exists. Human-reviewed event volume alone is not model readiness.',
  },
};

function defaultThresholdRows(organizationId: string): ShadowFeatureThreshold[] {
  return (Object.entries(DEFAULT_THRESHOLD_CONFIG) as Array<[ShadowFeatureKey, typeof DEFAULT_THRESHOLD_CONFIG[ShadowFeatureKey]]>)
    .map(([featureKey, config]) => ({
      organizationId,
      featureKey,
      metricKey: config.metricKey,
      minValue: config.minValue,
      activationMode: config.activationMode,
      description: config.description,
    }));
}

async function ensureThresholdRows(organizationId: string, actorAccountId: string): Promise<void> {
  const existing = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM pilot.shadow_feature_thresholds
     WHERE organization_id = $1`,
    [organizationId],
  );

  const count = Number.parseInt(existing?.count ?? '0', 10);
  if (count > 0) {
    return;
  }

  const rows = defaultThresholdRows(organizationId);
  for (const row of rows) {
    await query(
      `INSERT INTO pilot.shadow_feature_thresholds (
         organization_id, feature_key, metric_key, min_value, activation_mode,
         description, created_by_account_id, updated_by_account_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, NOW(), NOW())
        ON CONFLICT (organization_id, feature_key) DO NOTHING`,
      [
        row.organizationId,
        row.featureKey,
        row.metricKey,
        row.minValue,
        row.activationMode,
        row.description,
        actorAccountId,
      ],
    );
  }
}

async function getThresholdRows(organizationId: string, actorAccountId: string): Promise<ShadowFeatureThreshold[]> {
  await ensureThresholdRows(organizationId, actorAccountId);

  const rows = await query<{
    organization_id: string;
    feature_key: ShadowFeatureKey;
    metric_key: ShadowMetricKey;
    min_value: number;
    activation_mode: ActivationMode;
    description: string;
  }>(
    `SELECT organization_id, feature_key, metric_key, min_value, activation_mode, description
     FROM pilot.shadow_feature_thresholds
     WHERE organization_id = $1`,
    [organizationId],
  );

  return rows.map((row) => ({
    organizationId: row.organization_id,
    featureKey: row.feature_key,
    metricKey: row.metric_key,
    minValue: Number(row.min_value),
    activationMode: row.activation_mode,
    description: row.description,
  }));
}

function parseCount(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

async function collectMetricValues(organizationId: string, accountId: string): Promise<Record<ShadowMetricKey, number>> {
  const [highQualityInteractions, recommendationOutcomes, resolvedScoutReports, labeledTrainingExamples] = await Promise.all([
    queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM pilot.shadow_feedback
       WHERE organization_id = $1
          AND account_id = $2
          AND helpful = true
          AND (rating IS NULL OR rating >= 4)
          AND verification_state IN ('durable_client', 'human_reviewed')
          AND correlation_type = 'shadow_message'
          AND correlation_id IS NOT NULL`,
      [organizationId, accountId],
    ),
    queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM pilot.shadow_learning_events
       WHERE organization_id = $1
         AND verification_state = 'human_reviewed'
         AND outcome_signal IN ('thumbs_up', 'thumbs_down', 'followed_advice', 'ignored_advice', 'asked_followup', 'escalated_to_human')`,
      [organizationId],
    ),
    queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM pilot.shadow_jobs
       WHERE organization_id = $1
          AND job_type = 'scout_report'
          AND status = 'completed'
          AND safety_status = 'passed'
          AND output_payload->>'resultStatus' = 'ok'`,
      [organizationId],
    ),
    queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM pilot.shadow_learning_events
       WHERE organization_id = $1
         AND message_id IS NOT NULL
         AND verification_state = 'human_reviewed'
         AND outcome_signal IN ('thumbs_up', 'thumbs_down', 'followed_advice', 'ignored_advice', 'asked_followup', 'escalated_to_human')`,
      [organizationId],
    ),
  ]);

  return {
    user_high_quality_interactions: parseCount(highQualityInteractions?.count),
    org_recommendation_outcomes: parseCount(recommendationOutcomes?.count),
    org_resolved_scout_reports: parseCount(resolvedScoutReports?.count),
    org_labeled_training_examples: parseCount(labeledTrainingExamples?.count),
  };
}

async function persistSnapshot(
  organizationId: string,
  accountId: string,
  status: ShadowFeatureStatus,
): Promise<void> {
  await query(
    `INSERT INTO pilot.shadow_feature_unlock_snapshots (
       organization_id, account_id, feature_key, metric_key, unlocked,
       activation_mode, satisfied, current_value, threshold_value,
       details, evaluated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (organization_id, account_id, feature_key)
     DO UPDATE SET
       metric_key = EXCLUDED.metric_key,
       unlocked = EXCLUDED.unlocked,
       activation_mode = EXCLUDED.activation_mode,
       satisfied = EXCLUDED.satisfied,
       current_value = EXCLUDED.current_value,
       threshold_value = EXCLUDED.threshold_value,
       details = EXCLUDED.details,
       evaluated_at = NOW()`,
    [
      organizationId,
      accountId,
      status.featureKey,
      status.metricKey,
      status.unlocked,
      status.activationMode,
      status.satisfied,
      status.currentValue,
      status.thresholdValue,
      JSON.stringify({
        metricKey: status.metricKey,
        activationMode: status.activationMode,
      }),
    ],
  );
}

function computeFeatureStatus(
  thresholds: ShadowFeatureThreshold[],
  metrics: Record<ShadowMetricKey, number>,
): Record<ShadowFeatureKey, ShadowFeatureStatus> {
  const defaults = defaultThresholdRows('__placeholder__');
  const result = {} as Record<ShadowFeatureKey, ShadowFeatureStatus>;

  for (const def of defaults) {
    const matching = thresholds.find((row) => row.featureKey === def.featureKey);
    const metricKey = matching?.metricKey ?? def.metricKey;
    const thresholdValue = matching?.minValue ?? def.minValue;
    const activationMode = matching?.activationMode ?? def.activationMode;
    const currentValue = metrics[metricKey] ?? 0;
    const satisfied = currentValue >= thresholdValue;
    const unlocked = activationMode === 'enabled' && satisfied;

    result[def.featureKey] = {
      featureKey: def.featureKey,
      unlocked,
      activationMode,
      satisfied,
      currentValue,
      thresholdValue,
      metricKey,
    };
  }

  return result;
}

export async function evaluateShadowUnlockState(input: {
  organizationId: string;
  accountId: string;
}): Promise<ShadowUnlockState> {
  const thresholds = await getThresholdRows(input.organizationId, input.accountId);
  const metrics = await collectMetricValues(input.organizationId, input.accountId);
  const features = computeFeatureStatus(thresholds, metrics);

  await Promise.all(
    (Object.values(features) as ShadowFeatureStatus[])
      .map((status) => persistSnapshot(input.organizationId, input.accountId, status)),
  );

  return {
    organizationId: input.organizationId,
    accountId: input.accountId,
    evaluatedAt: new Date().toISOString(),
    features,
  };
}

export function isFeatureEnabled(
  unlockState: ShadowUnlockState,
  featureKey: ShadowFeatureKey,
): boolean {
  return unlockState.features[featureKey]?.unlocked ?? false;
}

export interface ShadowUnlockHint {
  featureKey: ShadowFeatureKey;
  unlocked: boolean;
  progress: number; // 0-1, current metric value relative to its threshold
  closeToUnlocking: boolean;
}

const CLOSE_TO_UNLOCKING_PROGRESS = 0.8;

// Trimmed, client-safe projection of unlock state -- omits metricKey/
// activationMode/raw currentValue/thresholdValue, which are internal
// operational detail, not something to surface in a chat response.
export function buildShadowUnlockHints(unlockState: ShadowUnlockState | null): ShadowUnlockHint[] | undefined {
  if (!unlockState) {
    return undefined;
  }

  return (Object.values(unlockState.features) as ShadowFeatureStatus[]).map((status) => {
    const progress = status.thresholdValue > 0
      ? Math.min(1, Math.max(0, status.currentValue / status.thresholdValue))
      : (status.satisfied ? 1 : 0);

    return {
      featureKey: status.featureKey,
      unlocked: status.unlocked,
      progress,
      closeToUnlocking: !status.unlocked && progress >= CLOSE_TO_UNLOCKING_PROGRESS,
    };
  });
}

export async function listShadowThresholds(organizationId: string, accountId: string): Promise<ShadowFeatureThreshold[]> {
  return getThresholdRows(organizationId, accountId);
}

export async function updateShadowThreshold(input: {
  organizationId: string;
  actorAccountId: string;
  featureKey: ShadowFeatureKey;
  metricKey: ShadowMetricKey;
  minValue: number;
  activationMode: ActivationMode;
  description?: string;
}): Promise<void> {
  await query(
    `INSERT INTO pilot.shadow_feature_thresholds (
       organization_id, feature_key, metric_key, min_value, activation_mode,
       description, created_by_account_id, updated_by_account_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, NOW(), NOW())
     ON CONFLICT (organization_id, feature_key)
     DO UPDATE SET
       metric_key = EXCLUDED.metric_key,
       min_value = EXCLUDED.min_value,
       activation_mode = EXCLUDED.activation_mode,
       description = EXCLUDED.description,
       updated_by_account_id = EXCLUDED.updated_by_account_id,
       updated_at = NOW()`,
    [
      input.organizationId,
      input.featureKey,
      input.metricKey,
      Math.max(0, Math.floor(input.minValue)),
      input.activationMode,
      input.description ?? DEFAULT_THRESHOLD_CONFIG[input.featureKey].description,
      input.actorAccountId,
    ],
  );
}
