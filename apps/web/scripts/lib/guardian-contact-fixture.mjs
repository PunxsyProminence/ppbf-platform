// The split-household fixture, named once so the provisioner and the probe
// cannot drift apart.
//
// The probe that follows the deploy searches a real HTTP response body for
// these exact strings. If the provisioner wrote one value and the probe looked
// for another, the probe would report PASS for a leak it simply failed to
// recognise -- which is worse than no probe, because it is a green light with
// nothing behind it. One module, one set of values, imported by both.
//
// Every value is deliberately unmistakable and unusable: the domain is
// .invalid (RFC 2606, guaranteed never to resolve) and the numbers are in the
// 555-01xx reserved fictional range. Nothing here can reach a person.

export const GUARDIAN_CONTACT_FIXTURE = {
  parentA: {
    parentId: 'gate_probe_parent_a',
    fullName: 'Gate Probe Guardian A',
    phone: '555-0101',
    email: 'gate.guardian.a@ppbf.invalid',
    relationship: 'mother',
  },
  parentB: {
    parentId: 'gate_probe_parent_b',
    fullName: 'Gate Probe Guardian B',
    phone: '555-0202',
    email: 'gate.guardian.b@ppbf.invalid',
    relationship: 'father',
  },
  // The other parent as the emergency contact -- the ordinary shape, and the
  // one that let a narrowed guardian list be joined back to a phone number.
  emergencyContact: {
    contactId: '5efbb2f7-0000-4000-8000-00000000ec01',
    // Byte-identical to parentB.fullName on purpose: that identity IS the join
    // key the disclosure travelled on.
    fullName: 'Gate Probe Guardian B',
    relationship: 'father',
    phone: '555-0202',
    email: 'gate.guardian.b@ppbf.invalid',
    notes: 'Gate fixture note. Staff-only field: this is where a safeguarding instruction is written.',
  },
};

/**
 * Everything about Guardian B that must never reach the other household or the
 * child, in every spelling it could leave in.
 *
 * `accountId` is supplied by the caller because it comes from the environment
 * rather than from this file -- it is one of the three protected columns, so
 * the probe checks for it too.
 */
export function guardianBSecrets(accountId) {
  const { parentB, emergencyContact } = GUARDIAN_CONTACT_FIXTURE;
  return [
    parentB.phone,
    parentB.email,
    emergencyContact.phone,
    emergencyContact.email,
    emergencyContact.notes,
    ...(accountId ? [accountId] : []),
  ];
}
