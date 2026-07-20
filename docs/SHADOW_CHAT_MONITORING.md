# SHADOW Chat production monitoring

This runbook defines the minimum production signals for SHADOW Chat. It does not deploy alerts or contact anyone. Owners must bind the queries to the production telemetry destination and approved notification action group.

## Required alerts

| Signal | Suggested trigger | Severity | Owner |
| --- | ---: | --- | --- |
| Unsafe output or semantic block rate | 3 or more in 5 minutes, or over 2% of responses | Critical | Safety + engineering |
| Critical human-review queue item | Any open critical item older than 2 minutes | Critical | Approved safeguarding owner |
| Authorization failures | 10 per tenant in 5 minutes | High | Security |
| Cross-tenant access attempts | Any confirmed attempt | Critical | Security |
| Model unavailable | Over 5% for 10 minutes | High | Engineering |
| Evidence unavailable | Over 10% for 15 minutes | Medium | Research/data |
| Heavy Bag backlog | Oldest pending job over 5 minutes | High | Engineering |
| Database readiness failure | Any deployment gate failure | Critical | Engineering |
| Token or latency anomaly | Over agreed tenant baseline for 15 minutes | Medium | Engineering |

## Telemetry dimensions

Every chat completion should include correlation ID, organization ID, role, conversation ID, tier, session type, model, prompt and safety-policy versions, evidence status/count, semantic risk/category/mode, schema validity, filtered status, review requirement, and latency/token usage when the provider returns it. Never put message bodies, medical details, secrets, or raw prompts in monitoring dimensions.

## Example PostgreSQL checks

```sql
-- Critical review items waiting for action
select organization_id, count(*) as open_critical, min(created_at) as oldest
from pilot.shadow_human_review_queue
where status = 'open' and severity = 'critical'
group by organization_id;

-- Response health by tenant for the last 15 minutes
select organization_id,
       count(*) as responses,
       count(*) filter (where (dimensions->>'filtered')::boolean) as filtered,
       count(*) filter (where dimensions->>'evidenceStatus' in ('unsupported', 'unavailable')) as evidence_gaps
from pilot.shadow_telemetry_events
where metric_name = 'shadow_chat_response'
  and created_at > now() - interval '15 minutes'
group by organization_id;
```

## Release gate

Before production deployment, run `npm run gate:pilot:shadow-chat-readiness` from `apps/web`, verify the standard Shadow hardening CI is green, confirm alert owners and action groups, and obtain the required legal/privacy/safeguarding approvals.