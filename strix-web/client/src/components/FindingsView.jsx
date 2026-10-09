import React, { useState } from 'react';
import './Findings.css';

const SEVERITY_COLORS = {
  Critical: '#ff4757',
  High: '#ff6b35',
  Medium: '#ffa502',
  Low: '#2ed573',
  Info: '#70a1ff',
};

const SEVERITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const STATUSES = ['Open', 'Confirmed', 'False Positive', 'Accepted Risk', 'Fixed', 'Retest'];

export default function FindingsView({ findings, findingsMap = {}, viewingScanId, onSelectScan, onFindingsUpdated }) {
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('all');

  const scanIds = Object.keys(findingsMap).filter(k => findingsMap[k]?.length > 0);

  const filtered = filter === 'all'
    ? findings
    : findings.filter(f => f.severity === filter);

  const sorted = [...filtered].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5));

  const selected = findings.find(f => f.id === selectedId);
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const updateFinding = async (findingId, updates) => {
    const scanId = viewingScanId;
    if (!scanId) return;
    let url, method = 'PATCH';
    if (scanId.startsWith('scan-') || scanId.startsWith('mobile-')) {
      url = `/api/scan/${scanId}/finding/${findingId}`;
    } else if (scanId.startsWith('run-')) {
      const runName = scanId.replace('run-', '');
      url = `/api/runs/${encodeURIComponent(runName)}/finding/${findingId}`;
    } else return;
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
    if (res.ok && onFindingsUpdated) onFindingsUpdated(scanId);
    return res.ok;
  };

  const deleteFinding = async (findingId) => {
    const scanId = viewingScanId;
    if (!scanId) return;
    let url;
    if (scanId.startsWith('scan-') || scanId.startsWith('mobile-')) {
      url = `/api/scan/${scanId}/finding/${findingId}`;
    } else if (scanId.startsWith('run-')) {
      const runName = scanId.replace('run-', '');
      url = `/api/runs/${encodeURIComponent(runName)}/finding/${findingId}`;
    } else return;
    const res = await fetch(url, { method: 'DELETE' });
    if (res.ok) {
      setSelectedId(null);
      if (onFindingsUpdated) onFindingsUpdated(scanId);
    }
  };

  if (!findings.length && !scanIds.length) {
    return (
      <div className="panel">
        <div className="panel-header"><h2>Findings</h2></div>
        <div className="empty-state">
          <p>No findings yet. Run a scan first, or load findings from scan history.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="findings-layout">
      {/* Left: List */}
      <div className="findings-list">
        {scanIds.length > 1 && (
          <div className="scan-selector">
            <label>Scan:</label>
            <select value={viewingScanId || ''} onChange={e => onSelectScan?.(e.target.value)}>
              {scanIds.map(id => (
                <option key={id} value={id}>{id} ({findingsMap[id].length} findings)</option>
              ))}
            </select>
          </div>
        )}
        <div className="findings-header">
          <h2>Findings ({findings.length})</h2>
          <div className="severity-filters">
            <button className={`sev-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
              All
            </button>
            {Object.entries(counts).sort(([a], [b]) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b]).map(([sev, count]) => (
              <button key={sev}
                className={`sev-btn ${filter === sev ? 'active' : ''}`}
                style={{ '--sev-color': SEVERITY_COLORS[sev] }}
                onClick={() => setFilter(sev)}>
                {sev} ({count})
              </button>
            ))}
          </div>
        </div>

        <div className="findings-items">
          {sorted.map(f => (
            <button key={f.id}
              className={`finding-item ${selectedId === f.id ? 'selected' : ''}`}
              onClick={() => setSelectedId(f.id)}>
              <span className="sev-badge" style={{ background: SEVERITY_COLORS[f.severity] }}>
                {f.severity}
              </span>
              <div className="finding-item-body">
                <strong>{f.title}</strong>
                <span className="finding-item-meta">
                  {f.id} {f.affectedAsset && `· ${f.affectedAsset}`}
                </span>
                {f.status && f.status !== 'Open' && (
                  <span className={`finding-status-badge ${f.status.toLowerCase().replace(' ', '-')}`}>{f.status}</span>
                )}
              </div>
              {f.confidence && <span className="confidence">{f.confidence}%</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Right: Detail */}
      <div className="finding-detail">
        {selected ? (
          <FindingDetail finding={selected} onUpdate={updateFinding} onDelete={deleteFinding} />
        ) : (
          <div className="empty-state"><p>Select a finding to view details</p></div>
        )}
      </div>
    </div>
  );
}

function FindingDetail({ finding, onUpdate, onDelete }) {
  const f = finding;
  const [editing, setEditing] = useState(null);
  const [notes, setNotes] = useState(f.notes || '');
  const [showNotes, setShowNotes] = useState(!!f.notes);
  const [confirmDel, setConfirmDel] = useState(false);

  React.useEffect(() => {
    setNotes(f.notes || '');
    setShowNotes(!!f.notes);
    setEditing(null);
    setConfirmDel(false);
  }, [f.id]);

  const handleSeverityChange = async (newSev) => {
    await onUpdate(f.id, { severity: newSev });
    setEditing(null);
  };

  const handleStatusChange = async (newStatus) => {
    await onUpdate(f.id, { status: newStatus });
    setEditing(null);
  };

  const handleSaveNotes = async () => {
    await onUpdate(f.id, { notes });
  };

  const handleDelete = async () => {
    if (!confirmDel) { setConfirmDel(true); setTimeout(() => setConfirmDel(false), 3000); return; }
    await onDelete(f.id);
  };

  return (
    <div className="detail-content">
      {/* Header */}
      <div className="detail-header">
        <div className="detail-title-row">
          {editing === 'severity' ? (
            <div className="inline-edit-dropdown">
              {SEVERITIES.map(s => (
                <button key={s} className="sev-option" style={{ background: SEVERITY_COLORS[s] }} onClick={() => handleSeverityChange(s)}>{s}</button>
              ))}
              <button className="sev-option cancel" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          ) : (
            <span className="sev-badge large clickable" style={{ background: SEVERITY_COLORS[f.severity] }} onClick={() => setEditing('severity')} title="Click to change severity">
              {f.severity}
            </span>
          )}
          <span className="finding-id">{f.id}</span>
          <div className="detail-actions-right">
            <button className={`btn-small ${confirmDel ? 'btn-danger' : 'btn-delete-finding'}`} onClick={handleDelete}>
              {confirmDel ? 'Confirm Delete' : 'Delete'}
            </button>
          </div>
        </div>
        <h2>{f.title}</h2>
        <div className="detail-tags">
          {f.owaspCategory && <span className="tag">{f.owaspCategory}</span>}
          {f.cwe && <span className="tag">CWE-{f.cwe}</span>}
          {f.cvss && <span className="tag">CVSS {f.cvss}</span>}
          {editing === 'status' ? (
            <div className="inline-edit-dropdown status-dropdown">
              {STATUSES.map(s => (
                <button key={s} className={`status-option ${s === f.status ? 'active' : ''}`} onClick={() => handleStatusChange(s)}>{s}</button>
              ))}
              <button className="status-option cancel" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          ) : (
            <span className="tag status-tag clickable" onClick={() => setEditing('status')} title="Click to change status">{f.status}</span>
          )}
        </div>
      </div>

      {/* Sidebar info */}
      <div className="detail-meta-grid">
        <div className="meta-item"><label>Status</label><span>{f.status}</span></div>
        {f.confidence && <div className="meta-item"><label>Confidence</label><span>{f.confidence}%</span></div>}
        {f.cvss && <div className="meta-item"><label>CVSS Score</label><span>{f.cvss}</span></div>}
        {f.affectedAsset && <div className="meta-item"><label>Affected Asset</label><span className="mono">{f.affectedAsset}</span></div>}
        {f.method && <div className="meta-item"><label>Method</label><span>{f.method}</span></div>}
        {f.fixEffort && <div className="meta-item"><label>Fix Effort</label><span>{f.fixEffort}</span></div>}
      </div>

      {/* Attack Flow */}
      {f.affectedAsset && (
        <section className="detail-section">
          <h3>Attack Flow</h3>
          <div className="attack-flow">
            <div className="flow-node">Attacker</div>
            <div className="flow-arrow">&rarr;</div>
            <div className="flow-node highlight">{f.affectedAsset}</div>
            <div className="flow-arrow">&rarr;</div>
            <div className="flow-node result">Exploited</div>
          </div>
        </section>
      )}

      {/* Notes */}
      <section className="detail-section">
        <h3>
          Notes
          {!showNotes && <button className="btn-add-note" onClick={() => setShowNotes(true)}>+ Add Note</button>}
        </h3>
        {showNotes && (
          <div className="notes-editor">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Add internal notes, comments, or observations..." rows={3} />
            <div className="notes-actions">
              <button className="btn-small btn-save-note" onClick={handleSaveNotes}>Save Note</button>
              {!f.notes && <button className="btn-small btn-cancel-note" onClick={() => { setShowNotes(false); setNotes(''); }}>Cancel</button>}
            </div>
          </div>
        )}
      </section>

      {/* Description */}
      <section className="detail-section">
        <h3>Description</h3>
        <div className="detail-text">{f.description || 'No description available.'}</div>
      </section>

      {/* Technical Analysis */}
      {f.technicalAnalysis && (
        <section className="detail-section">
          <h3>Technical Analysis</h3>
          <div className="detail-text">{f.technicalAnalysis}</div>
        </section>
      )}

      {/* Evidence */}
      {(f.evidence?.request || f.evidence?.response || f.evidence?.detail) && (
        <section className="detail-section">
          <h3>Evidence</h3>
          {f.evidence.detail && (
            <div className="evidence-block">
              <pre className="code-block">{f.evidence.detail}</pre>
            </div>
          )}
          {f.evidence.request && (
            <div className="evidence-block">
              <label>Request</label>
              <pre className="code-block">{f.evidence.request}</pre>
            </div>
          )}
          {f.evidence.response && (
            <div className="evidence-block">
              <label>Response</label>
              <pre className="code-block">{f.evidence.response}</pre>
            </div>
          )}
        </section>
      )}

      {/* PoC - Step by Step */}
      {(f.evidence?.steps?.length > 0 || f.pocDescription) && (
        <section className="detail-section">
          <h3>Proof of Concept (PoC)</h3>
          {f.evidence?.steps?.length > 0 && (
            <div className="poc-steps">
              <ol className="steps-list">
                {f.evidence.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </div>
          )}
          {!f.evidence?.steps?.length && f.pocDescription && (
            <div className="detail-text">{f.pocDescription}</div>
          )}
        </section>
      )}

      {/* PoC Script Code */}
      {f.pocScriptCode && (
        <section className="detail-section">
          <h3>PoC Script</h3>
          <pre className="code-block poc-code">{f.pocScriptCode.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')}</pre>
        </section>
      )}

      {/* Impact */}
      {f.impact && (
        <section className="detail-section">
          <h3>Impact</h3>
          <div className="detail-text impact-text">{f.impact}</div>
        </section>
      )}

      {/* Remediation */}
      {(f.remediation || f.remediationSteps) && (
        <section className="detail-section">
          <h3>Remediation</h3>
          <div className="detail-text remediation-text">{f.remediationSteps || f.remediation}</div>
        </section>
      )}
    </div>
  );
}
