import React, { useState } from 'react';
import { useAuth } from '@/providers/AuthProvider';
import { useNavigate } from 'react-router-dom';

export const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isSignUp) {
        await signUp(email, password, fullName);
      } else {
        await signIn(email, password);
      }
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="max-w-md w-full space-y-8">
        <h2 className="text-center text-3xl font-bold">PPBF {isSignUp ? 'Sign Up' : 'Sign In'}</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignUp && (
            <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full Name" className="w-full p-3 border rounded" />
          )}
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full p-3 border rounded" required />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="w-full p-3 border rounded" required />
          <button type="submit" disabled={loading} className="w-full p-3 bg-blue-600 text-white rounded">
            {loading ? 'Processing...' : (isSignUp ? 'Sign Up' : 'Sign In')}
          </button>
          <button type="button" onClick={() => setIsSignUp(!isSignUp)} className="w-full text-blue-600">
            {isSignUp ? 'Already have account? Sign In' : "Don't have account? Sign Up"}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
