import React, { useState, useEffect, useRef } from 'react';
import './Panel.css';

function logIcon(type) {
  switch (type) {
    case 'start': return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    );
    case 'agent': return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    );
    case 'finding': return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    );
    case 'summary': return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    );
    case 'complete': return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
    );
    case 'error': return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
    );
    default: return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/></svg>
    );
  }
}

export default function ScanOutput({ scanId, onScanComplete, onSwitchScan }) {
  const [scan, setScan] = useState(null);
  const [allScans, setAllScans] = useState([]);
  const [showConfig, setShowConfig] = useState(false);
  const [providers, setProviders] = useState([]);
  const [llm, setLlm] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const outputRef = useRef(null);
  const notifiedRef = useRef(false);

  useEffect(() => {
    window.apiFetch('/api/providers').then(r => r.json()).then(setProviders);
    window.apiFetch('/api/config').then(r => r.json()).then(cfg => { if (cfg.llm) setLlm(cfg.llm); });
    loadAllScans();
  }, []);

  useEffect(() => {
    loadAllScans();
  }, [scanId]);

  const loadAllScans = () => {
    window.apiFetch('/api/scans').then(r => r.json()).then(setAllScans);
  };

  useEffect(() => {
    if (!scanId) return;
    notifiedRef.current = false;
    const poll = setInterval(async () => {
      try {
        const res = await window.apiFetch(`/api/scan/${scanId}`);
        const data = await res.json();
        setScan(data);
        loadAllScans();
        if (data.status !== 'running') {
          clearInterval(poll);
          if (!notifiedRef.current && onScanComplete) {
            notifiedRef.current = true;
            onScanComplete(data.findings || [], {
              endDate: new Date().toLocaleDateString(),
              targets: data.targets,
              scanMode: data.scanMode,
              testingType: data.testingType,
            });
          }
        }
      } catch {}
    }, 1500);
    return () => clearInterval(poll);
  }, [scanId]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [scan?.logs?.length]);

  const handleStop = () => window.apiFetch(`/api/scan/${scanId}/stop`, { method: 'POST' });

  const handleSaveConfig = async () => {
    setSaving(true);
    await window.apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm, apiKey }),
    });
    setSaving(false);
    setConfigSaved(true);
    setTimeout(() => setConfigSaved(false), 2000);
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await window.apiFetch(`/api/scan/${scanId}/retry`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && onSwitchScan) {
        onSwitchScan(data.scanId);
      }
    } catch {}
    setRetrying(false);
  };

  const handleSelectScan = async (id) => {
    if (onSwitchScan) onSwitchScan(id);
    const res = await window.apiFetch(`/api/scan/${id}`);
    setScan(await res.json());
  };

  const handleDeleteScan = async (id, e) => {
    e.stopPropagation();
    await window.apiFetch(`/api/scan/${id}`, { method: 'DELETE' });
    loadAllScans();
    if (id === scanId && onSwitchScan) {
      const remaining = allScans.filter(s => s.id !== id);
      if (remaining.length) onSwitchScan(remaining[0].id);
    }
  };

  const isFailed = scan && (scan.status === 'failed' || scan.status === 'error');
  const statusColor = { running: 'var(--warning)', completed: 'var(--success)', failed: 'var(--danger)', stopped: 'var(--text-secondary)', error: 'var(--danger)' };

  return (
    <div className="output-layout">
      {/* Scan Manager Sidebar */}
      <div className="scan-manager">
        <div className="manager-header">
          <h3>Scans ({allScans.length})</h3>
        </div>
        <div className="manager-list">
          {allScans.length === 0 && (
            <div className="manager-empty">No scans yet</div>
          )}
          {allScans.map(s => (
            <div key={s.id}
              className={`manager-item ${s.id === scanId ? 'active' : ''}`}
              onClick={() => handleSelectScan(s.id)}>
              <span className="status-dot-sm" style={{ background: statusColor[s.status] || 'gray' }} />
              <div className="manager-item-info">
                <span className="manager-target">{s.targets?.join(', ') || 'Unknown'}</span>
                <span className="manager-meta">
                  {s.scanMode} · {s.testingType} · {new Date(s.startedAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="manager-item-actions">
                <span className={`status-pill-sm ${s.status}`}>{s.status}</span>
                <button className="btn-delete-sm" onClick={(e) => handleDeleteScan(s.id, e)} title="Delete scan">×</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main Output */}
      <div className="panel output-panel full-height">
        {!scanId ? (
          <>
            <div className="panel-header"><h2>Scan Output</h2></div>
            <div className="empty-state">
              <div className="empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <p>Start a scan to see live output here</p>
            </div>
          </>
        ) : (
          <>
            <div className="panel-header">
              <h2>Live Output</h2>
              <div className="scan-meta">
                <span className="status-dot" style={{ background: statusColor[scan?.status] || 'gray' }} />
                <span className="status-text">{scan?.status || 'unknown'}</span>
                {scan?.findings?.length > 0 && (
                  <span className="finding-count">{scan.findings.length} findings</span>
                )}
                {scan?.status === 'running' && (
                  <button className="btn-small btn-danger" onClick={handleStop}>Stop</button>
                )}
                {isFailed && (
                  <>
                    <button className="btn-small btn-config" onClick={() => setShowConfig(!showConfig)}>
                      {showConfig ? 'Hide Config' : 'Edit Config'}
                    </button>
                    <button className="btn-small btn-retry" onClick={handleRetry} disabled={retrying}>
                      {retrying ? 'Retrying...' : 'Retry'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Inline Config Editor */}
            {showConfig && (
              <div className="inline-config">
                <div className="inline-config-row">
                  <div className="field" style={{ flex: 1 }}>
                    <label>LLM Provider</label>
                    <select value={llm} onChange={e => setLlm(e.target.value)}>
                      <option value="">Select...</option>
                      {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>API Key</label>
                    <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="New API key" />
                  </div>
                  <button className="btn-save-inline" onClick={handleSaveConfig} disabled={saving || (!llm && !apiKey)}>
                    {saving ? '...' : configSaved ? 'Saved!' : 'Save'}
                  </button>
                </div>
              </div>
            )}

            {scan?.targets && (
              <div className="scan-info">
                <span>Target: <strong>{scan.targets?.join(', ')}</strong></span>
                <span>{scan.scanMode} / {scan.testingType}</span>
                {scan.retriedFrom && <span className="retry-badge">Retried</span>}
              </div>
            )}

            <div className="output-area" ref={outputRef}>
              {scan?.logs?.length > 0 ? (
                <div className="scan-log-timeline">
                  {scan.logs.map((log, i) => (
                    <div key={i} className={`log-event log-event-${log.type}`}>
                      <span className="log-event-icon">{logIcon(log.type)}</span>
                      <span className="log-event-time">{log.ts ? new Date(log.ts).toLocaleTimeString() : ''}</span>
                      <span className="log-event-msg">{log.msg}</span>
                    </div>
                  ))}
                  {scan.status === 'running' && (
                    <div className="log-event log-event-running">
                      <span className="log-event-icon"><span className="scanning-dot" /></span>
                      <span className="log-event-msg">Scanning...</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="scan-log-timeline">
                  <div className="log-event log-event-running">
                    <span className="log-event-icon"><span className="scanning-dot" /></span>
                    <span className="log-event-msg">{scan?.status === 'running' ? 'Starting scan...' : 'No events recorded'}</span>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
