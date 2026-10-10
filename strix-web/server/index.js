import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { readFile, writeFile, mkdir, readdir, stat, rm, rename } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import multer from 'multer';
import { MobSFClient, normalizeMobSFFindings, extractApiEndpoints, getMobSFAppInfo } from './mobsf.js';
import { runAllSkills, enrichFindings, getAvailableSkills, runSkill } from './mobile-agent.js';
import { connectDB, saveScan, saveMobileScan, deleteScan, deleteMobileScan, loadAllScans, loadAllMobileScans } from './db.js';
import { initUsers, authMiddleware, adminOnly, authRoutes } from './auth.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(authMiddleware);
authRoutes(app);

const UPLOADS_DIR = resolve('./uploads');
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

const HOME = homedir();
const CONFIG_DIR = join(HOME, '.strix');
const CONFIG_FILE = join(CONFIG_DIR, 'cli-config.json');
const STRIX_BIN = join(CONFIG_DIR, 'bin', 'strix');
const RUNS_DIR = resolve('./strix_runs');

async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    if (raw.env) {
      return {
        llm: raw.llm || raw.env.STRIX_LLM || '',
        api_key: raw.api_key || raw.env.LLM_API_KEY || '',
        api_base: raw.api_base || raw.env.LLM_API_BASE || raw.env.OPENAI_API_BASE || '',
        env: raw.env,
      };
    }
    return raw;
  } catch { return {}; }
}

async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  const out = {
    llm: config.llm || '',
    api_key: config.api_key || '',
    api_base: config.api_base || '',
    env: {
      STRIX_LLM: config.llm || '',
      LLM_API_KEY: config.api_key || '',
      ...(config.api_base ? { LLM_API_BASE: config.api_base, OPENAI_API_BASE: config.api_base } : {}),
    },
  };
  await writeFile(CONFIG_FILE, JSON.stringify(out, null, 2));
}

const LLM_PROVIDERS = [
  { id: 'gemini/gemini-3.7-flash', name: 'Gemini 3.7 Flash (Google)', provider: 'Google', desc: 'FREE tier 15 RPM! ~$0.01/$0.04 per 1M tokens' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'DeepSeek', desc: '$0.07/$0.28 per 1M tokens, fast' },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'DeepSeek', desc: '$0.14/$0.28 per 1M tokens, high quality' },
  { id: 'dashscope/qwen3.8-max', name: 'Qwen 3.8 Max (DashScope)', provider: 'Alibaba', desc: '~$0.20/$0.80 per 1M tokens, frontier model' },
  { id: 'ollama/qwen2.5:7b', name: 'Qwen 2.5 7B (Ollama Local)', provider: 'Ollama', local: true, desc: 'Free, runs on your machine' },
  { id: 'ollama/qwen2.5:14b', name: 'Qwen 2.5 14B (Ollama Local)', provider: 'Ollama', local: true, desc: 'Free, needs 12GB+ RAM' },
  { id: 'groq/openai/gpt-oss-120b', name: 'GPT-OSS 120B (Groq)', provider: 'Groq', desc: '120B, $0.15/$0.60 per 1M tokens, ~500 t/s' },
  { id: 'groq/openai/gpt-oss-20b', name: 'GPT-OSS 20B (Groq)', provider: 'Groq', desc: '20B, $0.075/$0.30 per 1M tokens, ~1000 t/s' },
  { id: 'groq/qwen/qwen3.8-27b', name: 'Qwen 3.8 27B (Groq)', provider: 'Groq', desc: '27B, $0.80/$4.00 per 1M tokens, ~450 t/s' },
  { id: 'groq/llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq)', provider: 'Groq', desc: '70B, enterprise tier' },
  { id: 'moonshot/kimi-k3', name: 'Moonshot Kimi K3', provider: 'Moonshot' },
  { id: 'openai/gpt-5.4', name: 'OpenAI GPT-5.4', provider: 'OpenAI' },
  { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'Anthropic' },
  { id: 'vertex_ai/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', provider: 'Google' },
  { id: 'openrouter/z-ai/glm-5.3', name: 'Z.ai GLM-5.3 (OpenRouter)', provider: 'OpenRouter' },
];

const SCAN_MODES = [
  { id: 'quick', name: 'Quick', desc: 'Fast CI/CD checks, surface-level scan' },
  { id: 'standard', name: 'Standard', desc: 'Routine testing, balanced depth' },
  { id: 'deep', name: 'Deep', desc: 'Thorough security review, comprehensive' },
];

const SCOPE_MODES = [
  { id: 'auto', name: 'Auto', desc: 'PR diff-scope in CI/headless, full otherwise' },
  { id: 'diff', name: 'Diff', desc: 'Only scan changed files' },
  { id: 'full', name: 'Full', desc: 'Scan everything, ignore diffs' },
];

const TESTING_TYPES = [
  { id: 'blackbox', name: 'Black Box', desc: 'No credentials, no source code access', instruction: 'Perform black-box testing. Do not use any credentials or internal knowledge.' },
  { id: 'greybox', name: 'Grey Box', desc: 'Limited credentials provided, no source code', instruction: 'Perform grey-box testing with the provided credentials.' },
  { id: 'whitebox', name: 'White Box', desc: 'Full source code and credentials access', instruction: 'Perform white-box testing with full source code access.' },
];

// --- Groq live models ---
app.get('/api/groq-models', async (req, res) => {
  const config = await loadConfig();
  const apiKey = req.query.key || process.env.GROQ_API_KEY || process.env.LLM_API_KEY || config.api_key;
  if (!apiKey) return res.json([]);
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!resp.ok) return res.json([]);
    const data = await resp.json();
    const models = (data.data || [])
      .filter(m => m.id && !m.id.includes('whisper') && !m.id.includes('orpheus') && !m.id.includes('guard') && !m.id.includes('safeguard'))
      .map(m => ({ id: `groq/${m.id}`, name: m.id, context: m.context_window }))
      .sort((a, b) => (b.context || 0) - (a.context || 0));
    res.json(models);
  } catch { res.json([]); }
});

// --- Config endpoints ---
app.get('/api/providers', (_req, res) => res.json(LLM_PROVIDERS));
app.get('/api/scan-options', (_req, res) => res.json({ scanModes: SCAN_MODES, scopeModes: SCOPE_MODES, testingTypes: TESTING_TYPES }));

app.get('/api/config', async (_req, res) => {
  const config = await loadConfig();
  const key = process.env.LLM_API_KEY || config.api_key || '';
  const masked = key.length > 8 ? key.slice(0, 4) + '•'.repeat(key.length - 8) + key.slice(-4) : key ? '••••' : '';
  res.json({
    llm: process.env.STRIX_LLM || config.llm || '',
    apiBase: process.env.LLM_API_BASE || config.api_base || '',
    hasKey: !!key,
    maskedKey: masked,
  });
});

app.post('/api/config', adminOnly, async (req, res) => {
  const { llm, apiKey, apiBase } = req.body;
  const config = await loadConfig();
  if (llm) config.llm = llm;
  if (apiKey) config.api_key = apiKey;
  if (apiBase !== undefined) config.api_base = apiBase;
  await saveConfig(config);
  process.env.STRIX_LLM = llm || process.env.STRIX_LLM;
  if (apiKey) process.env.LLM_API_KEY = apiKey;
  if (apiBase) {
    process.env.LLM_API_BASE = apiBase;
    process.env.OPENAI_API_BASE = apiBase;
  } else {
    delete process.env.LLM_API_BASE;
    delete process.env.OPENAI_API_BASE;
  }
  res.json({ success: true });
});

function buildScanEnv(llm, apiKey, apiBase) {
  const env = { ...process.env };
  const prefix = llm?.split('/')[0];

  if (prefix === 'ollama') {
    env.STRIX_LLM = llm;
    env.LLM_API_KEY = 'ollama';
  } else if (prefix === 'groq') {
    env.STRIX_LLM = llm;
    env.GROQ_API_KEY = apiKey;
    env.LLM_API_KEY = apiKey;
  } else if (prefix === 'gemini') {
    env.STRIX_LLM = llm;
    env.GEMINI_API_KEY = apiKey;
    env.LLM_API_KEY = apiKey;
  } else if (prefix === 'dashscope') {
    env.STRIX_LLM = llm;
    env.DASHSCOPE_API_KEY = apiKey;
    env.LLM_API_KEY = apiKey;
  } else if (apiBase) {
    const modelName = llm.includes('/') ? llm.split('/').slice(1).join('/') : llm;
    env.STRIX_LLM = `openai/${modelName}`;
    env.LLM_API_KEY = apiKey;
    env.OPENAI_API_BASE = apiBase;
  } else {
    env.STRIX_LLM = llm;
    env.LLM_API_KEY = apiKey;
  }
  return env;
}

// --- Scan management ---
const activeScans = new Map();

app.post('/api/upload-spec', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = (req.file.originalname.match(/\.[^.]+$/) || ['.json'])[0];
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dest = join(UPLOADS_DIR, `${req.file.filename}${ext}`);
  await rename(join(UPLOADS_DIR, req.file.filename), dest);
  res.json({ path: dest, name: safeName, size: req.file.size });
});

app.get('/api/uploads', async (_req, res) => {
  try {
    await mkdir(UPLOADS_DIR, { recursive: true });
    const files = await readdir(UPLOADS_DIR);
    const specs = [];
    for (const f of files) {
      if (/\.(json|yaml|yml)$/i.test(f)) {
        const s = await stat(join(UPLOADS_DIR, f));
        specs.push({ name: f, path: join(UPLOADS_DIR, f), size: s.size, uploadedAt: s.birthtime });
      }
    }
    specs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.json(specs);
  } catch { res.json([]); }
});

app.delete('/api/uploads/:name', async (req, res) => {
  const filePath = join(UPLOADS_DIR, req.params.name);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  await rm(filePath);
  res.json({ success: true });
});

app.post('/api/scan', async (req, res) => {
  const { targets, scanMode, scopeMode, testingType, instruction, credentials, maxBudget, maxTurns, diffBase, workspaceFiles } = req.body;
  const targetList = Array.isArray(targets) ? targets : [targets];
  if (!targetList.length || !targetList[0]) return res.status(400).json({ error: 'At least one target is required' });

  const config = await loadConfig();
  const llm = process.env.STRIX_LLM || config.llm;
  const apiKey = process.env.LLM_API_KEY || config.api_key;
  const apiBase = process.env.LLM_API_BASE || config.api_base;
  const isOllama = llm?.startsWith('ollama/');
  if (!llm || (!apiKey && !isOllama)) return res.status(400).json({ error: 'LLM provider and API key must be configured first' });

  const scanId = `scan-${Date.now()}`;
  const args = ['-n'];

  for (const t of targetList) args.push('--target', t);
  if (scanMode) args.push('--scan-mode', scanMode);
  if (scopeMode && scopeMode !== 'auto') args.push('--scope-mode', scopeMode);
  if (diffBase) args.push('--diff-base', diffBase);
  if (maxBudget) args.push('--max-budget', String(maxBudget));
  if (maxTurns) args.push('--max-turns', String(maxTurns));

  const allInstructions = [];
  const testType = TESTING_TYPES.find(t => t.id === testingType);
  if (testType) allInstructions.push(testType.instruction);
  if (credentials) {
    const credLines = credentials.split('\n').filter(l => l.trim());
    if (credLines.length > 1) {
      allInstructions.push(`Multiple role-based credentials are provided for privilege escalation testing. Test each role and check for vertical/horizontal privilege escalation, IDOR, and unauthorized access between roles:\n${credentials}`);
    } else {
      allInstructions.push(`Use the following credentials: ${credentials}`);
    }
  }
  if (instruction) allInstructions.push(instruction);
  if (allInstructions.length) args.push('--instruction', allInstructions.join(' '));

  if (workspaceFiles?.length) {
    for (const wf of workspaceFiles) {
      if (wf.path && existsSync(wf.path)) {
        args.push('--workspace-file', wf.path);
      }
    }
  }

  const scanEnv = buildScanEnv(llm, apiKey, apiBase);
  const child = spawn(STRIX_BIN, args, { env: scanEnv, cwd: resolve('.') });

  const scanData = {
    id: scanId, status: 'running', output: '', findings: [],
    targets: targetList, scanMode: scanMode || 'deep', testingType: testingType || 'blackbox',
    startedAt: new Date().toISOString(), pid: child.pid, runName: null,
  };
  activeScans.set(scanId, scanData);
  saveScan(scanData).catch(() => {});

  child.stdout.on('data', (data) => {
    scanData.output += data.toString();
    tryParseRunName(scanData);
  });
  child.stderr.on('data', (data) => { scanData.output += data.toString(); });
  child.on('close', async (code) => {
    scanData.status = code === 0 ? 'completed' : 'failed';
    scanData.exitCode = code;
    scanData.finishedAt = new Date().toISOString();
    if (scanData.runName) {
      scanData.findings = await loadFindings(scanData.runName);
    }
    saveScan(scanData).catch(() => {});
  });
  child.on('error', (err) => {
    scanData.status = 'error';
    scanData.output += `\nError: ${err.message}`;
    saveScan(scanData).catch(() => {});
  });

  res.json({ scanId, status: 'running' });
});

function tryParseRunName(scanData) {
  if (scanData.runName) return;
  const match = scanData.output.match(/strix_runs\/([^\s/]+)/);
  if (match) scanData.runName = match[1];
}

app.get('/api/scan/:id', (req, res) => {
  const scan = activeScans.get(req.params.id) || mobileScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const data = { ...scan };
  if (data.mergedFindings?.length) data.findings = data.mergedFindings;
  res.json(data);
});

app.get('/api/scans', (_req, res) => {
  const scans = Array.from(activeScans.values()).map(({ output, ...rest }) => rest);
  res.json(scans);
});

app.delete('/api/scan/:id', (req, res) => {
  const scan = activeScans.get(req.params.id);
  if (scan) {
    if (scan.status === 'running' && scan.pid) {
      try { process.kill(scan.pid, 'SIGTERM'); } catch {}
    }
    activeScans.delete(req.params.id);
    deleteScan(req.params.id).catch(() => {});
    return res.json({ success: true });
  }
  if (mobileScans.has(req.params.id)) {
    mobileScans.delete(req.params.id);
    deleteMobileScan(req.params.id).catch(() => {});
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Scan not found' });
});

app.post('/api/scan/:id/stop', (req, res) => {
  const scan = activeScans.get(req.params.id) || mobileScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.pid) {
    try { process.kill(scan.pid, 'SIGTERM'); } catch {}
  }
  scan.status = 'stopped';
  scan.finishedAt = new Date().toISOString();
  const running = scan.phases?.find(p => p.status === 'running');
  if (running) running.status = 'stopped';
  if (activeScans.has(req.params.id)) saveScan(scan).catch(() => {});
  else saveMobileScan(scan).catch(() => {});
  res.json({ success: true });
});

