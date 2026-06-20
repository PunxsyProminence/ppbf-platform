import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, UserRole } from '@/providers/AuthProvider';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRoles?: UserRole | UserRole[];
  fallbackPath?: string;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredRoles,
  fallbackPath = '/login',
}) => {
  const { user, role, loading, hasRole } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  if (!user) {
    return <Navigate to={fallbackPath} state={{ from: location }} replace />;
  }

  if (requiredRoles && !hasRole(requiredRoles)) {
    return <div className="p-8 text-red-600">Access Denied</div>;
  }

  return <>{children}</>;
};
