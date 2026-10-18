import { notFound } from 'next/navigation';
import BoardMemberDashboard from '@/components/BoardMemberDashboard';
import { boardSeatMap, type BoardSeatSlug } from './boardWorkspaceConfig';

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
      links={[
        { label: 'Board Hub', href: '/board' },
        // Lane U2 (audit UX-A A-16): the board's two reads had no link in.
        { label: 'Program Aggregates', href: '/board/aggregates' },
        { label: 'Escalation Ladder', href: '/board/escalation-monitoring' },
      ]}
    />
  );
}
