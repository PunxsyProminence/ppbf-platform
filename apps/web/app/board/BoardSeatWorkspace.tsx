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
        { label: 'Board hub', href: '/board' },
      ]}
    />
  );
}
