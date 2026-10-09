import React, { useState, useEffect } from 'react';
import Login from './components/Login';
import ConfigPanel from './components/ConfigPanel';
import ScanPanel from './components/ScanPanel';
import ScanManager from './components/ScanManager';
import FindingsView from './components/FindingsView';
import ReportView from './components/ReportView';
import MobileScanPanel from './components/MobileScanPanel';
import UserManagement from './components/UserManagement';
import './App.css';

function apiFetch(url, opts = {}) {
  const token = localStorage.getItem('token');
  const headers = { ...opts.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  return fetch(url, { ...opts, headers });
}
window.apiFetch = apiFetch;

export default function App() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [activeScan, setActiveScan] = useState(null);
  const [activeTab, setActiveTab] = useState('scan');
  const [findingsMap, setFindingsMap] = useState({});
  const [viewingScanId, setViewingScanId] = useState(null);
  const [scanMeta, setScanMeta] = useState({});

  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    if (savedToken && savedUser) {
      try {
        const u = JSON.parse(savedUser);
        setUser(u);
        setToken(savedToken);
      } catch { localStorage.clear(); }
    }
  }, []);

  const handleLogin = (u, t) => { setUser(u); setToken(t); };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    setToken(null);
  };

  if (!user) return <Login onLogin={handleLogin} />;

  const isAdmin = user.role === 'admin';
  const currentFindings = viewingScanId ? (findingsMap[viewingScanId] || []) : [];
  const totalFindings = Object.values(findingsMap).reduce((sum, f) => sum + f.length, 0);

  const handleScanStarted = (scanId, meta) => {
    setActiveScan(scanId);
    setScanMeta(meta);
    setActiveTab('scans');
  };

  const handleViewFindings = (scanId, findings) => {
    if (findings?.length) setFindingsMap(prev => ({ ...prev, [scanId]: findings }));
    setViewingScanId(scanId);
    setActiveTab('findings');
  };

  const handleGenerateReport = (scanId, findings, meta) => {
    if (findings?.length) setFindingsMap(prev => ({ ...prev, [scanId]: findings }));
    setViewingScanId(scanId);
    setScanMeta(meta || {});
    setActiveTab('report');
  };

  const tabs = [
    { id: 'scan', label: 'New Scan', icon: '⚡' },
    { id: 'mobile', label: 'Mobile', icon: '📱' },
    { id: 'scans', label: 'Scan Manager', icon: '📡' },
    { id: 'findings', label: `Findings${totalFindings ? ` (${totalFindings})` : ''}`, icon: '🎯' },
    { id: 'report', label: 'Report', icon: '📄', disabled: !currentFindings.length },
    ...(isAdmin ? [{ id: 'admin', label: 'Admin', icon: '⚙️' }] : []),
  ];

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#6c5ce7" />
              <path d="M16 6L8 12v8l8 6 8-6v-8L16 6z" fill="none" stroke="white" strokeWidth="1.5" strokeLinejoin="round"/>
              <circle cx="16" cy="16" r="3" fill="white" opacity="0.9"/>
              <path d="M16 13v-4M16 23v-4M13 16H9M23 16h-4" stroke="white" strokeWidth="1.2" opacity="0.5"/>
            </svg>
            <h1>Pentestteam</h1>
          </div>
          <nav className="tabs">
            {tabs.map(t => (
              <button key={t.id}
                className={`tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}
                disabled={t.disabled}>
                <span className="tab-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="header-right">
            <span className="user-info">
              <span className={`role-badge role-${user.role}`}>{user.role}</span>
              {user.username}
            </span>
            <button className="logout-btn" onClick={handleLogout}>Logout</button>
          </div>
        </div>
      </header>

      <main className="main">
        {activeTab === 'scan' && (
          <div className="grid">
            {isAdmin && (
              <div className="col-left">
                <ConfigPanel onConfigured={setConfigured} />
              </div>
            )}
            <div className={isAdmin ? 'col-right' : 'col-full'}>
              <ScanPanel configured={configured || !isAdmin} onScanStarted={handleScanStarted} />
            </div>
          </div>
        )}
        {activeTab === 'mobile' && (
          <div className="grid">
            {isAdmin && (
              <div className="col-left">
                <ConfigPanel onConfigured={setConfigured} />
              </div>
            )}
            <div className={isAdmin ? 'col-right' : 'col-full'}>
              <MobileScanPanel configured={configured || !isAdmin} onScanStarted={handleScanStarted} />
            </div>
          </div>
        )}
        {activeTab === 'scans' && (
          <ScanManager
            activeScanId={activeScan}
            onSwitchScan={setActiveScan}
            onViewFindings={handleViewFindings}
            onGenerateReport={handleGenerateReport}
          />
        )}
        {activeTab === 'findings' && (
          <FindingsView
            findings={currentFindings}
            findingsMap={findingsMap}
            viewingScanId={viewingScanId}
            onSelectScan={(id) => setViewingScanId(id)}
            onFindingsUpdated={async (scanId) => {
              try {
                let findings = [];
                if (scanId.startsWith('run-')) {
                  const runName = scanId.replace('run-', '');
                  const res = await apiFetch(`/api/runs/${encodeURIComponent(runName)}/findings`);
                  findings = await res.json();
                } else if (scanId.startsWith('scan-') || scanId.startsWith('mobile-')) {
                  const res = await apiFetch(`/api/scan/${scanId}`);
                  const data = await res.json();
                  findings = data.findings || data.mergedFindings || [];
                }
                setFindingsMap(prev => ({ ...prev, [scanId]: findings }));
              } catch {}
            }}
          />
        )}
        {activeTab === 'report' && (
          <ReportView findings={currentFindings} meta={scanMeta} />
        )}
        {activeTab === 'admin' && isAdmin && (
          <div className="admin-page">
            <UserManagement token={token} />
          </div>
        )}
      </main>
    </div>
  );
}