app.post('/api/scan/:id/retry', async (req, res) => {
  const oldScan = activeScans.get(req.params.id);
  if (!oldScan) return res.status(404).json({ error: 'Original scan not found' });

  const config = await loadConfig();
  const llm = process.env.STRIX_LLM || config.llm;
  const apiKey = process.env.LLM_API_KEY || config.api_key;
  const apiBase = process.env.LLM_API_BASE || config.api_base;
  const isOllama = llm?.startsWith('ollama/');
  if (!llm || (!apiKey && !isOllama)) return res.status(400).json({ error: 'LLM provider and API key must be configured first' });

  const scanId = `scan-${Date.now()}`;
  const args = ['-n'];
  for (const t of oldScan.targets || []) args.push('--target', t);
  if (oldScan.scanMode) args.push('--scan-mode', oldScan.scanMode);

  const retryEnv = buildScanEnv(llm, apiKey, apiBase);
  const child = spawn(STRIX_BIN, args, { env: retryEnv, cwd: resolve('.') });

  const scanData = {
    id: scanId, status: 'running', output: '', findings: [],
    targets: oldScan.targets, scanMode: oldScan.scanMode, testingType: oldScan.testingType,
    startedAt: new Date().toISOString(), pid: child.pid, runName: null,
    retriedFrom: oldScan.id,
  };
  activeScans.set(scanId, scanData);
  saveScan(scanData).catch(() => {});

  child.stdout.on('data', (data) => { scanData.output += data.toString(); tryParseRunName(scanData); });
  child.stderr.on('data', (data) => { scanData.output += data.toString(); });
  child.on('close', async (code) => {
    scanData.status = code === 0 ? 'completed' : 'failed';
    scanData.exitCode = code;
    scanData.finishedAt = new Date().toISOString();
    if (scanData.runName) scanData.findings = await loadFindings(scanData.runName);
    saveScan(scanData).catch(() => {});
  });
  child.on('error', (err) => {
    scanData.status = 'error';
    scanData.output += `\nError: ${err.message}`;
    saveScan(scanData).catch(() => {});
  });

  res.json({ scanId, status: 'running' });
});

// --- Findings from strix_runs ---
async function loadFindings(runName) {
  const runDir = join(RUNS_DIR, runName);
  const findings = [];
  try {
    const files = await readdir(runDir, { recursive: true });
    for (const f of files) {
      if (f.endsWith('.json') && (f.includes('finding') || f.includes('vuln'))) {
        try {
          const data = JSON.parse(await readFile(join(runDir, f), 'utf-8'));
          if (Array.isArray(data)) findings.push(...data);
          else findings.push(data);
        } catch {}
      }
    }
  } catch {}
  return findings.map(normalizeFinding);
}

function normalizeFinding(raw) {
  const evidenceStr = typeof raw.evidence === 'string' ? raw.evidence : null;
  const evidenceObj = typeof raw.evidence === 'object' && raw.evidence ? raw.evidence : {};
  const pocDesc = raw.poc_description || '';
  const pocSteps = pocDesc ? pocDesc.split(/\n/).filter(l => /^\d+\.\s/.test(l.trim())).map(l => l.trim().replace(/^\d+\.\s*/, '')) : [];

  return {
    id: raw.id || raw.finding_id || `F-${Math.random().toString(36).slice(2, 6)}`,
    title: raw.title || raw.name || 'Untitled Finding',
    severity: raw.severity || raw.risk || 'Medium',
    cvss: raw.cvss_score || raw.cvss || null,
    cvssVector: raw.cvss_vector || raw.cvss_breakdown || null,
    cwe: raw.cwe || raw.cwe_id || null,
    owaspCategory: raw.owasp || raw.owasp_category || raw.finding_class || null,
    confidence: raw.confidence || null,
    description: raw.description || '',
    technicalAnalysis: raw.technical_analysis || '',
    evidence: {
      raw: evidenceStr || (Object.keys(evidenceObj).length ? null : null),
      request: raw.request || evidenceObj.request || raw.poc?.request || null,
      response: raw.response || evidenceObj.response || raw.poc?.response || null,
      steps: pocSteps.length ? pocSteps : (raw.steps || evidenceObj.steps || raw.reproduction_steps || []),
      detail: evidenceStr || '',
    },
    pocDescription: pocDesc,
    pocScriptCode: raw.poc_script_code || '',
    impact: raw.impact || '',
    remediation: raw.remediation || raw.fix || raw.recommendation || '',
    remediationSteps: raw.remediation_steps || '',
    affectedAsset: raw.affected_asset || raw.endpoint || raw.url || raw.target || '',
    status: raw.status || 'Open',
    tags: raw.tags || [],
    method: raw.method || '',
    fixEffort: raw.fix_effort || '',
  };
}

app.get('/api/runs', async (_req, res) => {
  try {
    const dirs = await readdir(RUNS_DIR);
    const runs = [];
    for (const d of dirs) {
      const s = await stat(join(RUNS_DIR, d));
      if (s.isDirectory()) runs.push({ name: d, createdAt: s.birthtime });
    }
    runs.sort((a, b) => b.createdAt - a.createdAt);
    res.json(runs);
  } catch {
    res.json([]);
  }
});

app.get('/api/runs/:name/findings', async (req, res) => {
  const findings = await loadFindings(req.params.name);
  res.json(findings);
});

app.get('/api/all-scans', async (_req, res) => {
  const sessionScans = Array.from(activeScans.values()).map(({ pid, ...rest }) => ({
    ...rest,
    source: 'session',
    findingsCount: rest.findings?.length || 0,
  }));

  let pastRuns = [];
  try {
    const dirs = await readdir(RUNS_DIR);
    for (const d of dirs) {
      const s = await stat(join(RUNS_DIR, d));
      if (!s.isDirectory()) continue;
      const linkedSession = sessionScans.find(sc => sc.runName === d);
      if (linkedSession) continue;
      const findings = await loadFindings(d);
      pastRuns.push({
        id: `run-${d}`,
        runName: d,
        source: 'disk',
        status: 'completed',
        targets: [d],
        scanMode: 'unknown',
        testingType: 'unknown',
        startedAt: s.birthtime.toISOString(),
        finishedAt: s.mtime.toISOString(),
        findings,
        findingsCount: findings.length,
      });
    }
  } catch {}

  const mobileScanList = Array.from(mobileScans.values()).map(s => ({
    id: s.id,
    source: s.scanType === 'dynamic' ? 'mobile-dynamic' : 'mobile',
    scanType: s.scanType,
    status: s.status,
    fileName: s.fileName,
    targets: [s.fileName],
    runName: s.fileName,
    scanMode: s.scanType === 'dynamic' ? 'dynamic' : 'mobile',
    testingType: s.testingType || 'blackbox',
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    findingsCount: s.mergedFindings?.length || 0,
    findings: s.mergedFindings || [],
    phases: s.phases,
    appInfo: s.appInfo,
    apiEndpoints: s.apiEndpoints,
    capturedTraffic: undefined,
    configChecks: s.configChecks,
    progress: s.progress,
    strixScanId: s.strixScanId,
  }));

  const all = [...sessionScans, ...mobileScanList, ...pastRuns].sort((a, b) =>
    new Date(b.startedAt) - new Date(a.startedAt));
  res.json(all);
});

// --- Scan CRUD ---
app.patch('/api/scan/:id', (req, res) => {
  const scan = activeScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (req.body.runName !== undefined) scan.runName = req.body.runName;
  if (req.body.notes !== undefined) scan.notes = req.body.notes;
  res.json({ success: true });
});

app.delete('/api/runs/:name', async (req, res) => {
  const runDir = join(RUNS_DIR, req.params.name);
  if (!existsSync(runDir)) return res.status(404).json({ error: 'Run not found' });
  await rm(runDir, { recursive: true, force: true });
  res.json({ success: true });
});

app.patch('/api/runs/:name', async (req, res) => {
  const oldDir = join(RUNS_DIR, req.params.name);
  if (!existsSync(oldDir)) return res.status(404).json({ error: 'Run not found' });
  if (req.body.newName) {
    const newDir = join(RUNS_DIR, req.body.newName);
    await rename(oldDir, newDir);
  }
  res.json({ success: true });
});

// --- Finding CRUD ---
function findScanById(id) {
  const web = activeScans.get(id);
  if (web) return web;
  const mob = mobileScans.get(id);
  if (mob) return mob;
  return null;
}

function getScanFindings(scan) {
  return scan.findings?.length ? scan.findings : scan.mergedFindings || [];
}

app.patch('/api/scan/:id/finding/:fid', (req, res) => {
  const scan = findScanById(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const findings = getScanFindings(scan);
  const finding = findings.find(f => f.id === req.params.fid);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });
  if (req.body.severity !== undefined) finding.severity = req.body.severity;
  if (req.body.status !== undefined) finding.status = req.body.status;
  if (req.body.notes !== undefined) finding.notes = req.body.notes;
  if (req.body.title !== undefined) finding.title = req.body.title;
  res.json({ success: true, finding });
});

app.delete('/api/scan/:id/finding/:fid', (req, res) => {
  const scan = findScanById(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const findings = getScanFindings(scan);
  const idx = findings.findIndex(f => f.id === req.params.fid);
  if (idx === -1 || idx === undefined) return res.status(404).json({ error: 'Finding not found' });
  findings.splice(idx, 1);
  res.json({ success: true });
});

app.patch('/api/runs/:name/finding/:fid', async (req, res) => {
  const vulnFile = join(RUNS_DIR, req.params.name, 'vulnerabilities.json');
  if (!existsSync(vulnFile)) return res.status(404).json({ error: 'Findings file not found' });
  const raw = JSON.parse(await readFile(vulnFile, 'utf-8'));
  const findings = Array.isArray(raw) ? raw : [];
  const finding = findings.find(f => f.id === req.params.fid);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });
  if (req.body.severity !== undefined) finding.severity = req.body.severity;
  if (req.body.status !== undefined) finding.status = req.body.status;
  if (req.body.notes !== undefined) finding.notes = req.body.notes;
  if (req.body.title !== undefined) finding.title = req.body.title;
  await writeFile(vulnFile, JSON.stringify(findings, null, 2));
  res.json({ success: true, finding: normalizeFinding(finding) });
});

app.delete('/api/runs/:name/finding/:fid', async (req, res) => {
  const vulnFile = join(RUNS_DIR, req.params.name, 'vulnerabilities.json');
  if (!existsSync(vulnFile)) return res.status(404).json({ error: 'Findings file not found' });
  const raw = JSON.parse(await readFile(vulnFile, 'utf-8'));
  const findings = Array.isArray(raw) ? raw : [];
  const idx = findings.findIndex(f => f.id === req.params.fid);
  if (idx === -1) return res.status(404).json({ error: 'Finding not found' });
  findings.splice(idx, 1);
  await writeFile(vulnFile, JSON.stringify(findings, null, 2));
  res.json({ success: true });
});

