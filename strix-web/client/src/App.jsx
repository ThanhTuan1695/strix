import React, { useState, useEffect } from 'react';
import Login from './components/Login';
import ConfigPanel from './components/ConfigPanel';
import ScanPanel from './components/ScanPanel';
import ScanManager from './components/ScanManager';
import FindingsView from './components/FindingsView';
import ReportView from './components/ReportView';
import MobileScanPanel from './components/MobileScanPanel';
import UserManagement from './components/UserManagement';
import Dashboard from './components/Dashboard';
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

function NavIcon({ id }) {
  const p = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (id) {
    case 'dashboard': return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>;
    case 'scan': return <svg {...p}><polygon points="13,2 3,14 12,14 11,22 21,10 12,10" /></svg>;
    case 'mobile': return <svg {...p}><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>;
    case 'scans': return <svg {...p}><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>;
    case 'findings': return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case 'report': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>;
    case 'admin': return <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8l2.8-2.8M17 7l2.8-2.8"/></svg>;
    default: return null;
  }
}

const PAGE_CONFIG = {
  dashboard: { title: 'Overview', subtitle: 'Security posture at a glance' },
  scan: { title: 'New Scan', subtitle: 'Configure and launch a penetration test' },
  mobile: { title: 'Mobile Scan', subtitle: 'Upload and analyze mobile applications' },
  scans: { title: 'Test Runs', subtitle: 'Monitor and manage scan sessions' },
  findings: { title: 'Findings', subtitle: 'View and triage vulnerability findings' },
  report: { title: 'Reports', subtitle: 'Generate penetration test reports' },
  admin: { title: 'Settings', subtitle: 'User management and configuration' },
};

export default function App() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [activeScan, setActiveScan] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard');
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

  const navGroups = [
    { label: 'MAIN', items: [{ id: 'dashboard', label: 'Overview' }] },
    { label: 'SCANNING', items: [
      { id: 'scan', label: 'New Scan' },
      { id: 'mobile', label: 'Mobile' },
      { id: 'scans', label: 'Test Runs' },
    ]},
    { label: 'ANALYSIS', items: [
      { id: 'findings', label: 'Findings', badge: totalFindings || null },
      { id: 'report', label: 'Reports' },
    ]},
    ...(isAdmin ? [{ label: 'ADMIN', items: [{ id: 'admin', label: 'Settings' }] }] : []),
  ];

  const page = PAGE_CONFIG[activeTab] || {};

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="32" y2="32">
                  <stop offset="0%" stopColor="#00d4ff"/>
                  <stop offset="100%" stopColor="#a855f7"/>
                </linearGradient>
              </defs>
              <path d="M16 2L28 9v14L16 30 4 23V9l12-7z" stroke="url(#lg)" strokeWidth="1.5" fill="url(#lg)" fillOpacity="0.1"/>
              <circle cx="16" cy="16" r="6" stroke="url(#lg)" strokeWidth="1.5" fill="none"/>
              <circle cx="16" cy="16" r="2" fill="#00d4ff"/>
            </svg>
            <span className="sidebar-logo-text">Pentest Agent</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navGroups.map(group => (
            <div key={group.label}>
              <div className="nav-section-label">{group.label}</div>
              {group.items.map(item => (
                <button key={item.id}
                  className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
                  onClick={() => setActiveTab(item.id)}>
                  <NavIcon id={item.id} />
                  <span className="nav-label">{item.label}</span>
                  {item.badge && <span className="nav-badge">{item.badge}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="user-avatar">{user.username[0].toUpperCase()}</div>
            <div className="user-details">
              <span className="user-name">{user.username}</span>
              <span className="user-role-label">{user.role}</span>
            </div>
          </div>
          <button className="sidebar-logout" onClick={handleLogout} title="Logout">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <div className="page-header">
          <div>
            <h1 className="page-title">{page.title}</h1>
            <p className="page-subtitle">{page.subtitle}</p>
          </div>
          <div className="page-header-right">
            <span className={`role-pill role-${user.role}`}>{user.role}</span>
            <span className="header-username">{user.username}</span>
          </div>
        </div>

        <div className="page-content">
          {activeTab === 'dashboard' && (
            <Dashboard onNavigate={setActiveTab} onViewFindings={handleViewFindings} />
          )}
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
        </div>
      </main>
    </div>
  );
}
