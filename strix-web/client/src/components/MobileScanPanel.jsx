import React, { useState, useEffect, useRef, useCallback } from 'react';
import './MobileScan.css';

export default function MobileScanPanel({ configured, onScanStarted }) {
  const [file, setFile] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const [scanMode, setScanMode] = useState('dynamic');
  const [mobsfOnline, setMobsfOnline] = useState(false);
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [useMobSF, setUseMobSF] = useState(true);
  const [useAIAgent, setUseAIAgent] = useState(true);
  const [skills, setSkills] = useState([]);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [testingType, setTestingType] = useState('blackbox');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Dynamic scan state
  const [dynamicStatus, setDynamicStatus] = useState(null);
  const [crawlDuration, setCrawlDuration] = useState(300);
  const [startingStack, setStartingStack] = useState(false);

  const fileInputRef = useRef(null);

  useEffect(() => {
    window.apiFetch('/api/mobile/status').then(r => r.json()).then(data => {
      setMobsfOnline(data.mobsfAvailable);
      setDockerAvailable(data.dockerAvailable);
      setSkills(data.skills || []);
      setSelectedSkills((data.skills || []).map(s => s.id));
    }).catch(() => {});
  }, []);

  // Poll dynamic stack status
  useEffect(() => {
    if (scanMode !== 'dynamic') return;
    const check = () => {
      window.apiFetch('/api/mobile/dynamic/status').then(r => r.json()).then(setDynamicStatus).catch(() => {});
    };
    check();
    const iv = setInterval(check, 10000);
    return () => clearInterval(iv);
  }, [scanMode]);

  const handleFile = useCallback(async (f) => {
    const valid = /\.(apk|ipa|appx|zip)$/i;
    if (!valid.test(f.name)) {
      setError('Only .apk, .ipa, .appx, .zip files are supported');
      return;
    }
    setFile(f);
    setError('');
    setUploading(true);
    const form = new FormData();
    form.append('file', f);
    try {
      const res = await window.apiFetch('/api/mobile/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) {
        setUploadedFile(data);
      } else {
        setError(data.error || 'Upload failed');
        setFile(null);
      }
    } catch {
      setError('Upload failed');
      setFile(null);
    }
    setUploading(false);
  }, []);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const removeFile = () => {
    setFile(null);
    setUploadedFile(null);
  };

  const startStaticScan = async () => {
    if (!uploadedFile) return;
    setError('');
    try {
      const res = await window.apiFetch('/api/mobile/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: uploadedFile.path,
          fileName: uploadedFile.name,
          useMobSF,
          useAIAgent,
          skills: selectedSkills.length ? selectedSkills : undefined,
          testingType,
          credentials: testingType === 'greybox' && username ? `${username}:${password}` : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setFile(null);
        setUploadedFile(null);
        onScanStarted?.(data.scanId, { fileName: uploadedFile.name, testingType, source: 'mobile' });
      } else {
        setError(data.error || 'Failed to start scan');
      }
    } catch {
      setError('Failed to connect to server');
    }
  };

  const startDynamicScan = async () => {
    if (!uploadedFile) return;
    setError('');
    try {
      const res = await window.apiFetch('/api/mobile/dynamic/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: uploadedFile.path,
          fileName: uploadedFile.name,
          testingType,
          crawlDuration: crawlDuration,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setFile(null);
        setUploadedFile(null);
        onScanStarted?.(data.scanId, { fileName: uploadedFile.name, testingType, source: 'mobile-dynamic', scanType: 'dynamic' });
      } else {
        setError(data.error || 'Failed to start dynamic scan');
      }
    } catch {
      setError('Failed to connect to server');
    }
  };

  const startDockerStack = async () => {
    setStartingStack(true);
    try {
      const res = await window.apiFetch('/api/mobile/dynamic/start', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Failed to start Docker stack');
      // Refresh status
      setTimeout(() => {
        window.apiFetch('/api/mobile/dynamic/status').then(r => r.json()).then(setDynamicStatus).catch(() => {});
      }, 3000);
    } catch {
      setError('Failed to start Docker stack');
    }
    setStartingStack(false);
  };

  const stopDockerStack = async () => {
    try {
      await window.apiFetch('/api/mobile/dynamic/stop', { method: 'POST' });
      setDynamicStatus(null);
    } catch {}
  };

  const toggleSkill = (id) => {
    setSelectedSkills(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const stackReady = dynamicStatus?.emulator && dynamicStatus?.mitmproxy;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Mobile Pentest</h2>
        <div className="scan-mode-tabs">
          <button className={`mode-tab ${scanMode === 'dynamic' ? 'active' : ''}`}
            onClick={() => setScanMode('dynamic')}>Dynamic</button>
          <button className={`mode-tab ${scanMode === 'static' ? 'active' : ''}`}
            onClick={() => setScanMode('static')}>Static</button>
        </div>
      </div>

      {/* Dynamic scan mode: infrastructure status bar */}
      {scanMode === 'dynamic' && (
        <div className="dynamic-status-bar">
          <div className="status-items">
            <StatusDot label="Emulator" ok={dynamicStatus?.emulator} />
            <StatusDot label="mitmproxy" ok={dynamicStatus?.mitmproxy} />
            <StatusDot label="Frida" ok={dynamicStatus?.frida} />
            {dynamicStatus?.profile && (
              <span className="profile-badge">
                {dynamicStatus.profile === 'linux' ? 'KVM' : dynamicStatus.profile === 'hybrid' ? 'Host Emu' : 'Device'}
              </span>
            )}
            {dynamicStatus?.mode && (
              <span className="profile-badge auto-detect">Auto</span>
            )}
          </div>
          {stackReady && (
            <div className="status-actions">
              <button className="btn-small btn-stop-stack" onClick={stopDockerStack}>Stop Stack</button>
            </div>
          )}
        </div>
      )}

      {/* Upload Zone */}
      {!uploadedFile ? (
        <div
          className={`mobile-upload-zone ${dragOver ? 'drag-over' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept=".apk,.ipa,.appx,.zip"
            onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; }}
            style={{ display: 'none' }} />
          {uploading ? (
            <span className="upload-title">Uploading...</span>
          ) : (
            <>
              <span className="upload-icon">📱</span>
              <div className="upload-title">Drop APK or IPA file here</div>
              <div className="upload-hint">or click to browse</div>
              <div className="upload-formats">.apk (Android) / .ipa (iOS) / .appx (Windows)</div>
            </>
          )}
        </div>
      ) : (
        <div className="mobile-upload-zone has-file">
          <div className="mobile-file-info">
            <div className={`file-icon-large ${uploadedFile.ext?.replace('.', '') || 'apk'}`}>
              {(uploadedFile.ext || '.apk').replace('.', '').toUpperCase()}
            </div>
            <div className="file-details">
              <span className="file-name">{uploadedFile.name}</span>
              <span className="file-meta">{formatSize(uploadedFile.size)}</span>
            </div>
            <button className="btn-remove-file" onClick={removeFile}>x</button>
          </div>
        </div>
      )}

      {/* Scan Options */}
      {uploadedFile && scanMode === 'dynamic' && (
        <div className="mobile-scan-options">
          <div className="option-section">
            <label>Crawl Duration</label>
            <div className="crawl-duration-row">
              <input type="range" min={60} max={900} step={30} value={crawlDuration}
                onChange={e => setCrawlDuration(Number(e.target.value))} />
              <span className="duration-label">{Math.floor(crawlDuration / 60)}m {crawlDuration % 60 ? `${crawlDuration % 60}s` : ''}</span>
            </div>
            <span className="hint">AI will auto-click through all app screens to discover API endpoints</span>
          </div>

          <div className="option-section">
            <label>Pipeline (fully automated)</label>
            <div className="pipeline-steps">
              <PipelineStep n={1} label="Auto-detect OS" desc="Detect platform → start emulator + mitmproxy" />
              <PipelineStep n={2} label="Install APK" desc="Deploy to emulator, detect package" />
              <PipelineStep n={3} label="SSL + Root Bypass" desc="Frida hooks for traffic interception" />
              <PipelineStep n={4} label="AI Crawl" desc="Auto-explore all screens & functions" />
              <PipelineStep n={5} label="Strix API Pentest" desc="SQLi, IDOR, auth bypass on captured endpoints" />
              <PipelineStep n={6} label="Config Checks" desc="Pinning, root detect, storage, hardcoded creds" />
            </div>
          </div>

          <div className="option-section">
            <label>Testing Type</label>
            <div className="radio-group">
              <label className={`radio-card ${testingType === 'blackbox' ? 'selected' : ''}`}>
                <input type="radio" name="mobileTestType" value="blackbox"
                  checked={testingType === 'blackbox'} onChange={() => setTestingType('blackbox')} />
                <div>
                  <strong>Black Box</strong>
                  <span>No credentials, external attacker perspective</span>
                </div>
              </label>
              <label className={`radio-card ${testingType === 'greybox' ? 'selected' : ''}`}>
                <input type="radio" name="mobileTestType" value="greybox"
                  checked={testingType === 'greybox'} onChange={() => setTestingType('greybox')} />
                <div>
                  <strong>Grey Box</strong>
                  <span>With credentials, authenticated user perspective</span>
                </div>
              </label>
            </div>
          </div>

          {stackReady && (
            <div className="dynamic-links">
              {dynamicStatus?.profile === 'linux' && (
                <a href="http://localhost:6080" target="_blank" rel="noopener noreferrer">noVNC Emulator</a>
              )}
              <a href="http://localhost:8081" target="_blank" rel="noopener noreferrer">mitmweb UI</a>
            </div>
          )}

          {!stackReady && (
            <div className="auto-start-hint">
              Infrastructure will auto-start when you click "Start Pentest" — just drop the APK and go.
            </div>
          )}
        </div>
      )}

      {uploadedFile && scanMode === 'static' && (
        <div className="mobile-scan-options">
          <div className="option-section">
            <label>Scan Engines</label>
            <div className="skill-grid">
              <label className={`skill-toggle ${useMobSF ? 'active' : ''}`}>
                <input type="checkbox" checked={useMobSF} onChange={() => setUseMobSF(!useMobSF)} />
                <div>
                  <div className="skill-name">MobSF (Rule-based)</div>
                  <div className="skill-desc">
                    {mobsfOnline ? 'Running — ready to scan' :
                     dockerAvailable ? 'Auto-starts Docker when scan begins' :
                     'Install Docker to enable'}
                  </div>
                </div>
              </label>
              <label className={`skill-toggle ${useAIAgent ? 'active' : ''}`}>
                <input type="checkbox" checked={useAIAgent} onChange={() => setUseAIAgent(!useAIAgent)} />
                <div>
                  <div className="skill-name">AI Agent (LLM-powered)</div>
                  <div className="skill-desc">Deep analysis with OWASP MASTG</div>
                </div>
              </label>
            </div>
          </div>

          {useAIAgent && (
            <div className="option-section">
              <label>AI Skills</label>
              <div className="skill-grid">
                {skills.filter(s => s.id !== 'finding_enrichment').map(skill => (
                  <label key={skill.id} className={`skill-toggle ${selectedSkills.includes(skill.id) ? 'active' : ''}`}>
                    <input type="checkbox" checked={selectedSkills.includes(skill.id)}
                      onChange={() => toggleSkill(skill.id)} />
                    <div>
                      <div className="skill-name">{skill.name}</div>
                      <div className="skill-desc">{skill.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="option-section">
            <label>Testing Type</label>
            <div className="radio-group">
              <label className={`radio-card ${testingType === 'blackbox' ? 'selected' : ''}`}>
                <input type="radio" name="mobileTestType" value="blackbox"
                  checked={testingType === 'blackbox'} onChange={() => setTestingType('blackbox')} />
                <div>
                  <strong>Black Box</strong>
                  <span>No credentials, external attacker perspective</span>
                </div>
              </label>
              <label className={`radio-card ${testingType === 'greybox' ? 'selected' : ''}`}>
                <input type="radio" name="mobileTestType" value="greybox"
                  checked={testingType === 'greybox'} onChange={() => setTestingType('greybox')} />
                <div>
                  <strong>Grey Box</strong>
                  <span>With credentials, authenticated user perspective</span>
                </div>
              </label>
            </div>
          </div>

          {testingType === 'greybox' && (
            <div className="option-section">
              <label>Test Credentials</label>
              <div style={{ display: 'flex', gap: 10 }}>
                <input value={username} onChange={e => setUsername(e.target.value)}
                  placeholder="Username" style={{ flex: 1 }} />
                <input value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Password" type="password" style={{ flex: 1 }} />
              </div>
              <span className="hint" style={{ marginTop: 6, display: 'block' }}>Credentials for authenticated testing of the app's backend APIs</span>
            </div>
          )}
        </div>
      )}

      {error && <div className="error-msg" style={{ marginTop: 12 }}>{error}</div>}

      {/* Start Button */}
      {uploadedFile && (
        <button className="btn-primary btn-start" style={{ marginTop: 16 }}
          onClick={scanMode === 'dynamic' ? startDynamicScan : startStaticScan}
          disabled={scanMode === 'static' && (!configured || (!useMobSF && !useAIAgent))}>
          {scanMode === 'dynamic'
            ? 'Start Pentest'
            : (!configured ? 'Configure LLM First' : 'Start Static Scan')}
        </button>
      )}
    </div>
  );
}

function StatusDot({ label, ok }) {
  return (
    <span className={`infra-status ${ok ? 'online' : 'offline'}`}>
      <span className={`status-dot ${ok ? 'online' : 'offline'}`} />
      {label}
    </span>
  );
}

function PipelineStep({ n, label, desc }) {
  return (
    <div className="pipeline-step">
      <span className="step-number">{n}</span>
      <div>
        <div className="step-label">{label}</div>
        <div className="step-desc">{desc}</div>
      </div>
    </div>
  );
}
