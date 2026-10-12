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
  return fetch(url, { ...opts, headers }).then(res => {
    if (res.status === 401 && token) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.reload();
    }
    return res;
  });
}
window.apiFetch = apiFetch;

const TabIcon = ({ id }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="tab-icon-svg">
    {id === 'scan' && <polygon points="13,2 3,14 12,14 11,22 21,10 12,10" />}
    {id === 'mobile' && <><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></>}
    {id === 'scans' && <><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></>}
    {id === 'findings' && <><circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="21"/><line x1="3" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="21" y2="12"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></>}
    {id === 'report' && <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></>}
    {id === 'admin' && <><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8l2.8-2.8M17 7l2.8-2.8"/></>}
  </svg>
);

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
    { id: 'scan', label: 'New Scan' },
    { id: 'mobile', label: 'Mobile' },
    { id: 'scans', label: 'Scan Manager' },
    { id: 'findings', label: `Findings${totalFindings ? ` (${totalFindings})` : ''}` },
    { id: 'report', label: 'Report' },
    ...(isAdmin ? [{ id: 'admin', label: 'Admin' }] : []),
  ];

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="32" y2="32">
                  <stop offset="0%" stopColor="#00d4ff"/>
                  <stop offset="100%" stopColor="#a855f7"/>
                </linearGradient>
              </defs>
              <path d="M16 2L28 9v14L16 30 4 23V9l12-7z" stroke="url(#lg)" strokeWidth="1.5" fill="url(#lg)" fillOpacity="0.1"/>
              <circle cx="16" cy="16" r="6" stroke="url(#lg)" strokeWidth="1.5" fill="none"/>
              <circle cx="16" cy="16" r="2" fill="#00d4ff"/>
              <line x1="16" y1="6" x2="16" y2="10" stroke="#00d4ff" strokeWidth="1" opacity="0.5"/>
              <line x1="16" y1="22" x2="16" y2="26" stroke="#00d4ff" strokeWidth="1" opacity="0.5"/>
              <line x1="6" y1="16" x2="10" y2="16" stroke="#00d4ff" strokeWidth="1" opacity="0.5"/>
              <line x1="22" y1="16" x2="26" y2="16" stroke="#00d4ff" strokeWidth="1" opacity="0.5"/>
            </svg>
            <h1 className="logo-text">Pentest Agent</h1>
          </div>
          <nav className="tabs">
            {tabs.map(t => (
              <button key={t.id}
                className={`tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}
                disabled={t.disabled}>
                <TabIcon id={t.id} />
                <span>{t.label}</span>
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
          isAdmin ? (
            <div className="grid">
              <div className="col-left">
                <ConfigPanel onConfigured={setConfigured} />
              </div>
              <div>
                <ScanPanel configured={configured} onScanStarted={handleScanStarted} />
              </div>
            </div>
          ) : (
            <ScanPanel configured={true} onScanStarted={handleScanStarted} />
          )
        )}
        {activeTab === 'mobile' && (
          isAdmin ? (
            <div className="grid">
              <div className="col-left">
                <ConfigPanel onConfigured={setConfigured} />
              </div>
              <div>
                <MobileScanPanel configured={configured} onScanStarted={handleScanStarted} />
              </div>
            </div>
          ) : (
            <MobileScanPanel configured={true} onScanStarted={handleScanStarted} />
          )
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
          <ReportView findings={currentFindings} meta={scanMeta} scanId={viewingScanId} />
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
