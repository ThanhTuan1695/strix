import React, { useState, useEffect } from 'react';
import './Report.css';

const SEVERITY_COLORS = { Critical: '#ff4757', High: '#ff6b35', Medium: '#ffa502', Low: '#2ed573', Info: '#70a1ff' };

export default function ReportView({ findings, meta, scanId }) {
  const [mode, setMode] = useState('quick');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [clientName, setClientName] = useState('');
  const [targetName, setTargetName] = useState('');

  // Template state
  const [template, setTemplate] = useState(null);
  const [selectedFindings, setSelectedFindings] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [templateDownloadUrl, setTemplateDownloadUrl] = useState(null);

  // Saved reports
  const [savedReports, setSavedReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [viewMode, setViewMode] = useState(findings.length ? 'generate' : 'history');

  useEffect(() => { loadSavedReports(); }, []);

  const loadSavedReports = async () => {
    setLoadingReports(true);
    try {
      const res = await window.apiFetch('/api/reports');
      if (res.ok) setSavedReports(await res.json());
    } catch {}
    setLoadingReports(false);
  };

  const loadSavedReport = async (id) => {
    setLoading(true);
    try {
      const res = await window.apiFetch(`/api/report/${id}`);
      if (!res.ok) throw new Error('Report not found');
      const doc = await res.json();
      setReport(doc.report);
      setViewMode('generate');
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const deleteSavedReport = async (id) => {
    try {
      await window.apiFetch(`/api/report/${id}`, { method: 'DELETE' });
      setSavedReports(prev => prev.filter(r => r.id !== id));
    } catch {}
  };

  // --- Quick report ---
  const generateReport = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await window.apiFetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          findings: selectedFindings.length ? findings.filter((_, i) => selectedFindings.includes(i)) : findings,
          meta: { ...meta, clientName: clientName || 'Target Organization', targetName: targetName || meta.targets?.join(', ') || 'Target Application' },
          scanId: scanId || null,
        }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      setReport(data);
      loadSavedReports();
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const handlePrint = () => window.print();

  const handleDownloadHTML = () => {
    const el = document.getElementById('pentest-report');
    if (!el) return;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pentest Report</title>
<style>body{font-family:-apple-system,sans-serif;background:#1a1a24;color:#e0e0e0;padding:40px;max-width:900px;margin:0 auto}h1{color:#6c5ce7;text-align:center}h2{border-bottom:1px solid #333;padding-bottom:8px}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}th,td{padding:10px 14px;border:1px solid #333;text-align:left}th{background:#252535;font-weight:600}pre{background:#0a0a10;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;color:#2ed573}.sev-badge{display:inline-block;padding:3px 10px;border-radius:12px;color:white;font-size:12px;font-weight:600}@media print{body{background:white;color:black}pre{background:#f5f5f5;color:#333}}</style></head><body>${el.innerHTML}</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pentest-report.html';
    a.click();
  };

  // --- Template ---
  const handleTemplateUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('template', file);
      const res = await window.apiFetch('/api/report/template/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();
      setTemplate(data);
    } catch (e) { setError(e.message); }
    setUploading(false);
  };

  const generateFromTemplate = async () => {
    setLoading(true);
    setError('');
    try {
      const usedFindings = selectedFindings.length
        ? findings.filter((_, i) => selectedFindings.includes(i))
        : findings;
      const res = await window.apiFetch('/api/report/template/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: template.templateId,
          findings: usedFindings,
          meta: { ...meta, clientName, targetName: targetName || meta.targets?.join(', ') || 'Target Application' },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${res.status}`);
      }
      const data = await res.json();
      setTemplateDownloadUrl(data.downloadUrl);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const downloadTemplate = async () => {
    if (!templateDownloadUrl) return;
    try {
      const res = await window.apiFetch(templateDownloadUrl);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'report.docx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setError(e.message); }
  };

  const toggleFinding = (idx) => {
    setSelectedFindings(prev =>
      prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
    );
  };

  const selectAllFindings = () => {
    if (selectedFindings.length === findings.length) setSelectedFindings([]);
    else setSelectedFindings(findings.map((_, i) => i));
  };

  // --- Saved reports list ---
  const renderSavedReports = () => (
    <div className="saved-reports">
      <div className="sr-header">
        <h3>Saved Reports</h3>
        <button className="btn-link" onClick={loadSavedReports}>{loadingReports ? 'Loading...' : 'Refresh'}</button>
      </div>
      {!savedReports.length ? (
        <p className="sr-empty">No saved reports yet.</p>
      ) : (
        <div className="sr-list">
          {savedReports.map(r => (
            <div key={r.id} className="sr-item">
              <div className="sr-info">
                <span className="sr-date">{new Date(r.createdAt).toLocaleString()}</span>
                <span className="sr-meta">{r.findingsCount} findings &middot; by {r.createdBy}</span>
                {r.scanId && <span className="sr-scan">Scan: {r.scanId}</span>}
              </div>
              <div className="sr-actions">
                <button className="btn-sm" onClick={() => loadSavedReport(r.id)}>View</button>
                <button className="btn-sm btn-danger" onClick={() => deleteSavedReport(r.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // --- Report rendered (quick mode) ---
  if (report) {
    const r = report;
    return (
      <div className="report-container">
        <div className="report-actions">
          <button className="btn-primary" onClick={handlePrint}>Print / Save PDF</button>
          <button className="btn-secondary" onClick={handleDownloadHTML}>Download HTML</button>
          <button className="btn-secondary" onClick={() => setReport(null)}>
            {findings.length ? 'Edit Settings' : 'Back'}
          </button>
        </div>
        <div className="report-document" id="pentest-report">
          <section className="report-cover">
            <h1>{r.coverPage.title}</h1>
            <div className="cover-details">
              <p><strong>Client:</strong> {r.coverPage.client}</p>
              <p><strong>Engagement:</strong> {r.coverPage.engagementType}</p>
              <p><strong>Testing Period:</strong> {r.coverPage.testingDates}</p>
              <p><strong>Report Date:</strong> {r.coverPage.reportDate}</p>
              <p><strong>Classification:</strong> {r.coverPage.classification}</p>
            </div>
          </section>
          <section className="report-section"><h2>1. Executive Summary</h2><p>{r.executiveSummary}</p></section>
          <section className="report-section">
            <h2>2. Scope and Methodology</h2>
            <table className="report-table"><tbody>
              <tr><td><strong>Approach</strong></td><td>{r.scope.testingApproach}</td></tr>
              <tr><td><strong>Methodology</strong></td><td>{r.scope.methodology}</td></tr>
              <tr><td><strong>Tools</strong></td><td>{r.scope.tools.join(', ')}</td></tr>
              <tr><td><strong>Targets</strong></td><td>{r.scope.targets.join(', ') || 'See config'}</td></tr>
            </tbody></table>
          </section>
          <section className="report-section">
            <h2>3. Risk Assessment</h2>
            <div className="risk-grid">
              <div>
                <h3>By Severity</h3>
                <table className="report-table"><thead><tr><th>Severity</th><th>Count</th></tr></thead><tbody>
                  {Object.entries(r.riskSummary.severityCounts).filter(([,v]) => v > 0).map(([s,c]) => (
                    <tr key={s}><td><span className="sev-dot" style={{ background: SEVERITY_COLORS[s] }}/>{s}</td><td>{c}</td></tr>
                  ))}
                  <tr className="total-row"><td><strong>Total</strong></td><td><strong>{r.riskSummary.total}</strong></td></tr>
                </tbody></table>
              </div>
              <div>
                <h3>By Category</h3>
                <table className="report-table"><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>
                  {Object.entries(r.riskSummary.categoryCounts).map(([c,n]) => <tr key={c}><td>{c}</td><td>{n}</td></tr>)}
                </tbody></table>
              </div>
            </div>
          </section>
          <section className="report-section">
            <h2>4. Detailed Findings</h2>
            {r.findings.map((f, i) => (
              <div key={f.id} className="report-finding">
                <div className="report-finding-header">
                  <h3>Finding {i+1}: {f.title}</h3>
                  <span className="sev-badge" style={{ background: SEVERITY_COLORS[f.severity] }}>{f.severity}</span>
                </div>
                <table className="report-table finding-meta-table"><tbody>
                  {f.cvss && <tr><td>CVSS</td><td>{f.cvss}</td></tr>}
                  {f.cwe && <tr><td>CWE</td><td>CWE-{f.cwe}</td></tr>}
                  {f.owaspCategory && <tr><td>OWASP</td><td>{f.owaspCategory}</td></tr>}
                  <tr><td>Asset</td><td className="mono">{f.affectedAsset || 'N/A'}</td></tr>
                  <tr><td>Status</td><td>{f.status}</td></tr>
                </tbody></table>
                {f.description && <><h4>Description</h4><p>{f.description}</p></>}
                {f.technicalAnalysis && <><h4>Technical Analysis</h4><p>{f.technicalAnalysis}</p></>}
                {(f.evidence?.detail || f.evidence?.request) && <>
                  <h4>Evidence</h4>
                  {f.evidence.detail && <pre className="report-code">{f.evidence.detail}</pre>}
                  {f.evidence.request && <><strong>Request:</strong><pre className="report-code">{f.evidence.request}</pre></>}
                  {f.evidence.response && <><strong>Response:</strong><pre className="report-code">{f.evidence.response}</pre></>}
                </>}
                {f.evidence?.steps?.length > 0 && <>
                  <h4>Steps to Reproduce</h4>
                  <ol className="report-poc-steps">{f.evidence.steps.map((s,si) => <li key={si}>{s}</li>)}</ol>
                </>}
                {f.pocScriptCode && <><h4>PoC Script</h4><pre className="report-code">{f.pocScriptCode.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')}</pre></>}
                {f.impact && <><h4>Impact</h4><p>{f.impact}</p></>}
                {(f.remediationSteps || f.remediation) && <><h4>Remediation</h4><p>{f.remediationSteps || f.remediation}</p></>}
              </div>
            ))}
          </section>
          <section className="report-section">
            <h2>5. Remediation Roadmap</h2>
            <table className="report-table roadmap-table"><thead><tr><th>#</th><th>Finding</th><th>Severity</th><th>Deadline</th></tr></thead><tbody>
              {r.remediationRoadmap.map(item => (
                <tr key={item.priority}><td>{item.priority}</td><td>{item.finding}</td>
                  <td><span className="sev-badge small" style={{ background: SEVERITY_COLORS[item.severity] }}>{item.severity}</span></td>
                  <td>{item.deadline}</td></tr>
              ))}
            </tbody></table>
          </section>
          <section className="report-section report-footer">
            <p>Report generated by Pentest Agent</p>
            <p>{new Date(r.generatedAt).toLocaleString()}</p>
          </section>
        </div>
      </div>
    );
  }

  // --- Setup form ---
  return (
    <div className="panel report-setup">
      <div className="panel-header">
        <h2>Report</h2>
        <div className="report-view-tabs">
          <button className={`rmt ${viewMode === 'generate' ? 'active' : ''}`} onClick={() => setViewMode('generate')}>Generate New</button>
          <button className={`rmt ${viewMode === 'history' ? 'active' : ''}`} onClick={() => setViewMode('history')}>
            Saved Reports{savedReports.length ? ` (${savedReports.length})` : ''}
          </button>
        </div>
      </div>

      {viewMode === 'history' && renderSavedReports()}

      {viewMode === 'generate' && <>
      {/* Mode tabs */}
      <div className="report-mode-tabs">
        <button className={`rmt ${mode === 'quick' ? 'active' : ''}`} onClick={() => setMode('quick')}>Quick Report</button>
        <button className={`rmt ${mode === 'template' ? 'active' : ''}`} onClick={() => setMode('template')}>From Template (.docx)</button>
      </div>

      {/* Common fields */}
      <div className="report-fields-row">
        <div className="field">
          <label>Client Name</label>
          <input value={clientName} onChange={e => setClientName(e.target.value)} placeholder="e.g. Acme Corp" />
        </div>
        <div className="field">
          <label>Target Application</label>
          <input value={targetName} onChange={e => setTargetName(e.target.value)}
            placeholder={meta.targets?.join(', ') || 'Target Application'} />
        </div>
      </div>

      {findings.length > 0 && (
        <div className="finding-selector">
          <div className="fs-header">
            <strong>Select Findings ({selectedFindings.length || 'All'} / {findings.length})</strong>
            <button className="btn-link" onClick={selectAllFindings}>
              {selectedFindings.length === findings.length ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <div className="fs-list">
            {findings.map((f, i) => (
              <label key={f.id || i} className={`fs-item ${selectedFindings.includes(i) || !selectedFindings.length ? 'selected' : ''}`}>
                <input type="checkbox"
                  checked={selectedFindings.includes(i) || !selectedFindings.length}
                  onChange={() => toggleFinding(i)} />
                <span className="fs-title">{f.title || f.name || `Finding ${i + 1}`}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {!findings.length && mode === 'quick' && (
        <div className="empty-state"><p>No findings available. Complete a scan first, or use "From Template" mode.</p></div>
      )}

      {error && <p className="report-error">{error}</p>}

      {mode === 'quick' && findings.length > 0 && (
        <button className="btn-primary" onClick={generateReport} disabled={loading}>
          {loading ? 'Generating...' : 'Generate Report'}
        </button>
      )}

      {mode === 'template' && (
        <div className="template-section">
          {!template ? (
            <div className="template-upload-area">
              <label className="template-upload-btn">
                {uploading ? 'Uploading...' : 'Upload .docx Template'}
                <input type="file" accept=".docx" onChange={handleTemplateUpload} hidden disabled={uploading} />
              </label>
              <p className="template-hint">Upload a previous report as template. The system will auto-detect the finding details section and fill it with scan data following your template's format.</p>
            </div>
          ) : (
            <>
              <div className="template-info">
                <span className="template-file-badge">{template.fileName}</span>
                <button className="btn-link" onClick={() => { setTemplate(null); setTemplateDownloadUrl(null); }}>Change template</button>
              </div>

              {templateDownloadUrl ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn-primary" onClick={downloadTemplate}>Download .docx</button>
                  <button className="btn-secondary" onClick={() => setTemplateDownloadUrl(null)}>Generate Again</button>
                </div>
              ) : (
                <button className="btn-primary" onClick={generateFromTemplate} disabled={loading || !findings.length}>
                  {loading ? 'Generating...' : 'Generate Report'}
                </button>
              )}
            </>
          )}
        </div>
      )}
      </>}
    </div>
  );
}
