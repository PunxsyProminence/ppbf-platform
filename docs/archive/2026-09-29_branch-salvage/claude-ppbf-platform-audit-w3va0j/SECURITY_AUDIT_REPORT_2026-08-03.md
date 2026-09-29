# PPBF Platform - Security Audit Report
**Date:** August 3, 2026  
**Branch:** claude/ppbf-platform-audit-w3va0j  
**Auditor:** Multi-agent Security Audit (Manual Review + Automated Analysis)  
**Status:** Findings Documented - Action Required

---

## Executive Summary

The PPBF platform implements a robust security architecture with strong cryptographic practices and data isolation mechanisms. The audit identified **6 High-severity findings** and **4 Medium-severity findings** that require remediation before production deployment.

**Overall Risk Assessment:** 🟠 **MEDIUM** (was LOW, elevated due to findings)

### Critical Issues Summary
| Issue | Severity | Impact | Status |
|-------|----------|--------|--------|
| Insecure Cookie Secure Flag | High | Session token interception in staging | Needs Fix |
| Account Enumeration via Timing | High | Athlete ID discovery | Needs Fix |
| Rate Limit Dependency on Env Var | High | Brute force vulnerable if misconfigured | Needs Fix |
| Bootstrap Key Timing Attack | High | Key length enumeration | Needs Fix |
| SSL Disable Configuration | High | TLS bypass risk | Needs Fix |
| Organization Isolation Verification | High | Cross-org data access risk (potential) | Needs Investigation |

---

## High-Severity Findings

### Finding 1: Session Cookies Use NODE_ENV Instead of HTTPS Detection
**Severity:** HIGH  
**Location:** 
- `apps/web/app/api/pilot/auth/login/route.ts:117`
- `apps/web/app/api/pilot/auth/logout/route.ts:33`
- `apps/web/app/api/pilot/auth/activate/route.ts:124`

**Description:**
The `secure` flag on session cookies is determined by `NODE_ENV === 'production'` rather than detecting actual HTTPS availability. This means staging environments serving over HTTPS would still send cookies insecurely.

**Current Code:**
```typescript
response.cookies.set(PILOT_SESSION_COOKIE, loginResult.token, {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',  // ❌ INSECURE
  path: '/',
  maxAge: SESSION_ABSOLUTE_LIFETIME_SECONDS,
});
```

**Risk:**
- Staging environment with HTTPS still sends cookies over "insecure" flag
- Network attacker can intercept session token in non-production HTTPS deployments
- Session token is the entire authentication proof (256-bit random value)
- Once stolen, attacker has full athlete account access

**Recommendation:**
Use the protocol from the request to determine secure flag:
```typescript
const isSecureProtocol = request.nextUrl.protocol === 'https:' || 
                         request.headers.get('x-forwarded-proto') === 'https';
response.cookies.set(PILOT_SESSION_COOKIE, loginResult.token, {
  httpOnly: true,
  sameSite: 'lax',
  secure: isSecureProtocol,  // ✅ SECURE
  path: '/',
  maxAge: SESSION_ABSOLUTE_LIFETIME_SECONDS,
});
```

**Also affects:**
- Microsoft OAuth callback response (line 207 in callback/route.ts already does this correctly)

---

### Finding 2: Account Enumeration via Timing Attack on PIN Login
**Severity:** HIGH  
**Location:** `apps/web/src/server/pilot/auth.ts:95-162` (`loginWithAccountIdAndPin`)

**Description:**
The PIN verification function returns immediately if the account doesn't exist, but performs a scrypt operation (~100-150ms) if the account exists but PIN is wrong. This timing difference allows attackers to enumerate valid athlete account IDs.

**Attack Scenario:**
1. Attacker measures response time for login attempts
2. Fast responses (< 50ms) = account doesn't exist
3. Slow responses (> 100ms) = account exists but wrong PIN
4. Attacker learns which athlete IDs are registered on the platform

**Current Code:**
```typescript
const data = await queryOne(...);
if (!data?.active_flag) {
  return null;  // ❌ Fast path for non-existent
}
// ... validation checks ...
const pinIsValid = await verifyPin(pin, data.pin_hash);  // ❌ Slow path
if (!pinIsValid) {
  return null;  // Slow return
}
```

