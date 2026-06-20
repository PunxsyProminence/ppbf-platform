import React from 'react';
import { useAuth } from '@/providers/AuthProvider';

export default function Dashboard() {
  const { user, role } = useAuth();

  return (
    <div className="p-8">
      <h1>PPBF Dashboard</h1>
      <p>Welcome, {user?.email} (Role: {role})</p>
      <p>This is your main dashboard. More features coming in Batch 32.</p>
    </div>
  );
}
