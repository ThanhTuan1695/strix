import React, { useState } from 'react';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      onLogin(data.user, data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-bg-grid" />
      <div className="login-bg-orb login-bg-orb-1" />
      <div className="login-bg-orb login-bg-orb-2" />
      <div className="login-bg-orb login-bg-orb-3" />
      <div className="login-card">
        <div className="login-logo">
          <svg width="56" height="56" viewBox="0 0 32 32" fill="none">
            <defs>
              <linearGradient id="loginGrad" x1="0" y1="0" x2="32" y2="32">
                <stop offset="0%" stopColor="#00d4ff"/>
                <stop offset="100%" stopColor="#a855f7"/>
              </linearGradient>
            </defs>
            <path d="M16 2L28 9v14L16 30 4 23V9l12-7z" stroke="url(#loginGrad)" strokeWidth="1.5" fill="url(#loginGrad)" fillOpacity="0.1"/>
            <circle cx="16" cy="16" r="6" stroke="url(#loginGrad)" strokeWidth="1.5" fill="none"/>
            <circle cx="16" cy="16" r="2" fill="#00d4ff"/>
            <line x1="16" y1="6" x2="16" y2="10" stroke="#00d4ff" strokeWidth="1" opacity="0.5"/>
            <line x1="16" y1="22" x2="16" y2="26" stroke="#00d4ff" strokeWidth="1" opacity="0.5"/>
            <line x1="6" y1="16" x2="10" y2="16" stroke="#00d4ff" strokeWidth="1" opacity="0.5"/>
            <line x1="22" y1="16" x2="26" y2="16" stroke="#00d4ff" strokeWidth="1" opacity="0.5"/>
          </svg>
          <h1>Pentest Agent</h1>
          <p className="login-subtitle">Security Testing Platform</p>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)}
              placeholder="Enter username"
              autoFocus autoComplete="username" />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              autoComplete="current-password" />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={loading || !username || !password} className="login-btn">
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