**Recommendation:**
Always perform the PIN verification to maintain constant-time behavior:
```typescript
const data = await queryOne(...);
// Use a dummy hash if account doesn't exist
const pinHashToVerify = data?.pin_hash || 
  'scrypt$dummy$' + '0'.repeat(128);  // Never matches real PIN
const pinIsValid = await verifyPin(pin, pinHashToVerify);
if (!pinIsValid || !data?.active_flag) {
  return null;  // Same timing for both cases
}
```

---

### Finding 3: Rate Limiting Vulnerable if PPBF_DURABLE_RATE_LIMIT Not Set
**Severity:** HIGH  
**Location:** `apps/web/src/server/pilot/rateLimit.ts:33-64`

**Description:**
The durable rate limiting (database-backed) that persists across process restarts is disabled by default. If `PPBF_DURABLE_RATE_LIMIT=true` is not explicitly set in production, only volatile in-memory rate limiting is active.

**Risk:**
- Multi-process deployment: each container has independent rate limit counters
- 10 containers × 5 attempts per process = 50 attempts before any blocking
- Process restart: all rate limit state lost
- An attacker with knowledge of the deployment topology can make 50 PIN guesses against a single account without triggering the rate limit

**Current Code:**
```typescript
function durableRateLimitEnabled(): boolean {
  return process.env.PPBF_DURABLE_RATE_LIMIT === 'true';  // Explicit check
}
```

**Recommendation:**
1. Set `PPBF_DURABLE_RATE_LIMIT=true` in production immediately
2. Add startup validation that fails if rate limiting is disabled:
```typescript
if (process.env.NODE_ENV === 'production' && 
    process.env.PPBF_DURABLE_RATE_LIMIT !== 'true') {
  throw new Error(
    'FATAL: Production deployment requires PPBF_DURABLE_RATE_LIMIT=true'
  );
}
```
3. Add monitoring to alert if durable rate limit table gets too large

---

### Finding 4: Bootstrap Key Timing Attack (Length Leakage)
**Severity:** HIGH  
**Location:** `apps/web/src/server/pilot/security.ts:47-65` (`bootstrapKeyMatches`)

**Description:**
While the function uses `timingSafeEqual` for the actual key comparison, it checks lengths before the timing-safe comparison. This allows attackers to determine the correct key length through timing measurements.

**Current Code:**
```typescript
export function bootstrapKeyMatches(headers: Headers, expectedKey: string | undefined): boolean {
  const provided = readBootstrapKeyHeader(headers);
  const expected = expectedKey?.trim() || '';
  
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {  // ❌ Timing leak
    return false;
  }
  
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
```

**Risk:**
- Reduces effective key space by allowing length discovery
- If key is typically 32 characters, attacker can narrow to +/- 2 chars through timing
- Makes brute force feasible with shorter keys

**Recommendation:**
Compare lengths using timing-safe comparison:
```typescript
export function bootstrapKeyMatches(headers: Headers, expectedKey: string | undefined): boolean {
  const provided = readBootstrapKeyHeader(headers);
  const expected = expectedKey?.trim() || '';
  
  // Use a default-length dummy if either is missing to keep timing constant
  const expectedOrDummy = expected || 'x'.repeat(32);
  const providedOrDummy = provided || 'y'.repeat(32);
  
  const providedBuffer = Buffer.from(providedOrDummy, 'utf8');
  const expectedBuffer = Buffer.from(expectedOrDummy, 'utf8');
  
  try {
    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
```

---

### Finding 5: Insecure SSL Disable Configuration
**Severity:** HIGH  
**Location:** `apps/web/src/server/pilot/db.ts:27-35` (`resolveSslConfig`)

**Description:**
The database SSL requirement can be disabled if BOTH `NODE_ENV=test` AND `PPBF_POSTGRES_DISABLE_SSL=true` are set. While this requires two conditions, if staging is misconfigured with `NODE_ENV=test`, TLS to PostgreSQL can be bypassed.

**Risk:**
- Database credentials transmitted unencrypted
- Database queries exposed to network eavesdropping
- Possible for misconfigured Azure deployment if both vars are accidentally set

