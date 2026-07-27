import { NextResponse, type NextRequest } from 'next/server';

import {
  createPublicInterestSubmission,
  PublicInterestValidationError,
} from '@/src/server/pilot/publicInterest';
import {
  checkDurableRateLimit,
  checkRateLimit,
  getClientIp,
  recordDurableFailedAttempt,
  recordFailedAttempt,
} from '@/src/server/pilot/rateLimit';

export const runtime = 'nodejs';

const MAX_FIELD_STRING_LENGTH = 4_000;

interface PublicInterestRequestBody {
  full_name?: unknown;
  email?: unknown;
  phone?: unknown;
  visitor_type?: unknown;
  program_interest?: unknown;
  preferred_contact_method?: unknown;
  message?: unknown;
  consent_to_contact?: unknown;
  // Hidden form field a real visitor never sees or fills in. Any value here
  // means the submission almost certainly came from a bot, not a person.
  website?: unknown;
}

function asBoundedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value.length > MAX_FIELD_STRING_LENGTH) {
    return null;
  }
  return value;
}

/**
 * POST /api/pilot/public-interest -- the only unauthenticated write endpoint
 * in this app. It backs the public marketing site's "Public Interest Intake"
 * form (app/public/page.tsx), which previously had no backend at all: every
 * real visitor's submission was held in local React state and lost on
 * refresh, while the UI claimed "Interest received... Admin review required."
 *
 * Every field here is attacker-controlled, so: rate limit by IP (volatile +
 * durable, same dual-check pattern as the activation endpoint), a hidden
 * honeypot field to filter basic bots, and full server-side validation in
 * publicInterest.ts that never trusts the client-side option lists.
 */
export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  const ipKey = `public_interest_ip:${clientIp}`;

  try {
    const volatileLimit = checkRateLimit(ipKey);
    const durableLimit = await checkDurableRateLimit(ipKey);
    if (volatileLimit.isLimited || durableLimit.isLimited) {
      return NextResponse.json(
        { ok: false, error: 'Too many submissions from this address. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(
              Math.ceil((Math.max(volatileLimit.delayMs ?? 0, durableLimit.delayMs ?? 0)) / 1000) || 1,
            ),
          },
        },
      );
    }

    // Every call to this endpoint consumes rate-limit budget, valid or not --
    // unlike a login/activation attempt, there is no "self-correctable
    // mistake" exemption here, since anyone hostile enough to script this
    // endpoint can just as easily send well-formed junk.
    recordFailedAttempt(ipKey);
    await recordDurableFailedAttempt(ipKey);

    const body = (await request.json().catch(() => null)) as PublicInterestRequestBody | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ ok: false, error: 'Request body must be valid JSON.' }, { status: 400 });
    }

    const honeypot = asBoundedString(body.website);
    if (honeypot && honeypot.trim().length > 0) {
      // Pretend success so a bot has no signal it was caught.
      return NextResponse.json({ ok: true });
    }

    const fullName = asBoundedString(body.full_name);
    const email = asBoundedString(body.email);
    const phone = body.phone == null ? null : asBoundedString(body.phone);
    const visitorType = asBoundedString(body.visitor_type);
    const programInterest = asBoundedString(body.program_interest);
    const preferredContactMethod = asBoundedString(body.preferred_contact_method);
    const message = body.message == null ? null : asBoundedString(body.message);
    const consentToContact = body.consent_to_contact === true;

    if (
      fullName === null
      || email === null
      || visitorType === null
      || programInterest === null
      || preferredContactMethod === null
    ) {
      return NextResponse.json({ ok: false, error: 'Missing or invalid required field.' }, { status: 400 });
    }

    const submission = await createPublicInterestSubmission({
      fullName,
      email,
      phone,
      visitorType,
      programInterest,
      preferredContactMethod,
      message,
      consentToContact,
      submittedIp: clientIp,
    });

    return NextResponse.json({ ok: true, submissionId: submission.submission_id });
  } catch (error) {
    if (error instanceof PublicInterestValidationError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }

    console.error('public-interest-submission-failed');
    return NextResponse.json(
      { ok: false, error: 'This form is temporarily unavailable. Please try again later.' },
      { status: 503 },
    );
  }
}
