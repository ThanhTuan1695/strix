import React, { useState, useEffect, useRef } from 'react';
import './ScanManager.css';

const STATUS_COLORS = { running: 'var(--warning)', completed: 'var(--success)', failed: 'var(--danger)', stopped: 'var(--text-secondary)', error: 'var(--danger)' };
const PHASE_ICONS = { running: '⟳', completed: '✓', error: '✗', skipped: '—' };
const PHASE_LABELS = {
  mobsf: 'MobSF Scan', 'ai-agent': 'AI Agent', enrichment: 'Enrichment',
  infra: 'Auto-start Infra', setup: 'Setup', instrumentation: 'Instrumentation', crawl: 'AI Crawl',
  'traffic-analysis': 'Traffic Analysis', 'api-pentest': 'API Pentest', 'config-checks': 'Config Checks',
};

export default function ScanManager({ activeScanId, onSwitchScan, onViewFindings, onRetry, onGenerateReport }) {
  const [allScans, setAllScans] = useState([]);
  const [selectedId, setSelectedId] = useState(activeScanId);
  const [selectedScan, setSelectedScan] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [providers, setProviders] = useState([]);
  const [llm, setLlm] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [saving, setSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const outputRef = useRef(null);

  useEffect(() => {
    fetch('/api/providers').then(r => r.json()).then(setProviders);
    fetch('/api/config').then(r => r.json()).then(cfg => {
      if (cfg.llm) setLlm(cfg.llm);
      if (cfg.apiBase) setApiBase(cfg.apiBase);
    });
  }, []);

  useEffect(() => { setSelectedId(activeScanId); }, [activeScanId]);

  useEffect(() => {
    loadAllScans();
    const interval = setInterval(loadAllScans, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const fetchDetail = async () => {
      try {
        const res = await fetch(`/api/scan/${selectedId}`);
        if (res.ok) {
          const data = await res.json();
          if (!data.findings?.length && data.mergedFindings?.length) data.findings = data.mergedFindings;
          setSelectedScan(data);
          return;
        }
      } catch {}
      const disk = allScans.find(s => s.id === selectedId);
      if (disk) setSelectedScan(disk);
    };
    fetchDetail();
    if (selectedId?.startsWith('scan-') || selectedId?.startsWith('mobile-')) {
      const poll = setInterval(fetchDetail, 1500);
      return () => clearInterval(poll);
    }
  }, [selectedId, allScans.length]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [selectedScan?.output]);

  const loadAllScans = async () => {
    try {
      const res = await fetch('/api/all-scans');
      setAllScans(await res.json());
    } catch {}
  };

  const handleSelect = (id) => {
    setSelectedId(id);
    if (onSwitchScan) onSwitchScan(id);
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setConfirmDelete(null);
    if (id.startsWith('scan-') || id.startsWith('mobile-')) {
      await fetch(`/api/scan/${id}`, { method: 'DELETE' });
    } else if (id.startsWith('run-')) {
      const runName = id.replace('run-', '');
      await fetch(`/api/runs/${encodeURIComponent(runName)}`, { method: 'DELETE' });
    }
    loadAllScans();
    if (id === selectedId) {
      setSelectedId(null);
      setSelectedScan(null);
    }
  };

  const handleStop = async () => {
    await fetch(`/api/scan/${selectedId}/stop`, { method: 'POST' });
  };

  const handleRename = async (id) => {
    if (!renameValue.trim()) { setRenaming(null); return; }
    if (id.startsWith('scan-')) {
      await fetch(`/api/scan/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runName: renameValue.trim() }),
      });
    } else if (id.startsWith('run-')) {
      const runName = id.replace('run-', '');
      await fetch(`/api/runs/${encodeURIComponent(runName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: renameValue.trim() }),
      });
    }
    setRenaming(null);
    loadAllScans();
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    const isOllamaModel = llm.startsWith('ollama/');
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm, apiKey: isOllamaModel ? 'ollama' : apiKey, apiBase: isOllamaModel ? '' : apiBase }),
    });
    setSaving(false);
    setConfigSaved(true);
    setTimeout(() => setConfigSaved(false), 2000);
  };

  const handleRetry = async () => {
    if (!selectedId?.startsWith('scan-')) return;
    setRetrying(true);
    try {
      const res = await fetch(`/api/scan/${selectedId}/retry`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setSelectedId(data.scanId);
        if (onSwitchScan) onSwitchScan(data.scanId);
        loadAllScans();
      }
    } catch {}
    setRetrying(false);
  };

  const handleExport = () => {
    if (!selectedScan) return;
    const data = JSON.stringify(selectedScan, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedScan.runName || selectedId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isFailed = selectedScan && (selectedScan.status === 'failed' || selectedScan.status === 'error');
  const isSession = selectedId?.startsWith('scan-');
  const isMobile = selectedScan?.source === 'mobile' || selectedScan?.source === 'mobile-dynamic' || selectedId?.startsWith('mobile-');
  const findingsCount = selectedScan?.findings?.length || selectedScan?.mergedFindings?.length || selectedScan?.findingsCount || 0;

  return (
    <div className="sm-layout">
      {/* Sidebar */}
      <div className="sm-sidebar">
        <div className="sm-sidebar-header">
          <h3>All Scans ({allScans.length})</h3>
        </div>
        <div className="sm-list">
          {allScans.length === 0 && <div className="sm-empty">No scans yet. Start one from the New Scan tab.</div>}
          {allScans.map(s => (
            <div key={s.id}
              className={`sm-item ${s.id === selectedId ? 'active' : ''}`}
              onClick={() => handleSelect(s.id)}>
              <span className="sm-dot" style={{ background: STATUS_COLORS[s.status] || 'gray' }} />
              <div className="sm-item-info">
                {renaming === s.id ? (
                  <form className="sm-rename-form" onSubmit={e => { e.preventDefault(); handleRename(s.id); }} onClick={e => e.stopPropagation()}>
                    <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                      onBlur={() => handleRename(s.id)} onKeyDown={e => e.key === 'Escape' && setRenaming(null)} />
                  </form>
                ) : (
                  <span className="sm-target" onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenaming(s.id);
                    setRenameValue(s.runName || s.targets?.join(', ') || '');
                  }}>
                    {s.runName || s.targets?.join(', ') || 'Unknown'}
                  </span>
                )}
                <span className="sm-meta">
                  {s.source === 'disk' ? '💾 ' : s.source === 'mobile' ? '📱 ' : s.source === 'mobile-dynamic' ? '📱🔄 ' : ''}
                  {s.scanMode !== 'unknown' ? `${s.scanMode} · ` : ''}
                  {s.testingType !== 'unknown' ? `${s.testingType} · ` : ''}
                  {new Date(s.startedAt).toLocaleString()}
                </span>
                {s.findingsCount > 0 && (
                  <span className="sm-findings-badge">{s.findingsCount} findings</span>
                )}
              </div>
              <div className="sm-item-right">
                <span className={`sm-status ${s.status}`}>{s.status}</span>
                <button className={`sm-delete ${confirmDelete === s.id ? 'confirm' : ''}`}
                  onClick={(e) => handleDelete(s.id, e)}
                  title={confirmDelete === s.id ? 'Click again to confirm' : 'Delete'}>
                  {confirmDelete === s.id ? '!!' : '×'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Detail Panel */}
      <div className="sm-detail">
        {!selectedScan ? (
          <div className="panel">
            <div className="empty-state">
              <p>{allScans.length ? 'Select a scan to view details' : 'Start a scan from the New Scan tab'}</p>
            </div>
          </div>
        ) : (
          <div className="panel full-height">
            {/* Header */}
            <div className="sm-detail-header">
              <div>
                <h2>{selectedScan.runName || selectedScan.targets?.join(', ') || 'Scan'}</h2>
                <div className="sm-detail-meta">
                  <span className="sm-dot" style={{ background: STATUS_COLORS[selectedScan.status] }} />
                  <span>{selectedScan.status}</span>
                  <span>·</span>
                  <span>{selectedScan.scanMode}</span>
                  <span>·</span>
                  <span>{selectedScan.testingType}</span>
                  {selectedScan.startedAt && <><span>·</span><span>{new Date(selectedScan.startedAt).toLocaleString()}</span></>}
                </div>
              </div>
              <div className="sm-detail-actions">
                {findingsCount > 0 && (
                  <button className="btn-small btn-findings" onClick={() => onViewFindings?.(selectedId, selectedScan.findings)}>
                    View {findingsCount} Findings
                  </button>
                )}
                {findingsCount > 0 && (
                  <button className="btn-small btn-report" onClick={() => {
                    const findings = selectedScan.findings || selectedScan.mergedFindings || [];
                    onGenerateReport?.(selectedId, findings, {
                      targets: selectedScan.target ? [selectedScan.target] : (selectedScan.appInfo?.packageName ? [selectedScan.appInfo.packageName] : []),
                      testingType: selectedScan.testingType,
                      scanMode: selectedScan.scanMode || selectedScan.scanType,
                      startDate: selectedScan.startedAt ? new Date(selectedScan.startedAt).toLocaleDateString() : undefined,
                      targetName: selectedScan.appInfo?.packageName || selectedScan.target || selectedScan.fileName,
                      mobile: isMobile,
                    });
                  }}>
                    Generate Report
                  </button>
                )}
                <button className="btn-small btn-export" onClick={handleExport} title="Export JSON">Export</button>
                {selectedScan.status === 'running' && (
                  <button className="btn-small btn-danger" onClick={handleStop}>Stop</button>
                )}
                {isFailed && isSession && (
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

            {/* Inline Config */}
            {showConfig && (
              <div className="inline-config">
                <div className="inline-config-row">
                  <div className="field" style={{ flex: 1 }}>
                    <label>LLM Provider</label>
                    <select value={llm} onChange={e => setLlm(e.target.value)}>
                      <option value="">Select...</option>
                      {providers.map(p => <option key={p.id} value={p.id}>{p.name}{p.local ? ' ✦ FREE' : ''}</option>)}
                    </select>
                  </div>
                  {!llm.startsWith('ollama/') && (
                    <>
                      <div className="field" style={{ flex: 1 }}>
                        <label>API Key</label>
                        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Enter new API key" />
                      </div>
                      <div className="field" style={{ flex: 1 }}>
                        <label>API Base URL</label>
                        <input value={apiBase} onChange={e => setApiBase(e.target.value)} placeholder="e.g. https://api.kimi.ai/coding/v1" />
                      </div>
                    </>
                  )}
                  <button className="btn-save-inline" onClick={handleSaveConfig} disabled={saving || !llm}>
                    {saving ? '...' : configSaved ? 'Saved!' : 'Save'}
                  </button>
                </div>
                {llm.startsWith('ollama/') && <div className="ollama-info" style={{ marginTop: 8, marginBottom: 0 }}><span className="free-badge">FREE</span><span>Local model - no API key needed</span></div>}
              </div>
            )}

            {/* Scan info bar */}
            {selectedScan.targets && (
              <div className="scan-info">
                <span>Targets: <strong>{selectedScan.targets.join(', ')}</strong></span>
                {selectedScan.finishedAt && <span>Duration: {getDuration(selectedScan.startedAt, selectedScan.finishedAt)}</span>}
                {selectedScan.retriedFrom && <span className="retry-badge">Retried from {selectedScan.retriedFrom}</span>}
              </div>
            )}

            {/* App info for mobile scans */}
            {isMobile && selectedScan.appInfo && (
              <div className="scan-info" style={{ flexWrap: 'wrap' }}>
                {selectedScan.appInfo.appName && <span>App: <strong>{selectedScan.appInfo.appName}</strong></span>}
                {selectedScan.appInfo.packageName && <span>Package: <strong>{selectedScan.appInfo.packageName}</strong></span>}
                {selectedScan.appInfo.version && <span>Version: <strong>{selectedScan.appInfo.version}</strong></span>}
                {selectedScan.appInfo.securityScore != null && <span>Score: <strong>{selectedScan.appInfo.securityScore}/100</strong></span>}
              </div>
            )}

            {/* Mobile scan phases */}
            {isMobile && selectedScan.phases?.length > 0 && (
              <div style={{ display: 'flex', gap: 8, padding: '12px 16px', flexWrap: 'wrap' }}>
                {selectedScan.phases.map((phase, i) => (
                  <span key={i} className={`sm-phase-badge ${phase.status}`}>
                    <span>{PHASE_ICONS[phase.status] || '?'}</span>
                    {PHASE_LABELS[phase.name] || phase.name}
                    {phase.findingsCount != null && ` (${phase.findingsCount})`}
                  </span>
                ))}
                {selectedScan.status === 'running' && <span className="sm-phase-badge running"><span>{PHASE_ICONS.running}</span> Scanning...</span>}
              </div>
            )}

            {/* Findings summary if any */}
            {findingsCount > 0 && (
              <div className="sm-findings-summary">
                <FindingsSummaryBar findings={selectedScan.findings || []} />
              </div>
            )}

            {/* Dynamic scan: API endpoints + config checks */}
            {selectedScan.scanType === 'dynamic' && selectedScan.apiEndpoints?.length > 0 && (
              <div className="scan-info" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                <strong style={{ fontSize: 12, marginBottom: 6 }}>Discovered API Endpoints ({selectedScan.apiEndpoints.length})</strong>
                <div style={{ maxHeight: 120, overflow: 'auto', width: '100%', fontFamily: "'SF Mono', monospace", fontSize: 11, lineHeight: 1.6 }}>
                  {selectedScan.apiEndpoints.slice(0, 30).map((ep, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>{ep}</div>)}
                  {selectedScan.apiEndpoints.length > 30 && <div style={{ color: 'var(--accent)' }}>...and {selectedScan.apiEndpoints.length - 30} more</div>}
                </div>
              </div>
            )}

            {selectedScan.scanType === 'dynamic' && selectedScan.configChecks && (
              <div style={{ display: 'flex', gap: 8, padding: '8px 16px', flexWrap: 'wrap' }}>
                {selectedScan.configChecks.antiFrida && (
                  <span className="sm-phase-badge completed">Anti-Frida: active</span>
                )}
                {selectedScan.configChecks.sslPinning && (
                  <span className={`sm-phase-badge ${
                    selectedScan.configChecks.sslPinning === 'anti_tamper' ? 'completed' :
                    selectedScan.configChecks.sslPinning === 'bypassed' ? 'warning' :
                    selectedScan.configChecks.sslPinning === 'basic_only' ? 'warning' : 'error'
                  }`}>
                    SSL Pinning: {selectedScan.configChecks.sslPinning === 'anti_tamper' ? 'protected' : selectedScan.configChecks.sslPinning === 'bypassed' ? 'bypassed' : selectedScan.configChecks.sslPinning === 'basic_only' ? 'weak' : selectedScan.configChecks.sslPinning}
                  </span>
                )}
                {selectedScan.configChecks.rootDetection && (
                  <span className={`sm-phase-badge ${
                    selectedScan.configChecks.rootDetection === 'anti_tamper' ? 'completed' :
                    selectedScan.configChecks.rootDetection === 'bypassed' ? 'warning' :
                    selectedScan.configChecks.rootDetection === 'basic_only' ? 'warning' : 'error'
                  }`}>
                    Root Detect: {selectedScan.configChecks.rootDetection === 'anti_tamper' ? 'protected' : selectedScan.configChecks.rootDetection === 'bypassed' ? 'bypassed' : selectedScan.configChecks.rootDetection === 'basic_only' ? 'weak' : selectedScan.configChecks.rootDetection}
                  </span>
                )}
                {selectedScan.configChecks.insecureStorage && (
                  <span className={`sm-phase-badge ${selectedScan.configChecks.insecureStorage === 'ok' ? 'completed' : 'error'}`}>
                    Storage: {selectedScan.configChecks.insecureStorage}
                  </span>
                )}
                {selectedScan.configChecks.hardcodedCreds?.length > 0 && (
                  <span className="sm-phase-badge error">Hardcoded Creds: {selectedScan.configChecks.hardcodedCreds.length}</span>
                )}
              </div>
            )}

            {/* Mobile: progress log */}
            {isMobile && selectedScan.progress?.length > 0 && (
              <div className="output-area" ref={outputRef}>
                <div style={{ fontFamily: "'SF Mono', monospace", fontSize: 12, lineHeight: 1.8 }}>
                  {selectedScan.progress.map((entry, i) => (
                    <div key={i} style={{ color: entry.type === 'error' ? 'var(--danger)' : entry.type === 'warning' ? 'var(--warning)' : entry.type === 'complete' ? 'var(--success)' : 'var(--text-secondary)' }}>
                      {entry.message || `${entry.skill}: ${entry.status}${entry.count != null ? ` (${entry.count} findings)` : ''}`}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Web scan: CLI output */}
            {!isMobile && selectedScan.output != null && (
              <div className="output-area" ref={outputRef}>
                <pre>{selectedScan.output || 'Waiting for output...'}</pre>
              </div>
            )}
            {!isMobile && selectedScan.output == null && (
              <div className="sm-no-output">
                <p>This is a past run loaded from disk. No live output available.</p>
                {findingsCount > 0 && (
                  <button className="btn-primary" style={{ maxWidth: 300 }} onClick={() => onViewFindings?.(selectedId, selectedScan.findings)}>
                    View {findingsCount} Findings
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FindingsSummaryBar({ findings }) {
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const colors = { Critical: '#ff4757', High: '#ff6b35', Medium: '#ffa502', Low: '#2ed573', Info: '#70a1ff' };
  const order = ['Critical', 'High', 'Medium', 'Low', 'Info'];

  return (
    <div className="findings-bar">
      {order.filter(s => counts[s]).map(s => (
        <div key={s} className="findings-bar-item" style={{ '--bar-color': colors[s] }}>
          <span className="findings-bar-count">{counts[s]}</span>
          <span className="findings-bar-label">{s}</span>
        </div>
      ))}
    </div>
  );
}

function getDuration(start, end) {
  const ms = new Date(end) - new Date(start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
