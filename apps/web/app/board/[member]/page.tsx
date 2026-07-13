import { notFound } from 'next/navigation';
import BoardSeatWorkspace from '../BoardSeatWorkspace';
import { boardSeatMap, type BoardSeatSlug } from '../boardWorkspaceConfig';

export function generateStaticParams() {
  return Object.keys(boardSeatMap).map((member) => ({ member }));
}

export default function BoardMemberPage({ params }: { params: { member: string } }) {
  const member = params.member as BoardSeatSlug;
  if (!boardSeatMap[member]) {
    notFound();
  }

  return <BoardSeatWorkspace member={member} />;
}