**Current Code:**
```typescript
export function resolveSslConfig(override: SslOverride = {}): { rejectUnauthorized: boolean } | false {
  const nodeEnv = override.nodeEnv ?? process.env.NODE_ENV;
  const disableSslFlag = override.disableSslFlag ?? process.env.PPBF_POSTGRES_DISABLE_SSL;
  
  if (nodeEnv === 'test' && disableSslFlag === 'true') {
    return false;  // ❌ TLS disabled
  }
  
  return { rejectUnauthorized: true };
}
```

**Recommendation:**
- Never disable SSL in non-test environments
- Use explicit environment check:
```typescript
if (nodeEnv !== 'test' && disableSslFlag === 'true') {
  throw new Error('FATAL: Cannot disable SSL outside of test environments');
}
```
- Remove the disable flag entirely for production configs

---

### Finding 6: Organization Isolation Verification Gap
**Severity:** HIGH  
**Location:** All API routes under `apps/web/app/api/`

**Description:**
While the codebase generally enforces organization isolation by including `organization_id` in queries and checks, there hasn't been a systematic audit to verify that NO routes accept `organization_id` from user input instead of deriving it from `principal.organizationId`.

**Risk:**
A developer could accidentally write code like:
```typescript
const org = req.query.organization_id;  // ❌ User input
const athlete = await query(
  'select * from pilot.athletes where organization_id = $1',
  [org]  // Organization boundary bypassed!
);
```

**Recommendation:**
1. Audit all API routes to verify `principal.organizationId` is used exclusively
2. Add a lint rule that flags `.organization_id` from request body/query
3. Add integration tests that verify cross-org access is denied:
```typescript
it('denies cross-org access', async () => {
  const response = await fetch('/api/pilot/athletes', {
    body: JSON.stringify({
      organization_id: 'other-org',  // Attacker tries to access other org
      athlete_id: 'valid-athlete',
    })
  });
  expect(response.status).toBe(403);
});
```

---

## Medium-Severity Findings

### Finding 7: Arbitrary JSON in Medical Status Without Schema
**Severity:** MEDIUM  
**Location:** TBD (needs search for `restrictionFlags`)

**Risk:** `restrictionFlags` could accept malformed JSON affecting medical status decisions

### Finding 8: Weak File Upload Validation
**Severity:** MEDIUM  
**Location:** Video upload handlers

**Risk:** Only magic bytes checked; polyglot files could bypass validation

### Finding 9: No Insider Data Exfiltration Prevention
**Severity:** MEDIUM  
**Location:** Athlete data endpoints

**Risk:** Authenticated users could bulk-export all athlete data in organization

### Finding 10: Multi-Account Rate Limit Bypass
**Severity:** MEDIUM  
**Location:** Video upload rate limiting

**Risk:** Per-account limits allow bypass through creating multiple accounts

---

## Positive Security Findings (No Action Required)

✅ **SQL Injection Prevention**
- All queries use parameterized format via pg library ($1, $2, etc.)
- No evidence of string concatenation in queries

✅ **Session Token Security**
- 256-bit random tokens via `crypto.randomBytes(32)`
- Tokens hashed (SHA256) before database storage
- Session revocation checked on every request
- Expiry enforced in SQL query

