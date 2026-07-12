import { notFound } from 'next/navigation';
import BoardMemberDashboard from '@/components/BoardMemberDashboard';
import { boardOverviewStrip, boardSeatMap, type BoardSeatSlug } from '../boardWorkspaceConfig';

export function generateStaticParams() {
  return Object.keys(boardSeatMap).map((member) => ({ member }));
}

export default function BoardMemberPage({ params }: { params: { member: string } }) {
  const member = params.member as BoardSeatSlug;
  const seat = boardSeatMap[member];

  if (!seat) {
    notFound();
  }

  return (
    <BoardMemberDashboard
      seat={seat}
      overviewMetrics={boardOverviewStrip}
      allowedRoles={[seat.allowedRole]}
      links={[
        { label: 'Board hub', href: '/board' },
        { label: 'Operations Hub', href: '/operations' },
        { label: 'The Ring', href: '/operations' },
      ]}
    />
  );
}