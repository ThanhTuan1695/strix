import React, { useState, useEffect } from 'react';
import './Panel.css';

export default function ScanHistory({ onLoadFindings }) {
  const [runs, setRuns] = useState([]);
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(null);

  useEffect(() => {
    window.apiFetch('/api/runs').then(r => r.json()).then(setRuns);
    window.apiFetch('/api/scans').then(r => r.json()).then(setScans);
  }, []);

  const loadFindings = async (runName) => {
    setLoading(runName);
    const res = await window.apiFetch(`/api/runs/${runName}/findings`);
    const findings = await res.json();
    onLoadFindings(findings);
    setLoading(null);
  };

  return (
    <div className="panel" style={{ maxWidth: 800, margin: '0 auto' }}>
      <div className="panel-header"><h2>Scan History</h2></div>

      {scans.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '0 0 12px' }}>Current Session</h3>
          <div className="history-list">
            {scans.map(s => (
              <div key={s.id} className="history-item">
                <div className="history-info">
                  <strong>{s.targets?.join(', ') || 'Unknown target'}</strong>
                  <span className="history-meta">
                    {s.scanMode} · {s.testingType} · {new Date(s.startedAt).toLocaleString()}
                  </span>
                </div>
                <span className={`status-pill ${s.status}`}>{s.status}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '20px 0 12px' }}>Past Runs (strix_runs/)</h3>
      {runs.length === 0 ? (
        <div className="empty-state" style={{ padding: 40 }}>
          <p>No past scan runs found. Runs are saved to ./strix_runs/ after each scan.</p>
        </div>
      ) : (
        <div className="history-list">
          {runs.map(r => (
            <div key={r.name} className="history-item">
              <div className="history-info">
                <strong>{r.name}</strong>
                <span className="history-meta">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              <button
                className="btn-small"
                style={{ background: 'var(--accent)', color: 'white' }}
                onClick={() => loadFindings(r.name)}
                disabled={loading === r.name}
              >
                {loading === r.name ? 'Loading...' : 'Load Findings'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