// --- Report generation ---
app.post('/api/report', async (req, res) => {
  const { findings, meta, scanId } = req.body;
  if (!findings || !findings.length) return res.status(400).json({ error: 'No findings to generate report from' });
  try {
    const report = await generateReport(findings, meta || {});
    const reportDoc = {
      id: `report-${Date.now()}`,
      scanId: scanId || null,
      report,
      meta,
      findingsCount: findings.length,
      createdAt: new Date().toISOString(),
      createdBy: req.user?.username || 'unknown',
    };
    const db = (await import('./db.js')).getDB();
    if (db) {
      await db.collection('reports').createIndex({ id: 1 }, { unique: true }).catch(() => {});
      await db.collection('reports').updateOne({ id: reportDoc.id }, { $set: reportDoc }, { upsert: true });
    }
    res.json({ ...report, reportId: reportDoc.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports', async (_req, res) => {
  const db = (await import('./db.js')).getDB();
  if (!db) return res.json([]);
  const reports = await db.collection('reports').find({}, { projection: { report: 0 } })
    .sort({ createdAt: -1 }).limit(50).toArray();
  res.json(reports);
});

app.get('/api/report/:id', async (req, res) => {
  const db = (await import('./db.js')).getDB();
  if (!db) return res.status(503).json({ error: 'Database not available' });
  const doc = await db.collection('reports').findOne({ id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Report not found' });
  res.json(doc);
});

app.delete('/api/report/:id', async (req, res) => {
  const db = (await import('./db.js')).getDB();
  if (!db) return res.status(503).json({ error: 'Database not available' });
  await db.collection('reports').deleteOne({ id: req.params.id });
  res.json({ success: true });
});

async function generateReport(findings, meta) {
  const now = new Date();
  const severityOrder = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
  const sorted = [...findings].sort((a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5));

  const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
  const categoryCounts = {};
  for (const f of sorted) {
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
    const cat = f.owaspCategory || 'Uncategorized';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  }

  const findingsSummaryForLLM = sorted.map((f, i) => `${i+1}. [${f.severity}] ${f.title}${f.cvss ? ` (CVSS ${f.cvss})` : ''}${f.cwe ? ` CWE-${f.cwe}` : ''}${f.owaspCategory ? ` — ${f.owaspCategory}` : ''}: ${(f.description || '').slice(0, 200)}`).join('\n');

  const execSummary = await callLLM([{
    role: 'system',
    content: `You are a senior penetration tester writing a professional pentest report executive summary for a client. Write in formal, third-person technical language. Structure: (1) engagement context — who, what, when, methodology; (2) key statistics — total findings by severity; (3) highlight the most critical findings and their business impact; (4) overall security posture assessment; (5) prioritized remediation guidance. Be specific about vulnerabilities found, not generic. Write 2-3 concise paragraphs. No markdown formatting, just plain text paragraphs.`,
  }, {
    role: 'user',
    content: `Client: ${meta.clientName || 'Target Organization'}
Target: ${meta.targetName || 'the target application'}
Testing type: ${meta.testingType || 'Black Box'}
Methodology: ${meta.mobile ? 'OWASP MASTG / MASVS v2' : 'OWASP Testing Guide v4.2 / PTES'}
Total findings: ${sorted.length} (${Object.entries(severityCounts).filter(([,v])=>v>0).map(([k,v])=>`${v} ${k}`).join(', ')})

Findings:
${findingsSummaryForLLM}

Write the executive summary.`,
  }], 1500);

  const enhancedFindings = await Promise.all(sorted.map(async (f) => {
    if (f.description && f.description.length > 60 && f.impact && f.remediation) return f;
    const aiText = await callLLM([{
      role: 'system',
      content: `You are a senior penetration tester writing a finding for a professional pentest report. Respond in JSON format: {"description": "...", "technicalAnalysis": "...", "impact": "...", "remediation": "..."}. Each field: 2-4 sentences, formal technical language. description = what the vulnerability is; technicalAnalysis = how it was discovered and exploited; impact = business and security consequences; remediation = specific actionable fix steps. Use existing data when available, enhance where lacking.`,
    }, {
      role: 'user',
      content: `Finding: ${f.title}
Severity: ${f.severity}${f.cvss ? `, CVSS ${f.cvss}` : ''}${f.cwe ? `, CWE-${f.cwe}` : ''}
Asset: ${f.affectedAsset || 'N/A'}
Existing description: ${f.description || 'None'}
Existing impact: ${f.impact || 'None'}
Existing remediation: ${f.remediationSteps || f.remediation || 'None'}
Evidence: ${f.evidence?.detail?.slice(0, 500) || 'N/A'}
PoC steps: ${f.evidence?.steps?.join('; ')?.slice(0, 300) || 'N/A'}`,
    }], 800).catch(() => '');
    try {
      const parsed = JSON.parse(aiText.replace(/```json?\n?/g, '').replace(/```$/g, '').trim());
      return {
        ...f,
        description: parsed.description || f.description,
        technicalAnalysis: parsed.technicalAnalysis || f.technicalAnalysis,
        impact: parsed.impact || f.impact,
        remediationSteps: parsed.remediation || f.remediationSteps || f.remediation,
      };
    } catch { return f; }
  }));

  const remediationRoadmap = enhancedFindings.map((f, i) => ({
    priority: i + 1,
    finding: f.title,
    severity: f.severity,
    deadline: f.severity === 'Critical' ? '7 days' : f.severity === 'High' ? '14 days' : f.severity === 'Medium' ? '60 days' : '90 days',
  }));

  return {
    coverPage: {
      title: 'Penetration Testing Report',
      client: meta.clientName || 'Target Organization',
      engagementType: `${meta.testingType || 'Black Box'} Penetration Test`,
      testingDates: `${meta.startDate || now.toLocaleDateString()} - ${meta.endDate || now.toLocaleDateString()}`,
      reportDate: now.toLocaleDateString(),
      classification: 'Confidential',
      version: '1.0',
    },
    executiveSummary: execSummary,
    scope: {
      targets: meta.targets || [],
      testingApproach: meta.testingType || 'Black Box',
      methodology: meta.mobile ? 'OWASP MASTG / MASVS v2' : 'OWASP Testing Guide v4.2 / PTES',
      scanMode: meta.scanMode || 'deep',
      tools: meta.mobile
        ? ['Burp Suite', 'Frida', 'MobSF', 'mitmproxy', 'UIAutomator', 'Android Emulator']
        : ['Burp Suite', 'Caido', 'Nuclei', 'Playwright'],
    },
    riskSummary: { severityCounts, categoryCounts, total: findings.length },
    findings: enhancedFindings,
    remediationRoadmap,
    generatedAt: now.toISOString(),
  };
}

// --- Template-based Report ---

const TEMPLATE_DIR = resolve('./report-templates');

const templateUpload = multer({
  dest: TEMPLATE_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.docx')) cb(null, true);
    else cb(new Error('Only .docx files'));
  },
});

// Upload template → parse structure
app.post('/api/report/template/upload', templateUpload.single('template'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No .docx file uploaded' });
  try {
    const mammoth = await import('mammoth');
    const raw = await readFile(req.file.path);
    const { value: html } = await mammoth.default.convertToHtml({ buffer: raw });

    // Extract sections from HTML headings
    const sections = [];
    const headingRegex = /<h(\d)[^>]*>(.*?)<\/h\1>/gi;
    let m;
    let lastIdx = 0;
    while ((m = headingRegex.exec(html)) !== null) {
      if (sections.length > 0) {
        sections[sections.length - 1].content = html.slice(lastIdx, m.index).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      sections.push({ level: parseInt(m[1]), title: m[2].replace(/<[^>]+>/g, '').trim(), content: '' });
      lastIdx = m.index + m[0].length;
    }
    if (sections.length > 0) {
      sections[sections.length - 1].content = html.slice(lastIdx).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // If no headings found, treat as single block
    if (!sections.length) {
      sections.push({ level: 1, title: 'Document', content: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
    }

    const templateId = req.file.filename;
    res.json({
      templateId,
      fileName: req.file.originalname,
      sections: sections.map((s, i) => ({ id: i, ...s })),
      preview: html,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate .docx from template + findings
app.post('/api/report/template/generate', async (req, res) => {
  const { templateId, sections, findings, meta } = req.body;
  if (!sections || !findings) return res.status(400).json({ error: 'Missing sections or findings' });

  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
      WidthType, BorderStyle, AlignmentType } = await import('docx');

    const severityOrder = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
    const sorted = [...findings].sort((a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5));
    const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
    for (const f of sorted) severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;

    const findingsSummary = sorted.map((f, i) => `${i+1}. [${f.severity}] ${f.title}${f.cvss ? ` (CVSS ${f.cvss})` : ''}${f.cwe ? ` CWE-${f.cwe}` : ''}: ${(f.description || '').slice(0, 200)}`).join('\n');
    const contextBlock = `Client: ${meta?.clientName || 'Target Organization'}\nTarget: ${meta?.targetName || 'the target application'}\nTesting: ${meta?.testingType || 'Black Box'}\nTotal: ${sorted.length} findings (${Object.entries(severityCounts).filter(([,v])=>v>0).map(([k,v])=>`${v} ${k}`).join(', ')})\n\nFindings:\n${findingsSummary}`;

    const docChildren = [];
    const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
    const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: '999999' };
    const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

    const addParagraphs = (text) => {
      for (const line of text.split('\n').filter(Boolean)) {
        docChildren.push(new Paragraph({ text: line, spacing: { after: 80 } }));
      }
    };

    for (const sec of sections) {
      const hl = headingLevels[Math.min(sec.level - 1, 2)];
      docChildren.push(new Paragraph({ text: sec.title, heading: hl, spacing: { before: 300, after: 120 } }));

      if (sec.fillType === 'executive_summary') {
        const aiText = await callLLM([{
          role: 'system',
          content: 'You are a senior penetration tester writing a professional executive summary for a pentest report. Write 2-3 formal paragraphs covering: engagement context, key statistics, most critical findings with business impact, overall security posture, and prioritized remediation guidance. Plain text only, no markdown.',
        }, { role: 'user', content: contextBlock }], 1500);
        addParagraphs(aiText);

      } else if (sec.fillType === 'findings_list') {
        const aiText = await callLLM([{
          role: 'system',
          content: 'You are a senior penetration tester. Write a concise findings overview list. For each finding, write one line: "Finding N: [Title] — [Severity] — [1-sentence summary of what the vulnerability is and its impact]". Plain text, no markdown. Sort by severity (Critical first).',
        }, { role: 'user', content: contextBlock }], 1500);
        addParagraphs(aiText);

      } else if (sec.fillType === 'findings_detail') {
        for (let i = 0; i < sorted.length; i++) {
          const f = sorted[i];
          docChildren.push(new Paragraph({
            text: `Finding ${i + 1}: ${f.title}`,
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 240, after: 80 },
          }));
          const metaRows = [
            ['Severity', f.severity], ['CVSS', f.cvss || 'N/A'], ['CWE', f.cwe ? `CWE-${f.cwe}` : 'N/A'],
            ['Affected Asset', f.affectedAsset || 'N/A'], ['Status', f.status || 'Open'],
          ];
          if (f.owaspCategory) metaRows.push(['OWASP', f.owaspCategory]);
          docChildren.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: metaRows.map(([k, v]) => new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: k, bold: true, size: 20 })] })], borders, width: { size: 30, type: WidthType.PERCENTAGE } }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(v), size: 20 })] })], borders }),
              ],
            })),
          }));

          const aiDetail = await callLLM([{
            role: 'system',
            content: 'You are a senior penetration tester writing a detailed finding for a professional report. Write sections: Observation (what was found, with evidence), Exploitability (attack scenario, impact), Measure (specific fix steps, references). Plain text, use section headers like "Observation:", "Exploitability:", "Measure:". Enhance existing data, be specific and technical.',
          }, {
            role: 'user',
            content: `Finding: ${f.title}\nSeverity: ${f.severity}${f.cvss ? `, CVSS ${f.cvss}` : ''}${f.cwe ? `, CWE-${f.cwe}` : ''}\nAsset: ${f.affectedAsset || 'N/A'}\nDescription: ${f.description || 'None'}\nImpact: ${f.impact || 'None'}\nRemediation: ${f.remediationSteps || f.remediation || 'None'}\nEvidence: ${f.evidence?.detail?.slice(0, 500) || 'N/A'}\nRequest: ${f.evidence?.request?.slice(0, 500) || 'N/A'}\nPoC steps: ${f.evidence?.steps?.join('; ')?.slice(0, 300) || 'N/A'}`,
          }], 1000).catch(() => '');
          if (aiDetail) addParagraphs(aiDetail);

          if (f.evidence?.request) {
            docChildren.push(new Paragraph({ children: [new TextRun({ text: 'Request:', bold: true, size: 18 })], spacing: { before: 120 } }));
            docChildren.push(new Paragraph({ children: [new TextRun({ text: f.evidence.request, font: 'Courier New', size: 16 })], spacing: { after: 40 } }));
          }
          if (f.evidence?.response) {
            docChildren.push(new Paragraph({ children: [new TextRun({ text: 'Response:', bold: true, size: 18 })], spacing: { before: 80 } }));
            docChildren.push(new Paragraph({ children: [new TextRun({ text: f.evidence.response.slice(0, 2000), font: 'Courier New', size: 16 })], spacing: { after: 40 } }));
          }
        }

      } else if (sec.fillType === 'findings_table') {
        const headerRow = new TableRow({
          children: ['#', 'Finding', 'Severity', 'CVSS', 'Status'].map(h =>
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 20, color: 'FFFFFF' })] })], borders, shading: { fill: '333333' } })
          ),
        });
        const dataRows = sorted.map((f, i) => new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ text: String(i + 1), alignment: AlignmentType.CENTER })], borders }),
            new TableCell({ children: [new Paragraph({ text: f.title })], borders }),
            new TableCell({ children: [new Paragraph({ text: f.severity })], borders }),
            new TableCell({ children: [new Paragraph({ text: f.cvss || 'N/A' })], borders }),
            new TableCell({ children: [new Paragraph({ text: f.status || 'Open' })], borders }),
          ],
        }));
        docChildren.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows] }));

      } else if (sec.fillType === 'remediation') {
        const aiText = await callLLM([{
          role: 'system',
          content: 'You are a senior penetration tester writing a remediation roadmap for a professional report. Create a prioritized action plan grouped by urgency: Immediate (Critical, 7 days), Short-term (High, 14 days), Medium-term (Medium, 60 days), Long-term (Low/Info, 90 days). For each finding, write: the finding name, what to fix, and a concrete remediation step. Plain text, no markdown tables.',
        }, { role: 'user', content: contextBlock }], 1500);
        addParagraphs(aiText);

      } else if (sec.fillType === 'custom' && sec.customContent) {
        addParagraphs(sec.customContent);

      } else if (sec.content) {
        addParagraphs(sec.content);
      }
    }

    const doc = new Document({
      sections: [{ children: docChildren }],
      styles: { default: { document: { run: { size: 22, font: 'Calibri' } } } },
    });

    const buffer = await Packer.toBuffer(doc);
    const outName = `report-${Date.now()}.docx`;
    const outPath = join(TEMPLATE_DIR, outName);
    await writeFile(outPath, buffer);

    res.json({ downloadUrl: `/api/report/template/download/${outName}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/report/template/download/:name', async (req, res) => {
  const filePath = join(TEMPLATE_DIR, req.params.name);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, req.params.name);
});

// --- Mobile Pentest ---

function runCmd(cmd, args, timeout = 15000) {
  return new Promise(resolve => {
    let out = '';
    const proc = spawn(cmd, args, { timeout });
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(out));
  });
}

async function extractApkMetadata(filePath) {
  const result = { manifest: '', strings: '', fileList: '' };
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';

  // File listing — shows libraries, native code, resources structure
  result.fileList = (await runCmd('unzip', ['-l', filePath])).slice(0, 4000);

  if (ext === '.apk') {
    // Try aapt for decoded manifest (best)
    const aaptOut = await runCmd('aapt', ['dump', 'badging', filePath]);
    if (aaptOut.length > 50) {
      result.manifest = aaptOut.slice(0, 10000);
    } else {
      // Fallback: extract string fragments from binary AndroidManifest.xml
      const manifestStrings = await runCmd('sh', ['-c',
        `unzip -p "${filePath}" AndroidManifest.xml 2>/dev/null | strings -n 6 | sort -u`]);
      result.manifest = `[Binary AndroidManifest.xml - extracted string fragments]\n${manifestStrings.slice(0, 5000)}`;
    }

    // All URLs, endpoints, API keys from ALL dex files
    const dexStrings = await runCmd('sh', ['-c', [
      `for dex in $(unzip -l "${filePath}" 2>/dev/null | grep -o 'classes[0-9]*\\.dex' | sort -u); do`,
      `  unzip -p "${filePath}" "$dex" 2>/dev/null | strings -n 8;`,
      `done | grep -iE "(https?://[^ \\\"']+|api[_.-]key|apikey|api_secret|password|secret[_-]?key|token|firebase|aws[_-]|private.key|jdbc:|mongodb://|ftp://|ws://|wss://)" | sort -u | head -300`,
    ].join(' ')], 60000);
    result.strings = dexStrings.slice(0, 6000);

    // Security-relevant code patterns
    const codePatterns = await runCmd('sh', ['-c', [
      `for dex in $(unzip -l "${filePath}" 2>/dev/null | grep -o 'classes[0-9]*\\.dex' | sort -u); do`,
      `  unzip -p "${filePath}" "$dex" 2>/dev/null | strings -n 10;`,
      `done | grep -iE "(SharedPreferences|getSharedPreferences|MODE_WORLD|allowBackup|debuggable|usesCleartextTraffic|setJavaScriptEnabled|addJavascriptInterface|X509TrustManager|ALLOW_ALL_HOSTNAME|checkServerTrusted|HostnameVerifier|CertificatePinner|WebView|loadUrl|evaluateJavascript|MODE_PRIVATE|SQLiteDatabase|openOrCreateDatabase|Log\\.d|Log\\.i|Log\\.e|BiometricPrompt|KeyguardManager|RootBeer|isRooted|detectRoot)" | sort -u | head -150`,
    ].join(' ')], 60000);
    if (codePatterns) result.strings += '\n\n--- Security-relevant code patterns ---\n' + codePatterns.slice(0, 4000);

    // Check for common config files in assets
    const assetFiles = await runCmd('sh', ['-c',
      `unzip -l "${filePath}" 2>/dev/null | grep -iE "assets/.*\\.(json|xml|properties|yml|yaml|conf|cfg|pem|key|cert|p12|jks)" | head -20`]);
    if (assetFiles.trim()) {
      result.strings += '\n\n--- Config/cert files in assets ---\n' + assetFiles;
      // Try to read JSON/properties config files
      const configContent = await runCmd('sh', ['-c',
        `unzip -l "${filePath}" 2>/dev/null | grep -oE 'assets/[^ ]*\\.(json|properties|yml|yaml)' | head -5 | while read f; do echo "=== $f ==="; unzip -p "${filePath}" "$f" 2>/dev/null | head -50; done`]);
      if (configContent.trim()) result.strings += '\n' + configContent.slice(0, 3000);
    }

  } else if (ext === '.ipa') {
    // Info.plist — plutil on macOS can convert binary plist
    const plistOut = await runCmd('sh', ['-c',
      `unzip -p "${filePath}" 'Payload/*.app/Info.plist' 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null || unzip -p "${filePath}" 'Payload/*.app/Info.plist' 2>/dev/null | strings -n 6`]);
    result.manifest = plistOut.slice(0, 10000);

    // Strings from the main binary and frameworks
    const iosStrings = await runCmd('sh', ['-c',
      `unzip -p "${filePath}" 'Payload/*.app/*' 2>/dev/null | strings -n 8 | grep -iE "(https?://|api[_.]|password|secret|token|key|NSAllowsArbitraryLoads|NSAppTransportSecurity|NSExceptionAllowsInsecureHTTPLoads|kSecAttrAccessible|Keychain|UIWebView|WKWebView)" | sort -u | head -300`]);
    result.strings = iosStrings.slice(0, 6000);
  }

  return result;
}

const MOBILE_UPLOADS_DIR = resolve('./mobile-uploads');
const mobileUpload = multer({ dest: MOBILE_UPLOADS_DIR, limits: { fileSize: 500 * 1024 * 1024 } });
const mobileScans = new Map();
let mobsfClient = null;
let mobsfContainerId = null;
const MOBSF_PORT = process.env.MOBSF_PORT || 8000;
const MOBSF_IMAGE = 'opensecurity/mobile-security-framework-mobsf:latest';

async function getMobSFApiKey() {
  if (process.env.MOBSF_API_KEY) return process.env.MOBSF_API_KEY;
  try {
    const ps = spawn('docker', ['ps', '--filter', `publish=${MOBSF_PORT}`, '--format', '{{.ID}}']);
    const cid = await new Promise(r => { let o = ''; ps.stdout.on('data', d => { o += d; }); ps.on('close', () => r(o.trim().split('\n')[0])); ps.on('error', () => r('')); });
    if (!cid) return '';
    const logs = spawn('docker', ['logs', cid]);
    const key = await new Promise(r => {
      let o = '';
      logs.stdout.on('data', d => { o += d; });
      logs.stderr.on('data', d => { o += d; });
      logs.on('close', () => {
        const m = o.match(/REST API Key:\s*(?:\x1b\[[0-9;]*m)*([a-f0-9]{64})/);
        r(m ? m[1] : '');
      });
      logs.on('error', () => r(''));
    });
    if (key) { process.env.MOBSF_API_KEY = key; mobsfContainerId = cid; }
    return key;
  } catch { return ''; }
}

async function getMobSF() {
  if (!mobsfClient) {
    const mobsfUrl = process.env.MOBSF_URL || `http://localhost:${MOBSF_PORT}`;
    const mobsfKey = await getMobSFApiKey();
    mobsfClient = new MobSFClient(mobsfUrl, mobsfKey);
  }
  return mobsfClient;
}

