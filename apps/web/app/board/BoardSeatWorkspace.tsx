import { notFound } from 'next/navigation';
import BoardMemberDashboard from '@/components/BoardMemberDashboard';
import { boardOverviewStrip, boardSeatMap, type BoardSeatSlug } from './boardWorkspaceConfig';

interface BoardSeatWorkspaceProps {
  member: BoardSeatSlug;
}

export default function BoardSeatWorkspace({ member }: BoardSeatWorkspaceProps) {
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
