import type { ReactNode } from 'react';

import BoardRoleGate from '@/components/BoardRoleGate';

export default function BoardLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <BoardRoleGate>{children}</BoardRoleGate>;
}