async function checkDockerAvailable() {
  try {
    const p = spawn('docker', ['info'], { timeout: 5000 });
    return new Promise(resolve => {
      p.on('close', code => resolve(code === 0));
      p.on('error', () => resolve(false));
    });
  } catch { return false; }
}

async function startMobSFContainer(onProgress) {
  const client = await getMobSF();
  if (await client.healthCheck()) {
    onProgress?.({ type: 'mobsf', message: 'MobSF already running' });
    return true;
  }

  const dockerOk = await checkDockerAvailable();
  if (!dockerOk) {
    onProgress?.({ type: 'warning', message: 'Docker not available — cannot start MobSF' });
    return false;
  }

  onProgress?.({ type: 'mobsf', message: 'Starting MobSF Docker container...' });

  const run = spawn('docker', [
    'run', '-d', '--rm',
    '-p', `${MOBSF_PORT}:8000`,
    '--name', `mobsf-pentestteam-${Date.now()}`,
    MOBSF_IMAGE,
  ]);

  const containerId = await new Promise((resolve) => {
    let out = '';
    run.stdout.on('data', d => { out += d.toString(); });
    run.stderr.on('data', d => { out += d.toString(); });
    run.on('close', code => {
      if (code === 0) resolve(out.trim().slice(0, 12));
      else resolve(null);
    });
    run.on('error', () => resolve(null));
  });

  if (!containerId) {
    onProgress?.({ type: 'error', message: 'Failed to start MobSF container. Run: docker pull opensecurity/mobile-security-framework-mobsf' });
    return false;
  }

  mobsfContainerId = containerId;
  onProgress?.({ type: 'mobsf', message: `MobSF container started (${containerId}), waiting for ready...` });

  // Wait for MobSF to be ready, then extract the API key from logs
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    // Try to get the API key from container logs
    const key = await getMobSFApiKey();
    if (key) {
      mobsfClient = null;
      const freshClient = await getMobSF();
      if (await freshClient.healthCheck()) {
        onProgress?.({ type: 'mobsf', message: 'MobSF is ready' });
        return true;
      }
    }
    if (i % 5 === 4) onProgress?.({ type: 'mobsf', message: `Still waiting for MobSF... (${(i + 1) * 2}s)` });
  }

  onProgress?.({ type: 'error', message: 'MobSF container started but not responding after 60s' });
  return false;
}

async function stopMobSFContainer() {
  if (!mobsfContainerId) return;
  try {
    const p = spawn('docker', ['stop', mobsfContainerId]);
    await new Promise(resolve => { p.on('close', resolve); p.on('error', resolve); });
  } catch {}
  mobsfContainerId = null;
}

app.get('/api/mobile/status', async (_req, res) => {
  const client = await getMobSF();
  const mobsfOnline = await client.healthCheck();
  const dockerOk = await checkDockerAvailable();
  res.json({
    mobsfAvailable: mobsfOnline,
    dockerAvailable: dockerOk,
    mobsfAutoStart: dockerOk,
    aiAgentAvailable: true,
    skills: getAvailableSkills(),
  });
});

app.post('/api/mobile/config', (req, res) => {
  const { mobsfUrl, mobsfApiKey } = req.body;
  if (mobsfUrl) process.env.MOBSF_URL = mobsfUrl;
  if (mobsfApiKey) process.env.MOBSF_API_KEY = mobsfApiKey;
  mobsfClient = null;
  res.json({ success: true });
});

app.post('/api/mobile/mobsf/stop', async (_req, res) => {
  await stopMobSFContainer();
  res.json({ success: true });
});

app.post('/api/mobile/upload', mobileUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = (req.file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!['.apk', '.ipa', '.appx', '.zip'].includes(ext)) {
    await rm(join(MOBILE_UPLOADS_DIR, req.file.filename));
    return res.status(400).json({ error: 'Only .apk, .ipa, .appx, .zip files are supported' });
  }
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dest = join(MOBILE_UPLOADS_DIR, `${req.file.filename}${ext}`);
  await mkdir(MOBILE_UPLOADS_DIR, { recursive: true });
  await rename(join(MOBILE_UPLOADS_DIR, req.file.filename), dest);
  res.json({ path: dest, name: safeName, size: req.file.size, ext });
});

app.post('/api/mobile/scan', async (req, res) => {
  const { filePath, fileName, skills: selectedSkills, useMobSF, useAIAgent, testingType, credentials } = req.body;
  if (!filePath) return res.status(400).json({ error: 'No file path provided' });

  const scanId = `mobile-${Date.now()}`;
  const scanData = {
    id: scanId,
    status: 'running',
    fileName: fileName || 'unknown',
    filePath,
    testingType: testingType || 'blackbox',
    startedAt: new Date().toISOString(),
    phases: [],
    mobsfFindings: [],
    aiFindings: [],
    enrichedFindings: [],
    mergedFindings: [],
    apiEndpoints: [],
    appInfo: null,
    progress: [],
    strixScanId: null,
  };
  mobileScans.set(scanId, scanData);
  saveMobileScan(scanData).catch(() => {});
  res.json({ scanId, status: 'running' });

  (async () => {
    try {
      // Phase 1: MobSF static analysis (auto-start Docker if needed)
      if (useMobSF !== false) {
        scanData.phases.push({ name: 'mobsf', status: 'running', startedAt: new Date().toISOString() });
        scanData.progress.push({ type: 'phase', message: 'Preparing MobSF...' });

        const mobsfReady = await startMobSFContainer((p) => scanData.progress.push(p));

        if (mobsfReady) {
          try {
            const client = await getMobSF();
            const uploadResult = await client.upload(filePath, fileName);
            scanData.progress.push({ type: 'mobsf', message: `Uploaded to MobSF: ${uploadResult.hash}` });

            await client.scan(uploadResult.hash);
            scanData.progress.push({ type: 'mobsf', message: 'Static analysis in progress...' });

            const report = await client.getReport(uploadResult.hash);
            scanData.appInfo = getMobSFAppInfo(report);
            scanData.mobsfFindings = normalizeMobSFFindings(report);
            scanData.apiEndpoints = extractApiEndpoints(report);

            const phase = scanData.phases.find(p => p.name === 'mobsf');
            phase.status = 'completed';
            phase.finishedAt = new Date().toISOString();
            phase.findingsCount = scanData.mobsfFindings.length;
            scanData.progress.push({ type: 'mobsf', message: `MobSF found ${scanData.mobsfFindings.length} issues, ${scanData.apiEndpoints.length} API endpoints` });
          } catch (err) {
            const phase = scanData.phases.find(p => p.name === 'mobsf');
            phase.status = 'error';
            phase.error = err.message;
            scanData.progress.push({ type: 'error', message: `MobSF error: ${err.message}` });
          }
        } else {
          const phase = scanData.phases.find(p => p.name === 'mobsf');
          phase.status = 'skipped';
          phase.reason = 'Docker/MobSF not available';
          scanData.progress.push({ type: 'warning', message: 'Could not start MobSF, skipping rule-based scan. Install Docker to enable.' });
        }
      }

      // Phase 2: AI Agent analysis
      if (useAIAgent !== false) {
        scanData.phases.push({ name: 'ai-agent', status: 'running', startedAt: new Date().toISOString() });
        scanData.progress.push({ type: 'phase', message: 'Starting AI Agent analysis...' });

        // Extract APK/IPA metadata directly for AI analysis
        scanData.progress.push({ type: 'phase', message: 'Extracting app metadata...' });
        let apkMeta = { manifest: '', strings: '', fileList: '' };
        try {
          apkMeta = await extractApkMetadata(filePath);
          const metaParts = [apkMeta.manifest && 'manifest', apkMeta.strings && 'strings', apkMeta.fileList && 'file list'].filter(Boolean);
          scanData.progress.push({ type: 'phase', message: `Extracted: ${metaParts.join(', ') || 'none'}` });
        } catch (err) {
          scanData.progress.push({ type: 'warning', message: `Metadata extraction: ${err.message}` });
        }

        let analysisContent = `Mobile App Analysis: ${fileName}\n`;
        analysisContent += `Testing Type: ${testingType === 'greybox' ? 'Grey Box (authenticated)' : 'Black Box (unauthenticated)'}\n`;
        if (testingType === 'greybox' && credentials) {
          analysisContent += `Test credentials provided — analyze authenticated flows and session handling.\n`;
        }
        analysisContent += '\n';
        if (scanData.appInfo) {
          analysisContent += `App Info:\n${JSON.stringify(scanData.appInfo, null, 2)}\n\n`;
        }

        // Add extracted APK/IPA metadata
        if (apkMeta.manifest) {
          analysisContent += `=== AndroidManifest.xml / Info.plist ===\n${apkMeta.manifest}\n\n`;
        }
        if (apkMeta.strings) {
          analysisContent += `=== Extracted Strings (URLs, secrets, sensitive APIs) ===\n${apkMeta.strings}\n\n`;
        }
        if (apkMeta.fileList) {
          analysisContent += `=== Archive File Listing ===\n${apkMeta.fileList}\n\n`;
        }

        if (scanData.mobsfFindings.length) {
          analysisContent += `MobSF Scanner Findings (${scanData.mobsfFindings.length}):\n`;
          for (const f of scanData.mobsfFindings.slice(0, 20)) {
            analysisContent += `- [${f.severity}] ${f.title}: ${f.description?.slice(0, 200)}\n`;
            if (f.evidence?.detail) analysisContent += `  Evidence: ${f.evidence.detail.slice(0, 300)}\n`;
          }
          analysisContent += '\n';
        }

        try {
          const aiFindings = await runAllSkills(analysisContent, {
            skills: selectedSkills,
            onProgress: (p) => {
              scanData.progress.push({ type: 'ai-skill', skill: p.skill, ...p });
            },
          });
          scanData.aiFindings = aiFindings;

          const phase = scanData.phases.find(p => p.name === 'ai-agent');
          phase.status = 'completed';
          phase.finishedAt = new Date().toISOString();
          phase.findingsCount = aiFindings.length;
          scanData.progress.push({ type: 'ai-agent', message: `AI Agent found ${aiFindings.length} issues` });
        } catch (err) {
          const phase = scanData.phases.find(p => p.name === 'ai-agent');
          phase.status = 'error';
          phase.error = err.message;
          scanData.progress.push({ type: 'error', message: `AI Agent error: ${err.message}` });
        }
      }

      // Phase 3: Finding enrichment (if MobSF findings exist)
      if (scanData.mobsfFindings.length > 0 && useAIAgent !== false) {
        scanData.phases.push({ name: 'enrichment', status: 'running', startedAt: new Date().toISOString() });
        scanData.progress.push({ type: 'phase', message: 'Enriching MobSF findings with AI...' });

        try {
          const enriched = await enrichFindings(scanData.mobsfFindings.slice(0, 15), (p) => {
            scanData.progress.push({ type: 'enrichment', ...p });
          });
          scanData.enrichedFindings = enriched;
          const phase = scanData.phases.find(p => p.name === 'enrichment');
          phase.status = 'completed';
          phase.finishedAt = new Date().toISOString();
        } catch (err) {
          const phase = scanData.phases.find(p => p.name === 'enrichment');
          phase.status = 'error';
          phase.error = err.message;
        }
      }

      // Merge all findings
      const seen = new Set();
      scanData.mergedFindings = [];
      for (const f of [...scanData.mobsfFindings, ...scanData.aiFindings, ...scanData.enrichedFindings]) {
        const key = `${f.title}-${f.severity}`.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          scanData.mergedFindings.push(f);
        }
      }

      scanData.status = 'completed';
      scanData.finishedAt = new Date().toISOString();
      scanData.progress.push({ type: 'complete', message: `Scan complete: ${scanData.mergedFindings.length} total findings` });
      saveMobileScan(scanData).catch(() => {});
    } catch (err) {
      scanData.status = 'error';
      scanData.progress.push({ type: 'error', message: `Scan failed: ${err.message}` });
      saveMobileScan(scanData).catch(() => {});
    }
  })();
});

