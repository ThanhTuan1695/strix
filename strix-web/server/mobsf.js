const DEFAULT_MOBSF_URL = 'http://localhost:8000';
const DEFAULT_API_KEY = process.env.MOBSF_API_KEY || '';

export class MobSFClient {
  constructor(url, apiKey) {
    this.baseUrl = (url || DEFAULT_MOBSF_URL).replace(/\/+$/, '');
    this.apiKey = apiKey || DEFAULT_API_KEY;
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers = { Authorization: this.apiKey, ...options.headers };

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MobSF API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async healthCheck() {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/scans`, {
        headers: { Authorization: this.apiKey },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async upload(filePath, fileName) {
    const { readFile } = await import('fs/promises');
    const fileData = await readFile(filePath);

    const formData = new FormData();
    formData.append('file', new Blob([fileData]), fileName);

    return this.request('/upload', {
      method: 'POST',
      body: formData,
    });
  }

  async scan(hash) {
    const formData = new FormData();
    formData.append('hash', hash);
    formData.append('re_scan', '0');

    return this.request('/scan', {
      method: 'POST',
      body: formData,
    });
  }

  async getReport(hash) {
    const formData = new FormData();
    formData.append('hash', hash);

    return this.request('/report_json', {
      method: 'POST',
      body: formData,
    });
  }

  async getScorecard(hash) {
    const formData = new FormData();
    formData.append('hash', hash);

    return this.request('/scorecard', {
      method: 'POST',
      body: formData,
    });
  }

  async getSourceCode(hash) {
    const formData = new FormData();
    formData.append('hash', hash);
    formData.append('type', 'apk');

    return this.request('/view_source', {
      method: 'POST',
      body: formData,
    });
  }

  async getRecentScans() {
    return this.request('/scans', { method: 'GET' });
  }

  async deleteScan(hash) {
    const formData = new FormData();
    formData.append('hash', hash);

    return this.request('/delete_scan', {
      method: 'POST',
      body: formData,
    });
  }
}

export function normalizeMobSFFindings(report) {
  const findings = [];

  // MobSF v4: code_analysis.findings is {ruleId: {files, metadata}}
  const codeFindings = report.code_analysis?.findings || report.code_analysis || {};
  if (typeof codeFindings === 'object' && !Array.isArray(codeFindings)) {
    for (const [ruleId, details] of Object.entries(codeFindings)) {
      if (ruleId === 'summary' || !details?.metadata) continue;
      const filesObj = details.files || {};
      const fileEntries = Object.entries(filesObj).map(([path, line]) => ({ file_path: path, match_position: line }));
      findings.push({
        id: `MOBSF-CODE-${ruleId.slice(0, 12)}`,
        title: details.metadata?.description || ruleId,
        severity: mapMobSFSeverity(details.metadata?.severity || 'info'),
        description: details.metadata?.description || '',
        technicalAnalysis: `Rule: ${ruleId}\nCVSS: ${details.metadata?.cvss || 'N/A'}\nMASVS: ${details.metadata?.['owasp-mobile'] || 'N/A'}\nRef: ${details.metadata?.ref || ''}`,
        evidence: {
          raw: fileEntries.map(f => `${f.file_path}:${f.match_position}`).join('\n'),
          request: null,
          response: null,
          steps: [],
          detail: fileEntries.map(f => `File: ${f.file_path}\nLine: ${f.match_position}`).join('\n---\n'),
        },
        pocDescription: '',
        pocScriptCode: '',
        impact: details.metadata?.description || '',
        remediation: details.metadata?.description || '',
        remediationSteps: '',
        affectedAsset: fileEntries[0]?.file_path || '',
        cwe: details.metadata?.cwe || null,
        confidence: 'High',
        status: 'Open',
        tags: ['mobsf', 'code-analysis'],
        source: 'mobsf',
        method: '',
        fixEffort: '',
        owaspCategory: details.metadata?.['owasp-mobile'] || null,
        cvss: details.metadata?.cvss || null,
        cvssVector: null,
      });
    }
  }

  // MobSF v4: manifest_analysis.manifest_findings is an array
  const manifestFindings = report.manifest_analysis?.manifest_findings || (Array.isArray(report.manifest_analysis) ? report.manifest_analysis : []);
  for (const issue of manifestFindings) {
    findings.push({
      id: `MOBSF-MANIFEST-${Math.random().toString(36).slice(2, 6)}`,
      title: issue.title || 'Manifest Issue',
      severity: mapMobSFSeverity(issue.severity || issue.stat || 'info'),
      description: issue.description || issue.desc || '',
      technicalAnalysis: `Rule: ${issue.rule || 'N/A'}`,
      evidence: { raw: issue.description || issue.desc, request: null, response: null, steps: [], detail: issue.description || issue.desc || '' },
      pocDescription: '',
      pocScriptCode: '',
      impact: issue.description || issue.desc || '',
      remediation: issue.description || issue.desc || '',
      remediationSteps: '',
      affectedAsset: 'AndroidManifest.xml',
      cwe: null,
      confidence: 'High',
      status: 'Open',
      tags: ['mobsf', 'manifest'],
      source: 'mobsf',
      method: '',
      fixEffort: '',
      owaspCategory: null,
      cvss: null,
      cvssVector: null,
    });
  }

  // MobSF v4: network_security.network_findings is an array
  const networkFindings = report.network_security?.network_findings || (Array.isArray(report.network_security) ? report.network_security : []);
  for (const issue of networkFindings) {
    findings.push({
      id: `MOBSF-NET-${Math.random().toString(36).slice(2, 6)}`,
      title: issue.title || issue.description || 'Network Security Issue',
      severity: mapMobSFSeverity(issue.severity || 'info'),
      description: issue.description || '',
      technicalAnalysis: issue.scope ? `Scope: ${JSON.stringify(issue.scope)}` : '',
      evidence: { raw: issue.description, request: null, response: null, steps: [], detail: issue.description || '' },
      pocDescription: '',
      pocScriptCode: '',
      impact: issue.description || '',
      remediation: issue.description || '',
      remediationSteps: '',
      affectedAsset: 'Network Configuration',
      cwe: null,
      confidence: 'High',
      status: 'Open',
      tags: ['mobsf', 'network'],
      source: 'mobsf',
      method: '',
      fixEffort: '',
      owaspCategory: null,
      cvss: null,
      cvssVector: null,
    });
  }

  return findings;
}

export function extractApiEndpoints(report) {
  const endpoints = new Set();

  if (report.urls) {
    for (const url of report.urls) {
      if (url.urls) {
        for (const u of url.urls) {
          if (u.startsWith('http')) endpoints.add(u);
        }
      } else if (typeof url === 'string' && url.startsWith('http')) {
        endpoints.add(url);
      }
    }
  }

  if (report.domains) {
    for (const [domain, info] of Object.entries(report.domains || {})) {
      if (domain && !domain.includes('google') && !domain.includes('android')) {
        endpoints.add(`https://${domain}`);
      }
    }
  }

  const codeFindings = report.code_analysis?.findings || report.code_analysis || {};
  if (typeof codeFindings === 'object' && !Array.isArray(codeFindings)) {
    for (const [key, details] of Object.entries(codeFindings)) {
      if (key === 'summary' || !details?.files) continue;
      for (const [, matchStr] of Object.entries(details.files || {})) {
        const urlMatches = String(matchStr).match(/https?:\/\/[^\s"'<>]+/g);
        if (urlMatches) urlMatches.forEach(u => endpoints.add(u));
      }
    }
  }

  return [...endpoints].filter(u => {
    try { new URL(u); return true; } catch { return false; }
  });
}

function mapMobSFSeverity(level) {
  const map = {
    high: 'High', warning: 'Medium', info: 'Low', good: 'Info',
    critical: 'Critical', medium: 'Medium', low: 'Low',
    danger: 'High', secure: 'Info', hotspot: 'Medium',
  };
  return map[level?.toLowerCase()] || 'Medium';
}

export function getMobSFAppInfo(report) {
  return {
    appName: report.app_name || '',
    packageName: report.package_name || '',
    version: report.version_name || '',
    versionCode: report.version_code || '',
    minSdk: report.min_sdk || '',
    targetSdk: report.target_sdk || '',
    size: report.size || '',
    md5: report.md5 || '',
    sha256: report.sha256 || '',
    platform: report.app_type || 'android',
    permissions: report.permissions || {},
    activities: report.activities || [],
    services: report.services || [],
    receivers: report.receivers || [],
    providers: report.providers || [],
    securityScore: report.security_score || null,
  };
}
