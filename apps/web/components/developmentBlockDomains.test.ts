import {
  BLOCK_STATUSES,
  DOMAIN_LABEL,
  STATUS_BADGE,
  domainLabel,
} from './developmentBlockDomains';
import {
  FULL_SPECTRUM_DOMAINS,
  OBJECTIVE_STATUSES,
} from '@/src/server/pilot/athleteDevelopmentBlockObjectives';

/*
 * THE SEAM BETWEEN THE DATABASE'S VOCABULARY AND THE WORDS A FAMILY READS.
 *
 * Neither screen holds a copy of the ten domains -- the coach's authoring
 * panel renders whatever the route serves, so it can never offer a value the
 * CHECK constraint would refuse. The cost of that design is the opposite
 * failure: a domain added to the migration, served to a screen, and rendered
 * with no label for it -- appearing to an athlete as a raw snake_case slug
 * about their own body.
 *
 * Equality in BOTH directions is what makes that impossible, and this file
 * runs under node rather than jsdom because asserting it requires importing
 * the server module, which pulls in `pg` and needs a TextEncoder jsdom does
 * not provide.
 */

describe('every domain the database allows has words a person can read', () => {
  test('DOMAIN_LABEL covers exactly the Full Spectrum vocabulary', () => {
    expect(Object.keys(DOMAIN_LABEL).sort()).toEqual([...FULL_SPECTRUM_DOMAINS].sort());
  });

  test('every label is human text, not the stored value passed through', () => {
    // A label identical to its key is the shape a lazy addition takes, and it
    // reads to a family as a bug rather than as a category.
    for (const domain of FULL_SPECTRUM_DOMAINS) {
      expect(DOMAIN_LABEL[domain]).toBeTruthy();
      expect(DOMAIN_LABEL[domain]).not.toBe(domain);
      expect(DOMAIN_LABEL[domain]).not.toMatch(/_/);
    }
  });

  test('nutrition_body_composition is labelled plainly, not euphemised', () => {
    /* Admitted by owner decision 2026-08-28, and read by the athlete it is
       about since the read decision of the same day. A coy label would be its
       own kind of dishonesty on a record about a minor: the domain is what it
       is, and the family is owed the real name of it. */
    expect(DOMAIN_LABEL.nutrition_body_composition).toBe('Nutrition & body composition');
  });

  test('an unlabelled domain degrades to itself rather than to nothing', () => {
    // If the pin above is ever defeated, a reader should see something
    // wrong rather than a blank where a category belongs.
    expect(domainLabel('some_future_domain')).toBe('some_future_domain');
  });
});

describe('the lifecycle vocabulary is the database\'s, and every state is nameable', () => {
  test('BLOCK_STATUSES matches the module\'s own list', () => {
    expect([...BLOCK_STATUSES]).toEqual([...OBJECTIVE_STATUSES]);
  });

  test('every status has a badge and a human label', () => {
    for (const status of BLOCK_STATUSES) {
      expect(STATUS_BADGE[status].label).toBeTruthy();
      expect(STATUS_BADGE[status].className).toMatch(/^badge--/);
    }
  });

  test('cancelled is filed, not restricted', () => {
    /* A block's status is a PLANNING state, not a safety state. Painting
       'cancelled' with the safeguarding rung would tell an athlete their
       participation was blocked when a coach merely abandoned a plan -- the
       Law 2 confusion the readiness bands were cleaned up over. */
    expect(STATUS_BADGE.cancelled.className).toBe('badge--filed');
    expect(STATUS_BADGE.cancelled.className).not.toContain('restricted');
    for (const status of BLOCK_STATUSES) {
      expect(STATUS_BADGE[status].className).not.toContain('restricted');
    }
  });
});