app.get('/api/mobile/scan/:id', (req, res) => {
  const scan = mobileScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

app.get('/api/mobile/scans', (_req, res) => {
  const scans = Array.from(mobileScans.values()).map(({ filePath, ...rest }) => rest);
  res.json(scans);
});

app.delete('/api/mobile/scan/:id', (req, res) => {
  const scan = mobileScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  mobileScans.delete(req.params.id);
  deleteMobileScan(req.params.id).catch(() => {});
  res.json({ success: true });
});

app.post('/api/mobile/scan/:id/api-pentest', async (req, res) => {
  const scan = mobileScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (!scan.apiEndpoints.length) return res.status(400).json({ error: 'No API endpoints extracted' });

  const config = await loadConfig();
  const llm = process.env.STRIX_LLM || config.llm;
  const apiKey = process.env.LLM_API_KEY || config.api_key;
  const apiBase = process.env.LLM_API_BASE || config.api_base;
  const isOllama = llm?.startsWith('ollama/');
  if (!llm || (!apiKey && !isOllama)) return res.status(400).json({ error: 'LLM not configured' });

  const targets = req.body.targets || scan.apiEndpoints.slice(0, 5);
  const scanId = `scan-${Date.now()}`;
  const args = ['-n'];
  for (const t of targets) args.push('--target', t);
  args.push('--scan-mode', req.body.scanMode || 'standard');

  const instructions = ['Focus on API security: authentication bypass, IDOR, injection, broken access control, rate limiting. These endpoints were extracted from a mobile app.'];
  if (scan.testingType === 'greybox') {
    instructions.push('Perform grey-box testing with the provided credentials.');
  }
  args.push('--instruction', instructions.join(' '));

  const scanEnv = buildScanEnv(llm, apiKey, apiBase);
  const child = spawn(STRIX_BIN, args, { env: scanEnv, cwd: resolve('.') });

  const strixScan = {
    id: scanId, status: 'running', output: '', findings: [],
    targets, scanMode: req.body.scanMode || 'standard', testingType: scan.testingType || 'blackbox',
    startedAt: new Date().toISOString(), pid: child.pid, runName: null,
    source: 'mobile-api-extract',
    mobileScanId: scan.id,
  };
  activeScans.set(scanId, strixScan);
  saveScan(strixScan).catch(() => {});
  scan.strixScanId = scanId;
  saveMobileScan(scan).catch(() => {});

  child.stdout.on('data', (data) => { strixScan.output += data.toString(); tryParseRunName(strixScan); });
  child.stderr.on('data', (data) => { strixScan.output += data.toString(); });
  child.on('close', async (code) => {
    strixScan.status = code === 0 ? 'completed' : 'failed';
    strixScan.exitCode = code;
    strixScan.finishedAt = new Date().toISOString();
    if (strixScan.runName) strixScan.findings = await loadFindings(strixScan.runName);
    saveScan(strixScan).catch(() => {});
  });
  child.on('error', (err) => {
    strixScan.status = 'error';
    strixScan.output += `\nError: ${err.message}`;
    saveScan(strixScan).catch(() => {});
  });

  res.json({ scanId, targets, message: `Strix API pentest started on ${targets.length} endpoints` });
});

app.get('/api/mobile/skills', (_req, res) => {
  res.json(getAvailableSkills());
});

app.patch('/api/mobile/scan/:id/finding/:fid', (req, res) => {
  const scan = mobileScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const finding = scan.mergedFindings?.find(f => f.id === req.params.fid);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });
  if (req.body.severity !== undefined) finding.severity = req.body.severity;
  if (req.body.status !== undefined) finding.status = req.body.status;
  if (req.body.notes !== undefined) finding.notes = req.body.notes;
  saveMobileScan(scan).catch(() => {});
  res.json({ success: true, finding });
});

app.delete('/api/mobile/scan/:id/finding/:fid', (req, res) => {
  const scan = mobileScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const idx = scan.mergedFindings?.findIndex(f => f.id === req.params.fid);
  if (idx === -1 || idx === undefined) return res.status(404).json({ error: 'Finding not found' });
  scan.mergedFindings.splice(idx, 1);
  saveMobileScan(scan).catch(() => {});
  res.json({ success: true });
});

// === Dynamic Mobile Pentest Pipeline ===
// Docker-based: emulator + mitmproxy + frida + Strix API pentest
// Cross-platform: linux (KVM), macos (redroid/sw), device (real phone)

const MOBILE_PENTEST_DIR = join(resolve('.'), 'mobile-pentest');
const TRAFFIC_DIR = join(MOBILE_PENTEST_DIR, 'traffic');
const COMPOSE_FILE = join(MOBILE_PENTEST_DIR, 'docker-compose.yml');

const EMULATOR_HOST_SCRIPT = join(MOBILE_PENTEST_DIR, 'emulator-host.sh');

// --- LLM helper for AI crawler ---
async function callLLM(messages, maxTokens = 1024) {
  const cfg = await loadConfig();
  const apiKey = process.env.LLM_API_KEY || cfg.api_key;
  const llm = process.env.STRIX_LLM || cfg.llm || '';
  let apiBase = process.env.OPENAI_API_BASE || process.env.LLM_API_BASE || cfg.api_base || '';

  const prefix = llm.split('/')[0];
  const model = llm.includes('/') ? llm.split('/').slice(1).join('/') : llm;

  if (prefix === 'groq') apiBase = 'https://api.groq.com/openai/v1';
  else if (prefix === 'deepseek') apiBase = apiBase || 'https://api.deepseek.com/v1';
  else if (prefix === 'dashscope') apiBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  else if (!apiBase) apiBase = 'https://api.openai.com/v1';

  const resp = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// Extract package name from APK binary manifest (no aapt needed)
async function extractPackageFromAPK(apkPath) {
  const buf = await new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-p', apkPath, 'AndroidManifest.xml']);
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', () => {});
    proc.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('unzip failed')));
  });
  // Binary Android XML stores strings in UTF-16LE
  const chars = [];
  for (let i = 0; i < buf.length - 1; i += 2) {
    const c = buf[i] | (buf[i + 1] << 8);
    chars.push(c >= 32 && c < 127 ? String.fromCharCode(c) : '\0');
  }
  const segments = chars.join('').split('\0').filter(Boolean);
  // Valid Android package: starts with known TLD, 3+ dot-separated segments
  const tlds = new Set(['com', 'org', 'net', 'io', 'vn', 'de', 'cz', 'jp', 'kr', 'cn', 'uk', 'fr', 'in', 'ru', 'br', 'me', 'tv', 'co', 'app', 'dev']);
  const pkgs = [...new Set(segments.filter(s => {
    if (!/^[a-z]{2,4}\.[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(s)) return false;
    const firstSeg = s.split('.')[0];
    if (!tlds.has(firstSeg)) return false;
    if (s.startsWith('android.') || s.startsWith('androidx.')) return false;
    if (s.includes('.permission.') || s.includes('.intent.')) return false;
    return true;
  }))];
  // The app's package is usually the one that matches the APK structure
  // Prefer packages that don't look like libraries
  const libPrefixes = ['com.google.', 'com.android.', 'com.firebase.', 'com.vkey.'];
  const appPkgs = pkgs.filter(p => !libPrefixes.some(lp => p.startsWith(lp)));
  return appPkgs[0] || pkgs[0] || '';
}