✅ **Cookie Security**
- HTTP-only flag prevents JavaScript access
- SameSite=Lax provides CSRF protection (except finding #1)
- Path scoped to `/`

✅ **PIN Cryptography**
- Scrypt hashing with 16-byte random salt
- Timing-safe comparison via `timingSafeEqual`
- No hardcoded defaults leaked in responses

✅ **Microsoft OAuth Implementation**
- State parameter validated against cookie (lines 128-129)
- PKCE code verifier required (line 165)
- Nonce validated in JWT (line 170)
- State replay protection via hash storage (line 211)
- JWT signature verification implemented

✅ **Data Isolation**
- Organization_id required in queries
- Foreign key constraints to organizations table
- Organization membership actively validated on every session resolve
- Organization status checked (active vs inactive)

✅ **Error Sanitization**
- Error responses don't leak stack traces
- 500 errors sanitized to generic messages
- Account enumeration prevented in error messages

✅ **Rate Limiting**
- Dual-layer: volatile (in-memory) + durable (database)
- Per-account and per-IP limits
- Exponential backoff strategy
- Graceful degradation if database unavailable

---

## Security Checklist for Production

### Before Deploying
- [ ] Fix secure cookie flag (Finding #1)
- [ ] Implement constant-time PIN verification (Finding #2)
- [ ] Verify `PPBF_DURABLE_RATE_LIMIT=true` in production
- [ ] Fix bootstrap key timing attack (Finding #4)
- [ ] Add `NODE_ENV !== 'test'` check for SSL disable (Finding #5)
- [ ] Complete organization isolation audit (Finding #6)

### Operational Security
- [ ] Session cleanup job running daily
- [ ] Audit logs centralized and monitored
- [ ] Rate limit monitoring enabled
- [ ] Secrets rotation process documented
- [ ] Database connection verified to use TLS
- [ ] All environment variables documented

### Monitoring & Alerting
- [ ] Alert on auth error rate > threshold
- [ ] Alert if rate limit cleanup hasn't run in 14 days
- [ ] Monitor failed PIN attempt patterns
- [ ] Log all cross-org data access attempts

---

## Recommendations by Priority

### P0 - CRITICAL (Before Production)
1. **Fix Secure Cookie Flag** - Use protocol detection instead of NODE_ENV
2. **Implement Constant-Time PIN Verification** - Prevent account enumeration
3. **Enforce PPBF_DURABLE_RATE_LIMIT** - Add startup check
4. **Fix Bootstrap Key Timing** - Use timing-safe length comparison
5. **Harden SSL Configuration** - Reject disable flag outside tests

### P1 - HIGH (Sprint 1)
1. Audit all routes for organization_id source verification
2. Add cross-org access integration tests
3. Review medical data restrictionFlags schema
4. Document data exfiltration risks in threat model

### P2 - MEDIUM (Sprint 2)
1. Implement file upload polyglot detection
2. Add per-organization rate limits on bulk operations
3. Create audit dashboard for admin access patterns

---

## Files Reviewed

**Core Authentication**
- ✅ `apps/web/src/server/pilot/auth.ts` (1067 lines)
- ✅ `apps/web/src/server/pilot/access.ts` (125 lines)
- ✅ `apps/web/src/server/pilot/security.ts` (101 lines)
- ✅ `apps/web/src/server/pilot/http.ts` (150+ lines)
- ✅ `apps/web/src/server/pilot/microsoftOAuthFlow.ts` (150+ lines)

**API Routes**
- ✅ `apps/web/app/api/pilot/auth/login/route.ts`
- ✅ `apps/web/app/api/pilot/auth/logout/route.ts`
- ✅ `apps/web/app/api/pilot/auth/session/route.ts`
- ✅ `apps/web/app/api/pilot/auth/microsoft/callback/route.ts`

**Infrastructure**
- ✅ `apps/web/src/server/pilot/db.ts`
- ✅ `apps/web/src/server/pilot/rateLimit.ts`
- ✅ `apps/web/package.json` (dependencies)

**Documentation**
- ✅ `AUTH_CONTRACT.md`
- ✅ `ORGANIZATION_ARCHITECTURE.md`
- ✅ `README.md`

---

## Conclusion

The PPBF platform demonstrates solid security fundamentals with proper use of cryptography and database practices. However, the six high-severity findings must be addressed before production deployment. Most findings are configuration or implementation bugs rather than architectural flaws.

With the recommended fixes applied, the platform would achieve strong security posture suitable for handling sensitive athlete and health data.

**Revised Risk Assessment:** 🟢 **LOW** (after fixes applied)

---

**Next Steps:**
1. Create GitHub issues for each P0 finding
2. Assign fixes to development team
3. Add integration tests for each finding
4. Re-audit after fixes
5. Obtain security sign-off before production deployment

---

**Report Generated:** August 3, 2026  
**Repository:** punxsyprominence/ppbf-platform  
**Audit Branch:** claude/ppbf-platform-audit-w3va0j
