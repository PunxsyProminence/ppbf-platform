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
      allowedRoles={['board']}
      links={[
        { label: 'Board hub', href: '/board' },
      ]}
    />
  );
}
