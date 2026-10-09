import React, { useState, useEffect } from 'react';
import './Panel.css';

const API = '/api';

export default function ConfigPanel({ onConfigured }) {
  const [providers, setProviders] = useState([]);
  const [llm, setLlm] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [groqModels, setGroqModels] = useState([]);
  const [loadingGroq, setLoadingGroq] = useState(false);
  const [maskedKey, setMaskedKey] = useState('');
  const [keyChanged, setKeyChanged] = useState(false);

  const isOllama = llm.startsWith('ollama/');
  const isGroq = llm.startsWith('groq/');
  const selectedProvider = providers.find(p => p.id === llm);

  useEffect(() => {
    window.apiFetch(`${API}/providers`).then(r => r.json()).then(setProviders);
    window.apiFetch(`${API}/config`).then(r => r.json()).then(cfg => {
      if (cfg.llm) setLlm(cfg.llm);
      if (cfg.apiBase) setApiBase(cfg.apiBase);
      if (cfg.hasKey) {
        onConfigured(true);
        setMaskedKey(cfg.maskedKey || '••••••••');
      }
    });
  }, []);

  const fetchGroqModels = async (key) => {
    if (!key || key.length < 10) return;
    setLoadingGroq(true);
    try {
      const res = await window.apiFetch(`${API}/groq-models?key=${encodeURIComponent(key)}`);
      const models = await res.json();
      if (models.length) setGroqModels(models);
    } catch {}
    setLoadingGroq(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const body = { llm, apiBase: (isOllama || isGroq) ? '' : apiBase };
    if (isOllama) body.apiKey = 'ollama';
    else if (keyChanged && apiKey) body.apiKey = apiKey;
    const res = await window.apiFetch(`${API}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setSaved(true);
      onConfigured(true);
      if (keyChanged && apiKey) {
        setMaskedKey(apiKey.slice(0, 4) + '•'.repeat(Math.max(0, apiKey.length - 8)) + apiKey.slice(-4));
        setApiKey('');
        setKeyChanged(false);
      }
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  };

  const canSave = llm && (isOllama || maskedKey || apiKey);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Configuration</h2>
        {saved && <span className="status-badge success">Saved</span>}
      </div>

      <div className="field">
        <label>LLM Provider</label>
        <select value={llm} onChange={e => { setLlm(e.target.value); setGroqModels([]); }}>
          <option value="">Select a provider...</option>
          {providers.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}{p.local ? ' ✦ FREE' : ''}
            </option>
          ))}
        </select>
        {selectedProvider?.desc && <span className="hint">{selectedProvider.desc}</span>}
      </div>

      {isOllama && (
        <div className="ollama-info">
          <span className="free-badge">FREE - Local</span>
          <span>Runs on your machine via Ollama. No API key needed.</span>
        </div>
      )}

      {isGroq && (
        <div className="groq-info">
          <span className="groq-badge">GROQ</span>
          <span>Ultra-fast inference. Get free key at <strong>console.groq.com</strong></span>
        </div>
      )}

      {!isOllama && (
        <div className="field">
          <label>API Key {maskedKey && !keyChanged && <span className="status-badge success" style={{ fontSize: 10, marginLeft: 8 }}>Saved</span>}</label>
          {maskedKey && !keyChanged ? (
            <div className="input-group">
              <input type="text" value={maskedKey} readOnly style={{ opacity: 0.7 }} />
              <button className="btn-icon" onClick={() => setKeyChanged(true)} type="button">Change</button>
            </div>
          ) : (
            <div className="input-group">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                onBlur={() => { if (isGroq) fetchGroqModels(apiKey); }}
                placeholder={isGroq ? 'gsk_...' : 'Enter your API key'}
              />
              <button className="btn-icon" onClick={() => setShowKey(!showKey)} type="button">
                {showKey ? 'Hide' : 'Show'}
              </button>
              {maskedKey && (
                <button className="btn-icon" onClick={() => { setKeyChanged(false); setApiKey(''); }} type="button">Cancel</button>
              )}
            </div>
          )}
        </div>
      )}

      {isGroq && apiKey && (
        <div className="field">
          <label>
            Groq Model
            {loadingGroq && <span className="hint" style={{ display: 'inline', marginLeft: 8 }}>Loading models...</span>}
            {!loadingGroq && !groqModels.length && apiKey.length > 10 && (
              <button className="btn-link" style={{ display: 'inline', marginLeft: 8, fontSize: 11 }} onClick={() => fetchGroqModels(apiKey)}>
                Fetch models
              </button>
            )}
          </label>
          {groqModels.length > 0 && (
            <select value={llm} onChange={e => setLlm(e.target.value)}>
              {providers.filter(p => p.provider === 'Groq').map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              <optgroup label="All Groq Models">
                {groqModels.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.context ? `${Math.round(m.context/1024)}K ctx` : ''})
                  </option>
                ))}
              </optgroup>
            </select>
          )}
        </div>
      )}

      {!isOllama && !isGroq && (
        <div className="field">
          <label>API Base URL (optional)</label>
          <input
            value={apiBase}
            onChange={e => setApiBase(e.target.value)}
            placeholder="e.g. https://api.kimi.ai/coding/v1"
          />
          <span className="hint">Custom endpoint for Kimi, Ollama, LMStudio, etc.</span>
        </div>
      )}

      <button
        className="btn-primary"
        onClick={handleSave}
        disabled={!canSave || saving}
      >
        {saving ? 'Saving...' : 'Save Configuration'}
      </button>
    </div>
  );
}
