import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '@/providers/AuthProvider';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import Login from '@/legacyPages/Login';
import Dashboard from '@/legacyPages/Dashboard'; // create this if needed
import MigrationTool from '@/components/MigrationTool';

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          } />
          <Route path="/migration" element={
            <ProtectedRoute requiredRoles={['admin']}>
              <MigrationTool />
            </ProtectedRoute>
          } />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
