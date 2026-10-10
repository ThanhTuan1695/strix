import React, { useState, useEffect, useRef } from 'react';
import './Panel.css';

export default function ScanPanel({ configured, onScanStarted }) {
  const [options, setOptions] = useState({ scanModes: [], scopeModes: [], testingTypes: [] });
  const [targets, setTargets] = useState(['']);
  const [scanMode, setScanMode] = useState('deep');
  const [scopeMode, setScopeMode] = useState('auto');
  const [testingType, setTestingType] = useState('blackbox');
  const [credentialsList, setCredentialsList] = useState([{ role: '', value: '' }]);
  const [instruction, setInstruction] = useState('');
  const [maxBudget, setMaxBudget] = useState('');
  const [maxTurns, setMaxTurns] = useState('');
  const [diffBase, setDiffBase] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [specFiles, setSpecFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    window.apiFetch('/api/scan-options').then(r => r.json()).then(setOptions);
  }, []);

  const addTarget = () => setTargets([...targets, '']);
  const removeTarget = (i) => setTargets(targets.filter((_, idx) => idx !== i));
  const updateTarget = (i, val) => { const t = [...targets]; t[i] = val; setTargets(t); };

  const uploadFile = async (file) => {
    const valid = /\.(json|yaml|yml)$/i;
    if (!valid.test(file.name)) {
      setError('Only .json, .yaml, .yml files are supported');
      return;
    }
    setUploading(true);
    setError('');
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await window.apiFetch('/api/upload-spec', { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) {
        setSpecFiles(prev => [...prev, { name: file.name, path: data.path, size: data.size }]);
      } else {
        setError(data.error || 'Upload failed');
      }
    } catch { setError('Upload failed'); }
    setUploading(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    files.forEach(uploadFile);
  };

  const handleFileSelect = (e) => {
    Array.from(e.target.files).forEach(uploadFile);
    e.target.value = '';
  };

  const removeSpec = (i) => {
    setSpecFiles(prev => prev.filter((_, idx) => idx !== i));
  };

  const handleStart = async () => {
    setStarting(true);
    setError('');
    try {
      const res = await window.apiFetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targets: targets.filter(Boolean),
          scanMode, scopeMode, testingType,
          credentials: credentialsList.some(c => c.value) ? credentialsList.filter(c => c.value).map(c => c.role ? `${c.role}: ${c.value}` : c.value).join('\n') : undefined,
          instruction: instruction || undefined,
          maxBudget: maxBudget ? Number(maxBudget) : undefined,
          maxTurns: maxTurns ? Number(maxTurns) : undefined,
          diffBase: diffBase || undefined,
          workspaceFiles: specFiles.length ? specFiles : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error);
      else onScanStarted(data.scanId, { targets, scanMode, testingType, startDate: new Date().toLocaleDateString() });
    } catch { setError('Failed to connect to server'); }
    setStarting(false);
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="panel">
      <div className="panel-header"><h2>Scan Configuration</h2></div>

      {/* Targets */}
      <div className="field">
        <label>Targets</label>
        {targets.map((t, i) => (
          <div key={i} className="input-row">
            <input value={t} onChange={e => updateTarget(i, e.target.value)}
              placeholder="https://example.com, ./local-path, or GitHub URL" />
            {targets.length > 1 && (
              <button className="btn-icon btn-remove" onClick={() => removeTarget(i)}>×</button>
            )}
          </div>
        ))}
        <button className="btn-link" onClick={addTarget}>+ Add another target</button>
        <span className="hint">URL, GitHub repo, local directory, IP address, or API spec file</span>
      </div>

      {/* API Spec Upload */}
      <div className="field">
        <label>API Specification (optional)</label>
        <div
          className={`spec-dropzone ${dragOver ? 'drag-over' : ''} ${specFiles.length ? 'has-files' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept=".json,.yaml,.yml" multiple
            onChange={handleFileSelect} style={{ display: 'none' }} />
          {uploading ? (
            <span className="spec-uploading">Uploading...</span>
          ) : specFiles.length ? (
            <div className="spec-files-list" onClick={e => e.stopPropagation()}>
              {specFiles.map((f, i) => (
                <div key={i} className="spec-file-item">
                  <span className="spec-file-icon">{f.name.endsWith('.yaml') || f.name.endsWith('.yml') ? 'YAML' : 'JSON'}</span>
                  <div className="spec-file-info">
                    <span className="spec-file-name">{f.name}</span>
                    <span className="spec-file-size">{formatSize(f.size)}</span>
                  </div>
                  <button className="spec-file-remove" onClick={() => removeSpec(i)}>×</button>
                </div>
              ))}
              <button className="btn-link spec-add-more" onClick={() => fileInputRef.current?.click()}>+ Add more files</button>
            </div>
          ) : (
            <div className="spec-placeholder">
              <span className="spec-icon">📄</span>
              <span>Drop OpenAPI/Swagger or Postman Collection here</span>
              <span className="spec-formats">.json / .yaml / .yml</span>
            </div>
          )}
        </div>
        <span className="hint">Upload API spec for targeted API penetration testing</span>
      </div>

      {/* Testing Type */}
      <div className="field">
        <label>Testing Type</label>
        <div className="radio-group">
          {options.testingTypes.map(t => (
            <label key={t.id} className={`radio-card ${testingType === t.id ? 'selected' : ''}`}>
              <input type="radio" name="testingType" value={t.id}
                checked={testingType === t.id} onChange={e => setTestingType(e.target.value)} />
              <div>
                <strong>{t.name}</strong>
                <span>{t.desc}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Credentials for grey/white box */}
      {testingType !== 'blackbox' && (
        <div className="field">
          <label>Test Credentials</label>
          {credentialsList.map((cred, i) => (
            <div key={i} className="cred-row">
              <input className="cred-role" value={cred.role}
                onChange={e => { const c = [...credentialsList]; c[i] = { ...c[i], role: e.target.value }; setCredentialsList(c); }}
                placeholder="Role (e.g. admin)" />
              <input className="cred-value" value={cred.value}
                onChange={e => { const c = [...credentialsList]; c[i] = { ...c[i], value: e.target.value }; setCredentialsList(c); }}
                placeholder="username:password or token" type="password" />
              {credentialsList.length > 1 && (
                <button className="btn-icon btn-remove" onClick={() => setCredentialsList(credentialsList.filter((_, idx) => idx !== i))}>×</button>
              )}
            </div>
          ))}
          <button className="btn-link" onClick={() => setCredentialsList([...credentialsList, { role: '', value: '' }])}>+ Add another role</button>
          <span className="hint">Add credentials per role for privilege escalation testing</span>
        </div>
      )}

      {/* Scan Mode */}
      <div className="field">
        <label>Scan Depth</label>
        <div className="segmented">
          {options.scanModes.map(m => (
            <button key={m.id}
              className={`seg-btn ${scanMode === m.id ? 'active' : ''}`}
              onClick={() => setScanMode(m.id)} title={m.desc}>
              {m.name}
            </button>
          ))}
        </div>
      </div>

      {/* Scope Mode */}
      <div className="field">
        <label>Scope Mode</label>
        <select value={scopeMode} onChange={e => setScopeMode(e.target.value)}>
          {options.scopeModes.map(m => (
            <option key={m.id} value={m.id}>{m.name} — {m.desc}</option>
          ))}
        </select>
      </div>

      {/* Instructions */}
      <div className="field">
        <label>Custom Instructions (optional)</label>
        <textarea value={instruction} onChange={e => setInstruction(e.target.value)}
          placeholder='e.g. "Focus on authentication bypass and IDOR"' rows={3} />
      </div>

      {/* Advanced */}
      <button className="btn-link" onClick={() => setShowAdvanced(!showAdvanced)}>
        {showAdvanced ? '▾' : '▸'} Advanced Options
      </button>
      {showAdvanced && (
        <div className="advanced-section">
          <div className="field-row">
            <div className="field">
              <label>Max Budget (USD)</label>
              <input type="number" value={maxBudget} onChange={e => setMaxBudget(e.target.value)}
                placeholder="e.g. 5.00" min="0" step="0.5" />
            </div>
            <div className="field">
              <label>Max Turns</label>
              <input type="number" value={maxTurns} onChange={e => setMaxTurns(e.target.value)}
                placeholder="500" min="1" />
            </div>
          </div>
          <div className="field">
            <label>Diff Base Branch</label>
            <input value={diffBase} onChange={e => setDiffBase(e.target.value)}
              placeholder="origin/main" />
            <span className="hint">Compare against this branch for diff scope mode</span>
          </div>
        </div>
      )}

      {error && <div className="error-msg">{error}</div>}

      <button className="btn-primary btn-start" onClick={handleStart}
        disabled={!configured || !targets.some(Boolean) || starting}>
        {!configured ? 'Configure LLM First' : starting ? 'Starting Scan...' : specFiles.length ? 'Start API Pentest' : 'Start Pentest'}
      </button>
    </div>
  );
}
