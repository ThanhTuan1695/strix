import React, { useState, useEffect } from 'react';
import './Dashboard.css';

const SEVERITY_COLORS = {
  Critical: '#ef4444',
  High: '#f97316',
  Medium: '#f59e0b',
  Low: '#22c55e',
  Info: '#3b82f6',
};

const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low', 'Info'];

function StatIcon({ type, color }) {
  const p = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (type) {
    case 'critical': return <svg {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
    case 'high': return <svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
    case 'total': return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case 'active': return <svg {...p}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
    case 'completed': return <svg {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
    default: return null;
  }
}

export default function Dashboard({ onNavigate, onViewFindings }) {
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const res = await window.apiFetch('/api/all-scans');
      setScans(await res.json());
    } catch {}
    setLoading(false);
  };

  const totalScans = scans.length;
  const activeScans = scans.filter(s => s.status === 'running').length;
  const completedScans = scans.filter(s => s.status === 'completed').length;

  const allFindings = [];
  for (const scan of scans) {
    const findings = scan.findings || scan.mergedFindings || [];
    allFindings.push(...findings);
  }

  const totalFindings = allFindings.length || scans.reduce((sum, s) => sum + (s.findingsCount || 0), 0);

  const sevCounts = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
  for (const f of allFindings) {
    const sev = f.severity ? f.severity.charAt(0).toUpperCase() + f.severity.slice(1).toLowerCase() : null;
    if (sev && sevCounts[sev] !== undefined) sevCounts[sev]++;
  }
  const maxSevCount = Math.max(1, ...Object.values(sevCounts));

  const recentScans = [...scans]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 8);

  const targetCounts = {};
  for (const scan of scans) {
    const targets = scan.targets || (scan.target ? [scan.target] : []);
    const count = scan.findingsCount || scan.findings?.length || 0;
    for (const t of targets) {
      targetCounts[t] = (targetCounts[t] || 0) + count;
    }
  }
  const topTargets = Object.entries(targetCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const stats = [
    { key: 'critical', label: 'Critical', value: sevCounts.Critical, color: '#ef4444' },
    { key: 'high', label: 'High', value: sevCounts.High, color: '#f97316' },
    { key: 'total', label: 'Total Findings', value: totalFindings, color: '#00d4ff' },
    { key: 'active', label: 'Active Tests', value: activeScans, color: '#8b5cf6' },
    { key: 'completed', label: 'Completed', value: completedScans, color: '#22c55e' },
  ];

  if (loading) {
    return (
      <div className="dash-loading">
        <div className="dash-loading-spinner" />
        <span>Loading dashboard...</span>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="stats-grid">
        {stats.map(s => (
          <div key={s.key} className="stat-card">
            <div className="stat-icon-wrap" style={{ background: `${s.color}14`, color: s.color }}>
              <StatIcon type={s.key} color={s.color} />
            </div>
            <div className="stat-info">
              <span className="stat-value" style={{ color: s.color }}>{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="dash-grid">
        <div className="dash-card">
          <div className="dash-card-header">
            <h3>Findings by Severity</h3>
            {totalFindings > 0 && (
              <button className="dash-link" onClick={() => onNavigate('findings')}>View All</button>
            )}
          </div>
          {totalFindings > 0 ? (
            <div className="sev-chart">
              {SEVERITY_ORDER.map(sev => (
                <div key={sev} className="sev-row">
                  <span className="sev-row-label">{sev}</span>
                  <div className="sev-bar-track">
                    <div className="sev-bar-fill" style={{
                      width: sevCounts[sev] > 0 ? `${Math.max(3, (sevCounts[sev] / maxSevCount) * 100)}%` : '0%',
                      background: SEVERITY_COLORS[sev],
                    }} />
                  </div>
                  <span className="sev-row-count" style={{ color: SEVERITY_COLORS[sev] }}>{sevCounts[sev]}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="dash-empty-card">No findings yet. Run a scan to get started.</div>
          )}
        </div>

        <div className="dash-card">
          <div className="dash-card-header">
            <h3>Top Targets</h3>
          </div>
          {topTargets.length > 0 ? (
            <div className="targets-list">
              {topTargets.map(([target, count], i) => (
                <div key={target} className="target-item">
                  <span className="target-rank">#{i + 1}</span>
                  <span className="target-name">{target}</span>
                  <span className="target-count">{count} findings</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="dash-empty-card">No targets scanned yet.</div>
          )}
        </div>
      </div>

      <div className="dash-card">
        <div className="dash-card-header">
          <h3>Recent Test Runs</h3>
          {recentScans.length > 0 && (
            <button className="dash-link" onClick={() => onNavigate('scans')}>View All</button>
          )}
        </div>
        {recentScans.length > 0 ? (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Findings</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {recentScans.map(s => {
                  const fCount = s.findingsCount || s.findings?.length || 0;
                  return (
                    <tr key={s.id} className="dash-table-row" onClick={() => onNavigate('scans')}>
                      <td className="dash-table-target">
                        {s.runName || s.targets?.join(', ') || s.target || 'Unknown'}
                      </td>
                      <td className="dash-table-type">{s.testingType || s.scanMode || '-'}</td>
                      <td>
                        <span className={`dash-status ${s.status}`}>{s.status}</span>
                      </td>
                      <td>
                        {fCount > 0 ? (
                          <span className="dash-findings-num">{fCount}</span>
                        ) : (
                          <span className="dash-findings-zero">0</span>
                        )}
                      </td>
                      <td className="dash-table-date">
                        {new Date(s.startedAt).toLocaleDateString()}{' '}
                        {new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dash-empty-card" style={{ padding: '48px 20px' }}>
            <p style={{ marginBottom: 16 }}>No scans yet. Start your first penetration test.</p>
            <button className="btn-primary" style={{ maxWidth: 200, margin: '0 auto' }} onClick={() => onNavigate('scan')}>
              Start First Scan
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
