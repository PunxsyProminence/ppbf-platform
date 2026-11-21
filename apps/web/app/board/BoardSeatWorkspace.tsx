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

  // The seat's links (Board Hub and the board's reads) are BoardWorkspaceLinks,
  // rendered by the dashboard directly under its header (lane AS-12, BOA-03).
  return <BoardMemberDashboard seat={seat} />;
}
