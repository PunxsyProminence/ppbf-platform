import { notFound } from 'next/navigation';
import BoardMemberDashboard from '@/components/BoardMemberDashboard';

const boardMembers = {
  chair: {
    title: 'Board Chair Dashboard',
    seatLabel: 'President / Board Chair',
    focus: 'Strategic leadership, agenda setting, and the clean overview needed to guide the organization.',
    metrics: [
      { label: 'Agenda', value: 'Prepared' },
      { label: 'Votes', value: 'Tracked' },
      { label: 'Risk', value: 'Visible' },
      { label: 'Status', value: 'Active' },
    ],
  },
  'vice-chair': {
    title: 'Vice Chair Dashboard',
    seatLabel: 'Vice Chair',
    focus: 'Continuity support, committee oversight, and backup leadership for board operations.',
    metrics: [
      { label: 'Continuity', value: 'Ready' },
      { label: 'Committee', value: 'Aligned' },
      { label: 'Coverage', value: 'Backed up' },
      { label: 'Status', value: 'Active' },
    ],
  },
  treasurer: {
    title: 'Treasurer Dashboard',
    seatLabel: 'Treasurer',
    focus: 'Budget review, financial controls, and the simplest possible grant and ledger snapshot.',
    metrics: [
      { label: 'Budget', value: 'Balanced' },
      { label: 'Ledger', value: 'Current' },
      { label: 'Grant', value: 'Tracked' },
      { label: 'Status', value: 'Active' },
    ],
  },
  secretary: {
    title: 'Secretary Dashboard',
    seatLabel: 'Secretary',
    focus: 'Minutes, records, document retention, and easy access to official board history.',
    metrics: [
      { label: 'Minutes', value: 'Filed' },
      { label: 'Records', value: 'Sorted' },
      { label: 'Docs', value: 'Current' },
      { label: 'Status', value: 'Active' },
    ],
  },
  'safety-director': {
    title: 'Program & Safety Director Dashboard',
    seatLabel: 'Program & Safety Director',
    focus: 'Youth protection, compliance checks, and a clear view of safety gating decisions.',
    metrics: [
      { label: 'Safety', value: 'Guarded' },
      { label: 'Compliance', value: 'Tracked' },
      { label: 'Youth', value: 'Protected' },
      { label: 'Status', value: 'Active' },
    ],
  },
  'community-director': {
    title: 'Community & Development Dashboard',
    seatLabel: 'Community & Development Director',
    focus: 'Partnerships, fundraising, and grant support with a simple community-facing summary.',
    metrics: [
      { label: 'Partners', value: 'Visible' },
      { label: 'Outreach', value: 'Tracked' },
      { label: 'Grant', value: 'Ready' },
      { label: 'Status', value: 'Active' },
    ],
  },
  'at-large': {
    title: 'Director-at-Large Dashboard',
    seatLabel: 'Director-at-Large',
    focus: 'Independent oversight, participation, and a broad view of the board’s current state.',
    metrics: [
      { label: 'Oversight', value: 'Open' },
      { label: 'Participation', value: 'Tracked' },
      { label: 'Voice', value: 'Present' },
      { label: 'Status', value: 'Active' },
    ],
  },
} as const;

type BoardMemberKey = keyof typeof boardMembers;

export function generateStaticParams() {
  return Object.keys(boardMembers).map((member) => ({ member }));
}

export default function BoardMemberPage({ params }: { params: { member: string } }) {
  const member = params.member as BoardMemberKey;
  const dashboard = boardMembers[member];

  if (!dashboard) {
    notFound();
  }

  return (
    <BoardMemberDashboard
      title={dashboard.title}
      seatLabel={dashboard.seatLabel}
      focus={dashboard.focus}
      metrics={dashboard.metrics}
      allowedRoles={[
        member as
          | 'board-chair'
          | 'board-vice-chair'
          | 'board-treasurer'
          | 'board-secretary'
          | 'board-safety-director'
          | 'board-community-director'
          | 'board-at-large',
      ]}
      links={[
        { label: 'Board hub', href: '/board' },
        { label: 'Operations Hub', href: '/operations' },
        { label: 'Launch Portal', href: '/launch' },
      ]}
    />
  );
}