// --- AI App Crawler: UIAutomator + LLM-driven exploration ---
async function aiCrawlApp(ADB, pkg, duration, log, checkStop) {
  const visited = new Set();
  const actions = [];
  const startTime = Date.now();
  let screenCount = 0;
  const MAX_SCREENS = 50;

  async function getScreenXML() {
    try {
      await ADB(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml'], 10000);
      return await ADB(['shell', 'cat', '/sdcard/ui.xml'], 10000);
    } catch { return ''; }
  }

  function parseClickables(xml) {
    const elements = [];
    const regex = /<node[^>]*\bclickable="true"[^>]*>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const node = match[0];
      const text = node.match(/text="([^"]*)"/)?.[1] || '';
      const resId = node.match(/resource-id="([^"]*)"/)?.[1] || '';
      const cls = node.match(/class="([^"]*)"/)?.[1] || '';
      const desc = node.match(/content-desc="([^"]*)"/)?.[1] || '';
      const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (bounds) {
        const [, x1, y1, x2, y2] = bounds.map(Number);
        elements.push({
          text: text || desc || resId.split('/').pop() || cls.split('.').pop(),
          resId, cls, bounds: { x1, y1, x2, y2 },
          cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2),
        });
      }
    }
    return elements;
  }

  function getScreenSignature(xml) {
    const ids = [];
    const regex = /resource-id="([^"]+)"/g;
    let m;
    while ((m = regex.exec(xml)) !== null) ids.push(m[1]);
    const texts = [];
    const tRegex = /text="([^"]{1,50})"/g;
    while ((m = tRegex.exec(xml)) !== null) if (m[1]) texts.push(m[1]);
    return [...ids.slice(0, 10), ...texts.slice(0, 10)].join('|');
  }

  async function ensureAppForeground() {
    const focus = await ADB(['shell', 'dumpsys', 'activity', 'activities', '|', 'grep', 'mResumedActivity'], 5000).catch(() => '');
    if (!focus.includes(pkg)) {
      await ADB(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 5000).catch(() => {});
      for (let w = 0; w < 10; w++) {
        await new Promise(r => setTimeout(r, 1000));
        const xml = await getScreenXML();
        if (xml && parseClickables(xml).length > 0) break;
      }
    }
  }

  // Launch app and wait for UI to be ready before crawling
  log('crawl', 'Launching app and waiting for UI...');
  await ADB(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 5000).catch(() => {});
  for (let wait = 0; wait < 15; wait++) {
    await new Promise(r => setTimeout(r, 1000));
    const xml = await getScreenXML();
    if (xml && parseClickables(xml).length > 0) {
      log('crawl', 'App UI ready');
      break;
    }
    if (wait === 14) log('crawl', 'UI wait timeout — starting crawl anyway');
  }

  while (Date.now() - startTime < duration * 1000 && screenCount < MAX_SCREENS) {
    if (checkStop()) break;
    await ensureAppForeground();
    const xml = await getScreenXML();
    if (!xml) { await new Promise(r => setTimeout(r, 2000)); continue; }

    const sig = getScreenSignature(xml);
    const isNew = !visited.has(sig);
    visited.add(sig);
    screenCount++;

    const clickables = parseClickables(xml);
    if (!clickables.length) {
      await ADB(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    log('crawl', `Screen ${screenCount}${isNew ? ' (new)' : ' (revisit)'}: ${clickables.length} clickable elements`);

    // Build a compact summary for LLM
    const elementList = clickables.slice(0, 30).map((el, i) =>
      `${i}: "${el.text}" [${el.cls.split('.').pop()}] at (${el.cx},${el.cy})`
    ).join('\n');

    let nextAction;
    try {
      const llmResp = await callLLM([
        { role: 'system', content: `You are an Android app crawler for security testing. Your job is to explore ALL functions of the app to trigger API calls. You must visit every screen, click every button, open every menu. Respond with ONLY a JSON object:
{"action":"tap","index":<element_index>} — to tap an element
{"action":"type","index":<element_index>,"text":"..."} — to type in a field then tap it
{"action":"scroll","direction":"down"} — to scroll and reveal more content
{"action":"back"} — to go back
{"action":"done"} — if all visible elements have been explored

Prioritize: login/register buttons, menu items, settings, navigation tabs, form submissions, any button you haven't clicked yet. Avoid: language selectors, share buttons, app store links.` },
        { role: 'user', content: `Package: ${pkg}\nScreen ${screenCount}, ${visited.size} unique screens visited.\nPrevious actions: ${actions.slice(-5).map(a => a.desc).join(' → ')}\n\nClickable elements:\n${elementList}\n\nWhat should I click next to discover more API endpoints?` },
      ], 200);

      nextAction = JSON.parse(llmResp.trim().replace(/```json?\n?/g, '').replace(/```/g, ''));
    } catch {
      // Fallback: click unvisited-looking elements
      const unclicked = clickables.filter(el => !actions.some(a => a.text === el.text));
      const target = unclicked[0] || clickables[Math.floor(Math.random() * clickables.length)];
      nextAction = { action: 'tap', index: clickables.indexOf(target) };
    }

    try {
      if (nextAction.action === 'tap' && nextAction.index != null && clickables[nextAction.index]) {
        const el = clickables[nextAction.index];
        await ADB(['shell', 'input', 'tap', String(el.cx), String(el.cy)]);
        actions.push({ action: 'tap', text: el.text, desc: `tap "${el.text}"` });
        log('crawl', `→ Tap: "${el.text}"`);
      } else if (nextAction.action === 'type' && nextAction.index != null && clickables[nextAction.index]) {
        const el = clickables[nextAction.index];
        await ADB(['shell', 'input', 'tap', String(el.cx), String(el.cy)]);
        await new Promise(r => setTimeout(r, 500));
        await ADB(['shell', 'input', 'text', (nextAction.text || 'test').replace(/ /g, '%s')]);
        actions.push({ action: 'type', text: `${el.text}="${nextAction.text}"`, desc: `type "${nextAction.text}" in "${el.text}"` });
        log('crawl', `→ Type: "${nextAction.text}" in "${el.text}"`);
      } else if (nextAction.action === 'scroll') {
        const dir = nextAction.direction === 'up' ? '500 1500 500 500' : '500 500 500 1500';
        await ADB(['shell', 'input', 'swipe', ...dir.split(' ')]);
        actions.push({ action: 'scroll', desc: `scroll ${nextAction.direction || 'down'}` });
        log('crawl', `→ Scroll ${nextAction.direction || 'down'}`);
      } else if (nextAction.action === 'back') {
        await ADB(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
        actions.push({ action: 'back', desc: 'back' });
        log('crawl', '→ Back');
      } else if (nextAction.action === 'done') {
        log('crawl', 'AI: all visible elements explored');
        if (visited.size > 3) break;
        await ADB(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
      }
    } catch (e) {
      log('crawl', `Action failed: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  log('crawl', `AI crawl complete: ${visited.size} unique screens, ${actions.length} actions in ${Math.round((Date.now() - startTime) / 1000)}s`);
  return { screens: visited.size, actions: actions.length };
}

// Auto-detect platform profile
// hybrid = emulator on host (macOS/Windows), Docker for mitmproxy only
// linux  = everything in Docker (KVM emulator)
// device = real phone via ADB
async function detectPentestProfile() {
  const os = (await import('os')).default;
  const platform = os.platform();
  const arch = os.arch();

  // Check if a Docker emulator profile is already running
  const ps = await runCmd('docker', ['compose', '-f', COMPOSE_FILE, 'ps', '--format', '{{.Service}}'], 5000);
  if (ps.includes('android-kvm')) return { profile: 'linux', mode: 'docker', androidContainer: 'mobile-pentest-android-kvm-1', fridaScriptsPath: '/root/frida-scripts' };
  if (ps.includes('adb-bridge')) return { profile: 'device', mode: 'docker', androidContainer: 'mobile-pentest-adb-bridge-1', fridaScriptsPath: '/frida-scripts' };

  // Check if host emulator is running (hybrid mode)
  const hostStatus = await runCmd('sh', ['-c', `"${EMULATOR_HOST_SCRIPT}" status 2>/dev/null || echo '{"running":false}'`], 5000);
  try {
    const st = JSON.parse(hostStatus.trim());
    if (st.running) return { profile: 'hybrid', mode: 'host', adbSerial: `emulator-${st.port}`, sdkRoot: st.sdk, fridaScriptsPath: join(MOBILE_PENTEST_DIR, 'frida-scripts') };
  } catch {}

  // Auto-select
  if (platform === 'linux' && arch === 'x64') {
    const kvmCheck = await runCmd('sh', ['-c', 'test -e /dev/kvm && echo yes'], 3000);
    if (kvmCheck.includes('yes')) return { profile: 'linux', mode: 'docker', androidContainer: 'mobile-pentest-android-kvm-1', fridaScriptsPath: '/root/frida-scripts' };
  }
  if (platform === 'win32') {
    const wslKvm = await runCmd('wsl', ['-e', 'sh', '-c', 'test -e /dev/kvm && echo yes'], 3000);
    if (wslKvm.includes('yes')) return { profile: 'linux', mode: 'docker', androidContainer: 'mobile-pentest-android-kvm-1', fridaScriptsPath: '/root/frida-scripts' };
  }

  // macOS or no KVM: hybrid mode (host emulator + Docker mitmproxy)
  const sdkRoot = process.env.ANDROID_SDK_ROOT || join(os.homedir(), '.android-sdk');
  return { profile: 'hybrid', mode: 'host', adbSerial: 'emulator-5554', sdkRoot, fridaScriptsPath: join(MOBILE_PENTEST_DIR, 'frida-scripts') };
}

// Frida arch: match the emulator's ABI
async function getFridaArch(profile) {
  const os = (await import('os')).default;
  if (profile === 'linux') return 'x86_64';
  if (profile === 'hybrid' && os.arch() === 'arm64') return 'arm64';
  return 'x86_64';
}

// ADB command builder: Docker exec for docker mode, SDK adb for host mode
function makeADB(info) {
  if (info.mode === 'docker') {
    return (args, timeout = 30000) => runCmd('docker', ['exec', info.androidContainer, 'adb', ...args], timeout);
  }
  // Host mode: prefer SDK's adb to match emulator's adb server
  const adbBin = info.sdkRoot ? join(info.sdkRoot, 'platform-tools', 'adb') : 'adb';
  return (args, timeout = 30000) => runCmd(adbBin, ['-s', info.adbSerial, ...args], timeout);
}

// Docker CP or direct file ops depending on mode
function makeCopyToDevice(info) {
  if (info.mode === 'docker') {
    return (src, dest, timeout = 60000) => runCmd('docker', ['cp', src, `${info.androidContainer}:${dest}`], timeout);
  }
  const adbBin = info.sdkRoot ? join(info.sdkRoot, 'platform-tools', 'adb') : 'adb';
  return (src, dest, timeout = 60000) => runCmd(adbBin, ['-s', info.adbSerial, 'push', src, dest], timeout);
}

// Check dynamic pentest infrastructure status
app.get('/api/mobile/dynamic/status', async (_req, res) => {
  const checks = { emulator: false, mitmproxy: false, frida: false, profile: null, mode: null };
  try {
    const info = await detectPentestProfile();
    checks.profile = info.profile;
    checks.mode = info.mode;

    // Check Docker services (mitmproxy always in Docker)
    const ps = await new Promise(r => {
      let o = '';
      const p = spawn('docker', ['compose', '-f', COMPOSE_FILE, 'ps', '--format', 'json']);
      p.stdout.on('data', d => { o += d; });
      p.on('close', () => r(o));
      p.on('error', () => r(''));
    });
    for (const line of ps.trim().split('\n').filter(Boolean)) {
      try {
        const c = JSON.parse(line);
        const name = c.Service || c.Name || '';
        const running = (c.State === 'running');
        if (name.includes('android') || name.includes('adb-bridge')) checks.emulator = running;
        if (name.includes('mitmproxy')) checks.mitmproxy = running;
      } catch {}
    }

    // Hybrid mode: check host emulator
    if (info.mode === 'host') {
      try {
        const st = JSON.parse((await runCmd('sh', ['-c', `"${EMULATOR_HOST_SCRIPT}" status 2>/dev/null || echo '{"running":false}'`], 5000)).trim());
        checks.emulator = st.booted || false;
      } catch {}
    }

    // Check frida
    if (checks.emulator) {
      try {
        const ADB = makeADB(info);
        const fr = await ADB(['shell', 'ps | grep frida'], 5000);
        checks.frida = fr.includes('frida-server');
      } catch {}
    }
  } catch {}
  res.json(checks);
});

// Start the pentest stack
app.post('/api/mobile/dynamic/start', async (req, res) => {
  try {
    const forceProfile = req.body?.profile;
    const info = forceProfile ? { profile: forceProfile, mode: forceProfile === 'hybrid' ? 'host' : 'docker' } : await detectPentestProfile();
    let out = '';

    // Always start mitmproxy in Docker (no profile needed, it's in all profiles)
    const dockerProc = spawn('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'mitmproxy']);
    await new Promise(r => {
      dockerProc.stderr.on('data', d => { out += d; });
      dockerProc.stdout.on('data', d => { out += d; });
      dockerProc.on('close', r);
    });

    if (info.mode === 'docker' && info.profile !== 'hybrid') {
      // Start Docker emulator
      const emProc = spawn('docker', ['compose', '-f', COMPOSE_FILE, '--profile', info.profile, 'up', '-d']);
      await new Promise(r => {
        emProc.stderr.on('data', d => { out += d; });
        emProc.stdout.on('data', d => { out += d; });
        emProc.on('close', r);
      });
    } else {
      // Hybrid: start host emulator
      const emOut = await runCmd('sh', ['-c', `"${EMULATOR_HOST_SCRIPT}" start 2>&1`], 300000);
      out += emOut;
    }

    res.json({ success: true, profile: info.profile, mode: info.mode, output: out.slice(-500) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop everything
app.post('/api/mobile/dynamic/stop', async (_req, res) => {
  try {
    // Stop Docker services
    for (const profile of ['linux', 'device']) {
      const proc = spawn('docker', ['compose', '-f', COMPOSE_FILE, '--profile', profile, 'down']);
      await new Promise(r => proc.on('close', r));
    }
    // Also stop base services (mitmproxy)
    const proc = spawn('docker', ['compose', '-f', COMPOSE_FILE, 'down']);
    await new Promise(r => proc.on('close', r));
    // Stop host emulator
    await runCmd('sh', ['-c', `"${EMULATOR_HOST_SCRIPT}" stop 2>/dev/null || true`], 10000);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full dynamic scan: auto-detect OS → start infra if needed → install APK → frida → crawl → traffic → pentest → config checks
app.post('/api/mobile/dynamic/scan', async (req, res) => {
  const { filePath, fileName, packageName, testingType, crawlDuration } = req.body;
  if (!filePath) return res.status(400).json({ error: 'No APK file path' });

  const scanId = `mobile-${Date.now()}`;
  const duration = crawlDuration || 300;
  const scanData = {
    id: scanId, status: 'running', fileName: fileName || 'unknown', filePath,
    testingType: testingType || 'blackbox', startedAt: new Date().toISOString(),
    scanType: 'dynamic',
    phases: [], progress: [], mergedFindings: [],
    appInfo: null, apiEndpoints: [], capturedTraffic: [],
    configChecks: { sslPinning: null, rootDetection: null, insecureStorage: null, hardcodedCreds: [] },
  };
  mobileScans.set(scanId, scanData);
  saveMobileScan(scanData).catch(() => {});
  res.json({ scanId, status: 'running' });

  const log = (type, message) => scanData.progress.push({ type, message, ts: new Date().toISOString() });

  (async () => {
    try {
      // Detect platform and container names
      const pentestInfo = await detectPentestProfile();
      const FRIDA_PATH = pentestInfo.fridaScriptsPath;
      const fridaArch = await getFridaArch(pentestInfo.profile);
      scanData.profile = pentestInfo.profile;
      scanData.mode = pentestInfo.mode;

      const ADB = makeADB(pentestInfo);
      const copyToDevice = makeCopyToDevice(pentestInfo);

      // Phase 0: Auto-start infrastructure if not running
      scanData.phases.push({ name: 'infra', status: 'running', startedAt: new Date().toISOString() });
      log('phase', `Detected ${pentestInfo.profile}/${pentestInfo.mode} — checking infrastructure...`);

      // Always ensure mitmproxy is running (Docker)
      let mitmRunning = false;
      try {
        const mitmCheck = await runCmd('docker', ['inspect', '--format', '{{.State.Running}}', 'mobile-pentest-mitmproxy-1'], 5000);
        mitmRunning = mitmCheck.includes('true');
      } catch {}
      if (!mitmRunning) {
        log('infra', 'Starting mitmproxy...');
        const mitmProc = spawn('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'mitmproxy']);
        let mitmOut = '';
        mitmProc.stdout.on('data', d => { mitmOut += d; });
        mitmProc.stderr.on('data', d => { mitmOut += d; });
        await Promise.race([
          new Promise(r => { mitmProc.on('close', r); mitmProc.on('error', r); }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('mitmproxy start timeout (60s)')), 60000)),
        ]);
        // Verify it's actually running
        for (let i = 0; i < 10; i++) {
          try {
            const check = await runCmd('docker', ['inspect', '--format', '{{.State.Running}}', 'mobile-pentest-mitmproxy-1'], 5000);
            if (check.includes('true')) break;
          } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
        log('infra', 'mitmproxy started');
      } else {
        log('infra', 'mitmproxy already running');
      }

      // Start emulator if not running
      if (pentestInfo.mode === 'docker') {
        let emulatorRunning = false;
        try {
          const containerCheck = await runCmd('docker', ['inspect', '--format', '{{.State.Running}}', pentestInfo.androidContainer], 5000);
          emulatorRunning = containerCheck.includes('true');
        } catch {}
        if (!emulatorRunning) {
          log('infra', `Starting Docker emulator (${pentestInfo.profile})...`);
          const emProc = spawn('docker', ['compose', '-f', COMPOSE_FILE, '--profile', pentestInfo.profile, 'up', '-d']);
          await new Promise(r => { emProc.on('close', r); emProc.on('error', r); });
          log('infra', 'Emulator container started, waiting for boot...');
        } else {
          log('infra', 'Emulator container already running');
        }
      } else {
        // Host mode: check and start host emulator
        const adbCheck = pentestInfo.sdkRoot ? join(pentestInfo.sdkRoot, 'platform-tools', 'adb') : 'adb';
        let emulatorRunning = false;
        try {
          const devices = await runCmd(adbCheck, ['devices'], 5000);
          emulatorRunning = devices.includes(pentestInfo.adbSerial);
        } catch {}
        if (!emulatorRunning) {
          log('infra', 'Starting host Android emulator (first run may download SDK ~2GB)...');
          await runCmd('sh', ['-c', `"${EMULATOR_HOST_SCRIPT}" start 2>&1`], 300000);
          log('infra', 'Host emulator started');
        } else {
          log('infra', 'Host emulator already running');
        }
      }

      scanData.phases.find(p => p.name === 'infra').status = 'completed';

      // Phase 1: Setup emulator + install APK
      scanData.phases.push({ name: 'setup', status: 'running', startedAt: new Date().toISOString() });
      log('phase', 'Waiting for emulator boot...');

      // Wait for emulator boot
      for (let i = 0; i < 90; i++) {
        if (scanData.status === 'stopped') throw new Error('Scan stopped by user');
        const boot = (await ADB(['shell', 'getprop', 'sys.boot_completed'])).trim();
        if (boot === '1') { log('setup', 'Emulator booted'); break; }
        if (i === 89) { log('error', 'Emulator boot timeout (3 min)'); throw new Error('Emulator not ready'); }
        await new Promise(r => setTimeout(r, 2000));
      }

      // Install APK
      log('setup', `Installing ${fileName}...`);
      await copyToDevice(filePath, '/tmp/app.apk', 60000);
      const installOut = await ADB(['install', '-r', '/tmp/app.apk']);
      if (!installOut.includes('Success')) log('warning', `Install: ${installOut.trim()}`);

      // Detect package name from APK binary manifest
      let pkg = packageName || '';
      if (!pkg) {
        try {
          pkg = await extractPackageFromAPK(filePath);
          log('setup', `Package from APK manifest: ${pkg}`);
        } catch (e) {
          log('warning', `APK manifest parse failed: ${e.message}, falling back to pm list`);
        }
      }
      if (!pkg) {
        const packages = await ADB(['shell', 'pm', 'list', 'packages', '-3']);
        const lines = packages.trim().split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean);
        pkg = lines[lines.length - 1] || '';
      }
      scanData.appInfo = { packageName: pkg, fileName };
      log('setup', `Package: ${pkg}`);

      scanData.phases.find(p => p.name === 'setup').status = 'completed';

      // Phase 2: Install mitmproxy CA + Frida + SSL/root bypass
      scanData.phases.push({ name: 'instrumentation', status: 'running', startedAt: new Date().toISOString() });
      log('phase', 'Setting up instrumentation...');

      // Set proxy
      await ADB(['shell', 'settings', 'put', 'global', 'http_proxy', 'mitmproxy:8080']);
      log('setup', 'Proxy configured');

      // Install mitmproxy CA cert
      try {
        await runCmd('docker', ['cp', 'mobile-pentest-mitmproxy-1:/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.cer', '/tmp/mitm-ca.cer'], 10000);
        const hash = (await runCmd('openssl', ['x509', '-inform', 'PEM', '-subject_hash_old', '-in', '/tmp/mitm-ca.cer'])).split('\n')[0];
        await runCmd('cp', ['/tmp/mitm-ca.cer', `/tmp/${hash}.0`]);
        await copyToDevice(`/tmp/${hash}.0`, '/tmp/ca.0', 10000);
        await ADB(['root']);
        await new Promise(r => setTimeout(r, 2000));
        await ADB(['remount']);
        await ADB(['shell', `cp /tmp/ca.0 /system/etc/security/cacerts/${hash}.0 && chmod 644 /system/etc/security/cacerts/${hash}.0`]);
        log('setup', 'mitmproxy CA cert installed');
      } catch (e) {
        log('warning', `CA cert install failed: ${e.message} — HTTPS interception may not work`);
      }

      // Push and start frida-server (auto-detect arch, version-match host)
      try {
        let fridaVer = '17.1.2';
        try { fridaVer = (await runCmd('frida', ['--version'], 5000)).trim(); } catch {}
        const deviceVer = await ADB(['shell', '/data/local/tmp/frida-server --version 2>/dev/null || echo none'], 5000).then(v => v.trim()).catch(() => 'none');
        if (deviceVer !== fridaVer) {
          log('setup', `Frida version mismatch (device: ${deviceVer}, host: ${fridaVer}) — updating...`);
          await ADB(['shell', 'killall frida-server 2>/dev/null || true']);
          await runCmd('sh', ['-c', `curl -sL https://github.com/frida/frida/releases/download/${fridaVer}/frida-server-${fridaVer}-android-${fridaArch}.xz -o /tmp/frida-server.xz && xz -d -f /tmp/frida-server.xz`], 120000);
          await copyToDevice('/tmp/frida-server', '/data/local/tmp/frida-server', 30000);
          await ADB(['shell', 'chmod 755 /data/local/tmp/frida-server']);
          log('setup', `frida-server ${fridaVer} installed`);
        }
        await ADB(['shell', 'killall frida-server 2>/dev/null; /data/local/tmp/frida-server -D &']);
        await new Promise(r => setTimeout(r, 2000));
        log('setup', 'frida-server running');
      } catch (e) {
        log('warning', `Frida setup: ${e.message}`);
      }

      // Launch app with Frida SSL + root bypass
      log('setup', 'Launching app with SSL pinning + root detection bypass...');
      let fridaProc;
      let fridaFailed = false;
      if (pentestInfo.mode === 'docker') {
        fridaProc = spawn('docker', [
          'exec', pentestInfo.androidContainer, 'frida', '-U', '-f', pkg,
          '-l', `${FRIDA_PATH}/ssl-bypass.js`,
          '-l', `${FRIDA_PATH}/root-bypass.js`,
          '--kill-on-exit',
        ]);
      } else {
        fridaProc = spawn('frida', [
          '-U', '-f', pkg,
          '-l', `${FRIDA_PATH}/ssl-bypass.js`,
          '-l', `${FRIDA_PATH}/root-bypass.js`,
          '--kill-on-exit',
        ]);
      }
      let fridaOut = '';
      let fridaMessages = [];
      let fridaExited = false;
      fridaProc.stdout.on('data', d => {
        const s = d.toString();
        fridaOut += s;
        for (const line of s.split('\n')) {
          try {
            const msg = JSON.parse(line.trim());
            if (msg.payload) fridaMessages.push(msg.payload);
          } catch {}
        }
      });
      fridaProc.stderr.on('data', d => { fridaOut += d.toString(); });
      const fridaExitPromise = new Promise(r => fridaProc.on('close', (code) => { fridaExited = true; r(code); }));

      // Wait for Frida hooks — or detect early exit (anti-Frida)
      await Promise.race([
        new Promise(r => setTimeout(r, 12000)),
        fridaExitPromise,
      ]);

      // Detect anti-Frida: if Frida crashed or app killed itself
      if (fridaExited || fridaOut.includes('Failed to attach') || fridaOut.includes('connection closed') || fridaOut.includes('Failed to spawn')) {
        log('check', 'Anti-Frida detected — retrying with anti-Frida bypass script...');
        try { fridaProc.kill(); } catch {}

        // Retry with anti-frida-bypass.js loaded first
        let retryExited = false;
        let retryOut = '';
        const retryArgs = pentestInfo.mode === 'docker'
          ? ['exec', pentestInfo.androidContainer, 'frida', '-U', '-f', pkg,
             '-l', `${FRIDA_PATH}/anti-frida-bypass.js`,
             '-l', `${FRIDA_PATH}/ssl-bypass.js`,
             '-l', `${FRIDA_PATH}/root-bypass.js`,
             '--kill-on-exit']
          : ['-U', '-f', pkg,
             '-l', `${FRIDA_PATH}/anti-frida-bypass.js`,
             '-l', `${FRIDA_PATH}/ssl-bypass.js`,
             '-l', `${FRIDA_PATH}/root-bypass.js`,
             '--kill-on-exit'];
        const retryBin = pentestInfo.mode === 'docker' ? 'docker' : 'frida';
        const retryProc = spawn(retryBin, retryArgs);
        retryProc.stdout.on('data', d => {
          const s = d.toString();
          retryOut += s;
          for (const line of s.split('\n')) {
            try { const msg = JSON.parse(line.trim()); if (msg.payload) fridaMessages.push(msg.payload); } catch {}
          }
        });
        retryProc.stderr.on('data', d => { retryOut += d.toString(); });
        const retryExitP = new Promise(r => retryProc.on('close', () => { retryExited = true; r(); }));

        await Promise.race([new Promise(r => setTimeout(r, 15000)), retryExitP]);

        if (retryExited || retryOut.includes('Failed to attach') || retryOut.includes('Failed to spawn')) {
          // Bypass failed — genuine anti-Frida
          fridaFailed = true;
          log('check', 'Anti-Frida bypass failed — app has strong tamper protection');
          scanData.configChecks.antiFrida = true;
          scanData.configChecks.sslPinning = 'anti_tamper';
          scanData.configChecks.rootDetection = 'anti_tamper';
          scanData.fridaDetails = { antiFrida: true, bypassAttempted: true, fridaOutput: retryOut.slice(-300) };
          try { retryProc.kill(); } catch {}

          log('setup', 'Relaunching app without Frida for crawling...');
          await ADB(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          // Bypass worked — keep retryProc as the active Frida process
          log('check', 'Anti-Frida bypass succeeded — Frida attached with bypass');
          fridaProc = retryProc;
          fridaOut = retryOut;
          fridaExited = false;
          scanData.configChecks.antiFrida = true;
          scanData.fridaDetails = { antiFrida: true, bypassSucceeded: true };
          // Parse results from retry output below
        }
      }

      if (!fridaFailed) {
        // Parse bypass results from Frida output
        let sslBypassed = [];
        let rootBypassed = [];
        const sslMatch = fridaOut.match(/SSL Pinning Bypass loaded:\s*(\[.*?\])/);
        if (sslMatch) try { sslBypassed = JSON.parse(sslMatch[1]); } catch {}
        const rootMatch = fridaOut.match(/Root Detection Bypass loaded:\s*(\[.*?\])/);
        if (rootMatch) try { rootBypassed = JSON.parse(rootMatch[1]); } catch {}

        for (const msg of fridaMessages) {
          if (msg.type === 'ssl_bypass' && msg.results?.bypassed?.length) sslBypassed = msg.results.bypassed;
          if (msg.type === 'root_bypass' && msg.results?.bypassed?.length) rootBypassed = msg.results.bypassed;
        }

        const hasRootDetection = rootBypassed.some(b =>
          b.includes('RootBeer') || b.includes('File.exists') || b.includes('PackageManager') || b.includes('Runtime.exec')
        );
        const hasSslPinning = sslBypassed.some(b =>
          b.includes('CertificatePinner') || b.includes('certificatePinner') || b.includes('Flutter')
        );

        scanData.configChecks.sslPinning = hasSslPinning ? 'bypassed' : (sslBypassed.length ? 'basic_only' : 'not_detected');
        scanData.configChecks.rootDetection = hasRootDetection ? 'bypassed' : (rootBypassed.length ? 'basic_only' : 'not_detected');
        scanData.fridaDetails = { sslBypassed, rootBypassed };
        log('check', `SSL pinning: ${scanData.configChecks.sslPinning} (hooks: ${sslBypassed.join(', ') || 'none'})`);
        log('check', `Root detection: ${scanData.configChecks.rootDetection} (hooks: ${rootBypassed.join(', ') || 'none'})`);
      }

      scanData.phases.find(p => p.name === 'instrumentation').status = 'completed';

      // Phase 3: AI crawl — explore all screens to trigger API endpoints
      scanData.phases.push({ name: 'crawl', status: 'running', startedAt: new Date().toISOString() });
      log('phase', `Crawling app for ${duration}s to discover API endpoints...`);

      // Clear traffic file
      await runCmd('docker', ['exec', 'mobile-pentest-mitmproxy-1', 'sh', '-c', 'rm -f /home/mitmproxy/traffic/flows.jsonl']);

      // AI-driven app exploration: UIAutomator + LLM decides what to click
      log('crawl', 'AI crawler: reading screens and deciding actions via LLM...');
      const crawlResult = await aiCrawlApp(
        ADB, pkg, duration, log,
        () => scanData.status === 'stopped',
      );
      scanData.crawlResult = crawlResult;

      // Stop frida
      try { fridaProc.kill(); } catch {}
      await ADB(['shell', `am force-stop ${pkg}`]);

      scanData.phases.find(p => p.name === 'crawl').status = 'completed';

      // Phase 4: Collect and parse traffic
      scanData.phases.push({ name: 'traffic-analysis', status: 'running', startedAt: new Date().toISOString() });
      log('phase', 'Analyzing captured traffic...');

      await mkdir(TRAFFIC_DIR, { recursive: true });
      await runCmd('docker', ['cp', 'mobile-pentest-mitmproxy-1:/home/mitmproxy/traffic/flows.jsonl', join(TRAFFIC_DIR, `${scanId}.jsonl`)], 30000);

      let trafficData = [];
      try {
        const raw = await readFile(join(TRAFFIC_DIR, `${scanId}.jsonl`), 'utf-8');
        trafficData = raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch {}

      scanData.capturedTraffic = trafficData;
      const uniqueHosts = [...new Set(trafficData.map(t => t.host))];
      const apiEndpoints = [...new Set(trafficData.map(t => `${t.method} ${t.url.split('?')[0]}`))];
      scanData.apiEndpoints = apiEndpoints;
      log('traffic', `Captured ${trafficData.length} requests to ${uniqueHosts.length} hosts, ${apiEndpoints.length} unique endpoints`);

      scanData.phases.find(p => p.name === 'traffic-analysis').status = 'completed';

      // Phase 5: Feed traffic to Strix for API pentesting
      if (apiEndpoints.length > 0) {
        scanData.phases.push({ name: 'api-pentest', status: 'running', startedAt: new Date().toISOString() });
        log('phase', `Starting Strix API pentest on ${Math.min(apiEndpoints.length, 10)} endpoints...`);

        // Extract unique target base URLs
        const targetUrls = [...new Set(trafficData.filter(t => t.status_code).map(t => {
          const u = new URL(t.url);
          return `${u.protocol}//${u.host}`;
        }))].slice(0, 5);

        if (targetUrls.length > 0) {
          const config = await loadConfig();
          const llm = process.env.STRIX_LLM || config.llm;
          const apiKey = process.env.LLM_API_KEY || config.api_key;
          const apiBase = process.env.LLM_API_BASE || config.api_base;

          if (llm && (apiKey || llm.startsWith('ollama/'))) {
            const args = ['-n'];
            for (const t of targetUrls) args.push('--target', t);
            args.push('--scan-mode', 'standard');

            // Build instruction with captured traffic context
            const trafficSummary = trafficData.slice(0, 50).map(t =>
              `${t.method} ${t.url} -> ${t.status_code} ${t.content_type || ''}`
            ).join('\n');
            args.push('--instruction', `Mobile app API pentest. Intercepted traffic:\n${trafficSummary}\n\nFocus on: auth bypass, IDOR, injection, broken access control, data exposure.`);

            const scanEnv = buildScanEnv(llm, apiKey, apiBase);
            const strixChild = spawn(STRIX_BIN, args, { env: scanEnv, cwd: resolve('.') });

            const strixScanId = `scan-${Date.now()}`;
            const strixScan = {
              id: strixScanId, status: 'running', output: '', findings: [],
              targets: targetUrls, scanMode: 'standard', testingType: testingType || 'blackbox',
              startedAt: new Date().toISOString(), pid: strixChild.pid, runName: null,
              source: 'mobile-dynamic', mobileScanId: scanId,
            };
            activeScans.set(strixScanId, strixScan);
            saveScan(strixScan).catch(() => {});
            scanData.strixScanId = strixScanId;

            strixChild.stdout.on('data', d => { strixScan.output += d.toString(); tryParseRunName(strixScan); });
            strixChild.stderr.on('data', d => { strixScan.output += d.toString(); });

            await new Promise(resolve => {
              strixChild.on('close', async (code) => {
                strixScan.status = code === 0 ? 'completed' : 'failed';
                strixScan.finishedAt = new Date().toISOString();
                if (strixScan.runName) strixScan.findings = await loadFindings(strixScan.runName);
                saveScan(strixScan).catch(() => {});
                log('api-pentest', `Strix finished: ${strixScan.findings.length} findings`);
                resolve();
              });
              strixChild.on('error', (err) => {
                strixScan.status = 'error';
                saveScan(strixScan).catch(() => {});
                log('error', `Strix error: ${err.message}`);
                resolve();
              });
            });

            // Add Strix findings to merged
            for (const f of strixScan.findings) {
              scanData.mergedFindings.push({ ...f, source: 'strix-api-pentest' });
            }
          } else {
            log('warning', 'LLM not configured — skipping Strix API pentest');
          }
        }
        const phase = scanData.phases.find(p => p.name === 'api-pentest');
        if (phase) phase.status = 'completed';
      }

      // Phase 6: Config security checks (real checks, not noise)
      scanData.phases.push({ name: 'config-checks', status: 'running', startedAt: new Date().toISOString() });
      log('phase', 'Running security config checks...');

      // Check insecure storage — look for sensitive data in SharedPreferences
      try {
        const sharedPrefs = await ADB(['shell', `run-as ${pkg} ls /data/data/${pkg}/shared_prefs/ 2>/dev/null || ls /data/data/${pkg}/shared_prefs/ 2>/dev/null`]);
        if (sharedPrefs.trim()) {
          const prefFiles = sharedPrefs.trim().split('\n').filter(f => f.endsWith('.xml'));
          for (const pf of prefFiles.slice(0, 10)) {
            const content = await ADB(['shell', `run-as ${pkg} cat /data/data/${pkg}/shared_prefs/${pf.trim()} 2>/dev/null || cat /data/data/${pkg}/shared_prefs/${pf.trim()} 2>/dev/null`]);
            const sensitiveMatches = content.match(/(password|token|secret|api.?key|session|auth|credential|private.?key|jwt|bearer|access.?token|refresh.?token)["']\s*(?:value=["'])([^"']+)/gi) || [];
            if (sensitiveMatches.length) {
              scanData.configChecks.insecureStorage = 'vulnerable';
              scanData.mergedFindings.push({
                id: `DYN-STORAGE-${Math.random().toString(36).slice(2, 6)}`,
                title: `Sensitive data in SharedPreferences: ${pf.trim()}`,
                severity: 'High',
                description: `Found ${sensitiveMatches.length} sensitive value(s) stored in plaintext in SharedPreferences.`,
                evidence: { detail: sensitiveMatches.slice(0, 5).join('\n'), steps: [`Open ${pf}`, 'Sensitive values found in plaintext'] },
                impact: 'Attacker with device access or backup can extract credentials/tokens.',
                remediation: 'Use EncryptedSharedPreferences or Android Keystore for sensitive data.',
                source: 'dynamic-check', status: 'Open', confidence: 'High',
                tags: ['storage', 'MASVS-STORAGE'],
              });
              log('finding', `Insecure storage: sensitive data in ${pf.trim()}`);
            }
          }
          if (!scanData.configChecks.insecureStorage) scanData.configChecks.insecureStorage = 'ok';
        }
      } catch (e) {
        log('warning', `Storage check: ${e.message}`);
      }

      // Check for hardcoded credentials in extracted APK strings
      try {
        const apkMeta = await extractApkMetadata(filePath);
        const credPatterns = [
          /(?:password|passwd|pwd)\s*[=:]\s*["']([^"']{4,})/gi,
          /(?:api[_-]?key|apikey)\s*[=:]\s*["']([A-Za-z0-9_\-]{16,})/gi,
          /(?:secret[_-]?key|client[_-]?secret)\s*[=:]\s*["']([^"']{8,})/gi,
          /(?:Bearer|Basic)\s+([A-Za-z0-9+/=_\-.]{20,})/g,
          /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
        ];
        const allStrings = `${apkMeta.manifest}\n${apkMeta.strings}`;
        for (const pattern of credPatterns) {
          const matches = allStrings.match(pattern) || [];
          for (const match of matches.slice(0, 3)) {
            scanData.configChecks.hardcodedCreds.push(match.slice(0, 100));
          }
        }
        if (scanData.configChecks.hardcodedCreds.length) {
          scanData.mergedFindings.push({
            id: `DYN-CRED-${Math.random().toString(36).slice(2, 6)}`,
            title: 'Hardcoded credentials/secrets in APK',
            severity: 'Critical',
            description: `Found ${scanData.configChecks.hardcodedCreds.length} hardcoded credential(s) in the APK binary.`,
            evidence: { detail: scanData.configChecks.hardcodedCreds.join('\n') },
            impact: 'Attacker can extract credentials from the APK and gain unauthorized access.',
            remediation: 'Remove hardcoded credentials. Use server-side auth, environment config, or Android Keystore.',
            source: 'dynamic-check', status: 'Open', confidence: 'High',
            tags: ['credentials', 'MASVS-STORAGE'],
          });
          log('finding', `Hardcoded credentials found: ${scanData.configChecks.hardcodedCreds.length}`);
        }
      } catch {}

      // Anti-tamper finding (app blocked Frida injection)
      if (scanData.configChecks.antiFrida) {
        scanData.mergedFindings.push({
          id: `DYN-ANTITAMPER-${Math.random().toString(36).slice(2, 6)}`,
          title: 'Anti-Frida / Anti-Tampering Protection Detected',
          severity: 'Info',
          description: 'App detected and blocked Frida dynamic instrumentation. The agent connection was closed immediately, indicating runtime integrity checks.',
          evidence: { detail: `Frida spawn failed: ${(scanData.fridaDetails?.fridaOutput || '').slice(-200)}` },
          impact: 'This is a positive security control. The app resists runtime hooking and dynamic analysis.',
          remediation: 'No action needed — this is good security practice. Ensure this protection covers all build variants.',
          source: 'dynamic-check', status: 'Info', confidence: 'High',
          tags: ['tampering', 'MASVS-RESILIENCE'],
        });
        log('finding', 'Anti-Frida protection: app blocked dynamic instrumentation');
      }

      // SSL pinning findings
      const httpsTraffic = trafficData.filter(t => t.url?.startsWith('https://'));
      if (scanData.configChecks.sslPinning === 'anti_tamper') {
        // Already covered by anti-tamper finding
      } else if (scanData.configChecks.sslPinning === 'bypassed') {
        scanData.mergedFindings.push({
          id: `DYN-SSL-${Math.random().toString(36).slice(2, 6)}`,
          title: 'SSL Certificate Pinning Bypassed',
          severity: 'Medium',
          description: `SSL pinning was implemented (${scanData.fridaDetails?.sslBypassed?.filter(b => b.includes('Pinner') || b.includes('Flutter')).join(', ')}) but successfully bypassed using Frida.`,
          evidence: { detail: `Bypassed hooks: ${scanData.fridaDetails?.sslBypassed?.join(', ')}. Intercepted ${httpsTraffic.length} HTTPS requests.`, steps: ['Attach Frida to app', 'Load ssl-bypass.js', 'All HTTPS traffic interceptable'] },
          pocScriptCode: 'frida -U -f <package> -l ssl-bypass.js',
          impact: 'MitM attacker on same network can intercept/modify all API traffic.',
          remediation: 'Implement certificate pinning at network layer with pinning enforcement that resists Frida bypass (e.g., native pinning, obfuscated checks).',
          source: 'dynamic-check', status: 'Open', confidence: 'High',
          tags: ['network', 'MASVS-NETWORK'],
        });
        log('finding', 'SSL pinning implemented but bypassable');
      } else if (scanData.configChecks.sslPinning === 'basic_only' || scanData.configChecks.sslPinning === 'not_detected') {
        if (httpsTraffic.length > 0) {
          scanData.mergedFindings.push({
            id: `DYN-NOSSL-${Math.random().toString(36).slice(2, 6)}`,
            title: 'No SSL Certificate Pinning Implemented',
            severity: 'Medium',
            description: 'App does not implement SSL certificate pinning. All HTTPS traffic was interceptable without any bypass.',
            evidence: { detail: `Intercepted ${httpsTraffic.length} HTTPS requests. Only basic TrustManager hooks present — no app-level pinning (OkHttp, Flutter, etc).` },
            impact: 'MitM attacker can intercept API traffic with a rogue CA certificate.',
            remediation: 'Implement certificate pinning using OkHttp CertificatePinner or network_security_config.xml.',
            source: 'dynamic-check', status: 'Open', confidence: 'High',
            tags: ['network', 'MASVS-NETWORK'],
          });
        }
      }

      // Root detection findings
      if (scanData.configChecks.rootDetection === 'anti_tamper') {
        // Already covered by anti-tamper finding above
      } else if (scanData.configChecks.rootDetection === 'bypassed') {
        scanData.mergedFindings.push({
          id: `DYN-ROOT-${Math.random().toString(36).slice(2, 6)}`,
          title: 'Root Detection Bypassed',
          severity: 'Medium',
          description: `App implements root detection (${scanData.fridaDetails?.rootBypassed?.join(', ')}) but it was bypassed using Frida.`,
          evidence: { detail: `Bypassed hooks: ${scanData.fridaDetails?.rootBypassed?.join(', ')}` },
          pocScriptCode: 'frida -U -f <package> -l root-bypass.js',
          impact: 'Attacker can run the app on a rooted device and tamper with its runtime behavior.',
          remediation: 'Implement multi-layered root detection with native checks, integrity verification, and anti-tampering (e.g., SafetyNet/Play Integrity API).',
          source: 'dynamic-check', status: 'Open', confidence: 'High',
          tags: ['tampering', 'MASVS-RESILIENCE'],
        });
        log('finding', 'Root detection implemented but bypassable');
      } else if (scanData.configChecks.rootDetection === 'basic_only') {
        scanData.mergedFindings.push({
          id: `DYN-ROOT-${Math.random().toString(36).slice(2, 6)}`,
          title: 'Basic Root Detection Only',
          severity: 'Low',
          description: 'App has basic system property checks but no dedicated root detection library (RootBeer, SafetyNet).',
          evidence: { detail: `Only basic hooks: ${scanData.fridaDetails?.rootBypassed?.join(', ')}` },
          remediation: 'Implement proper root detection using RootBeer or Play Integrity API.',
          source: 'dynamic-check', status: 'Open', confidence: 'Medium',
          tags: ['tampering', 'MASVS-RESILIENCE'],
        });
      } else if (scanData.configChecks.rootDetection === 'not_detected') {
        scanData.mergedFindings.push({
          id: `DYN-ROOT-${Math.random().toString(36).slice(2, 6)}`,
          title: 'No Root/Jailbreak Detection',
          severity: 'Low',
          description: 'App does not implement any root/jailbreak detection. No Frida hooks attached to root-checking methods.',
          remediation: 'Implement root detection (e.g., RootBeer library, Play Integrity API) to prevent runtime tampering.',
          source: 'dynamic-check', status: 'Open', confidence: 'High',
          tags: ['tampering', 'MASVS-RESILIENCE'],
        });
      }

      scanData.phases.find(p => p.name === 'config-checks').status = 'completed';

      // Done
      scanData.status = 'completed';
      scanData.finishedAt = new Date().toISOString();
      log('complete', `Dynamic scan complete: ${scanData.mergedFindings.length} findings from ${trafficData.length} intercepted requests`);
      saveMobileScan(scanData).catch(() => {});

    } catch (err) {
      scanData.status = 'error';
      scanData.progress.push({ type: 'error', message: `Scan failed: ${err.message}` });
      const running = scanData.phases.find(p => p.status === 'running');
      if (running) running.status = 'error';
      saveMobileScan(scanData).catch(() => {});
    }
  })();
});

// Get captured traffic for a dynamic scan
app.get('/api/mobile/dynamic/:id/traffic', (req, res) => {
  const scan = mobileScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const traffic = (scan.capturedTraffic || []).map(({ response_body, ...rest }) => rest);
  res.json({ count: traffic.length, traffic: traffic.slice(0, 200) });
});

// Serve frontend in production
const PUBLIC_DIR = resolve('./public');
if (existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });
}

const PORT = process.env.PORT || 3001;

(async () => {
  try {
    await connectDB();
    await initUsers();
    const savedScans = await loadAllScans();
    for (const s of savedScans) {
      if (s.status === 'running') s.status = 'interrupted';
      activeScans.set(s.id, s);
    }
    const savedMobile = await loadAllMobileScans();
    for (const s of savedMobile) {
      if (s.status === 'running') s.status = 'interrupted';
      mobileScans.set(s.id, s);
    }
    console.log(`Restored ${savedScans.length} web scans, ${savedMobile.length} mobile scans from DB`);
  } catch (err) {
    console.warn(`MongoDB not available (${err.message}), running in memory-only mode`);
  }
  app.listen(PORT, () => console.log(`Strix Web Server running on http://localhost:${PORT}`));
})();
