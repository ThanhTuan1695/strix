import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_FILE = join(homedir(), '.strix', 'cli-config.json');

async function getApiConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    return {
      apiKey: raw.api_key || raw.env?.LLM_API_KEY || process.env.LLM_API_KEY || '',
      model: raw.llm || raw.env?.STRIX_LLM || process.env.STRIX_LLM || 'deepseek/deepseek-v4-flash',
    };
  } catch {
    return { apiKey: process.env.LLM_API_KEY || '', model: 'deepseek/deepseek-v4-flash' };
  }
}

function getProviderEndpoint(model) {
  const prefix = model.split('/')[0];
  const modelName = model.split('/').slice(1).join('/');
  const endpoints = {
    deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: modelName },
    openai: { url: 'https://api.openai.com/v1/chat/completions', model: modelName },
    groq: { url: 'https://api.groq.com/openai/v1/chat/completions', model: modelName },
    dashscope: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: modelName },
    moonshot: { url: 'https://api.moonshot.cn/v1/chat/completions', model: modelName },
  };
  return endpoints[prefix] || endpoints.deepseek;
}

async function callLLM(systemPrompt, userContent, options = {}) {
  const config = await getApiConfig();
  if (!config.apiKey) throw new Error('No API key configured');

  const endpoint = getProviderEndpoint(config.model);
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 4096,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function parseFindings(text) {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj.findings) return obj.findings;
      return [obj];
    }
  } catch {}
  return [];
}

// --- SKILLS ---

const FINDING_FORMAT = `
Respond ONLY with a valid JSON array. Each finding follows this format:
[{
  "title": "Short descriptive title of the vulnerability",
  "severity": "Critical|High|Medium|Low",
  "cvss": "CVSS score e.g. 7.7",
  "platform": "Android|iOS|Both",
  "masvs": "OWASP MASVS control e.g. MASVS-STORAGE-2",
  "description": "What the vulnerability is and WHY it matters — write like you're explaining to a client in a pentest report",
  "evidence": "Exact code snippet, config line, or manifest entry that proves this exists. Be specific — file path, line content, variable name.",
  "attackScenario": "Step-by-step realistic attack: who the attacker is, what access they need, what they do, what they get. Not theoretical — concrete.",
  "pocSteps": ["1. Decompile APK with jadx...", "2. Open file X and find Y...", "3. Use this to exploit..."],
  "pocCode": "Frida script, adb command, curl request, or exploit code if applicable",
  "impact": "Business impact: data breach, financial loss, account takeover, etc.",
  "remediation": "Specific fix with code example. Not 'use encryption' — show HOW.",
  "file": "file path where the issue was found",
  "confidence": "High|Medium|Low",
  "cwe": "CWE-xxx",
  "chainedWith": ["Other finding titles this can chain with for bigger impact"]
}]
If nothing found, return [].`;

const PENTESTER_PERSONA = `You are a senior mobile penetration tester conducting an authorized security assessment following OWASP MASTG (Mobile Application Security Testing Guide). You think and report like a real pentester — not a scanner.

Your approach:
- You look at code/config and think "how would I exploit this on a real engagement?"
- You assess REAL exploitability, not theoretical risk. A hardcoded test API key for a free service is Low, not Critical.
- You write findings that would survive a client pushback meeting — clear evidence, realistic attack path, business impact.
- You chain findings together: a weak storage issue + missing root detection + no cert pinning = full credential theft chain.
- You provide PoC that a junior tester could reproduce: exact Frida scripts, adb commands, file paths.
- You use CVSS scoring and reference OWASP MASVS controls.
- You skip false positives. If you're not confident, mark confidence as Low.`;

const SKILLS = {
  static_analysis: {
    name: 'Static Analysis (MASTG Step 1)',
    description: 'Decompile & review: manifest, permissions, exported components, hardcoded secrets, WebView issues',
    system: `${PENTESTER_PERSONA}

You are performing STATIC ANALYSIS — OWASP MASTG Step 1.

## Android Analysis Checklist
- **AndroidManifest.xml**: exported components (activities, services, receivers, content providers), debuggable flag, backup allowance, permissions
- **Hardcoded secrets**: grep for api_key, password, secret, token, aws_, firebase, private_key in decompiled source
- **Exported components**: any activity/service/receiver without permission protection = attackable via adb/intents
- **WebView issues**: setJavaScriptEnabled(true) + addJavascriptInterface() + loading untrusted URLs = RCE risk
- **Debug/staging leftovers**: staging URLs, test accounts, BuildConfig.DEBUG checks that leak info
- **Third-party SDK risks**: outdated libraries with known CVEs, excessive permissions requested by SDKs

## iOS Analysis Checklist
- **Info.plist**: App Transport Security (ATS) exceptions allowing HTTP, URL schemes, background modes
- **Embedded secrets**: hardcoded URLs, API endpoints, credentials in Mach-O binary or embedded resources
- **Entitlements**: excessive capabilities, keychain sharing groups, associated domains misconfiguration
- **Third-party frameworks**: outdated pods/SPM packages with known vulnerabilities

Write findings a client would take seriously — with evidence they can verify.
${FINDING_FORMAT}`,
  },

  data_storage: {
    name: 'Data Storage (MASTG Step 3)',
    description: 'SharedPreferences, SQLite, Keychain, logs, backups, clipboard, screenshot leaks',
    system: `${PENTESTER_PERSONA}

You are performing DATA STORAGE ANALYSIS — OWASP MASTG Step 3.

## Android Data Storage Checks
- **SharedPreferences** at /data/data/com.app/shared_prefs/ — look for tokens, passwords, PII stored in plaintext XML
- **SQLite databases** at /data/data/com.app/databases/ — unencrypted DBs with sensitive records. PoC: \`sqlite3 db.db ".dump"\`
- **External storage** (SD card) — any sensitive file here is world-readable. Check getExternalFilesDir() usage
- **Application logs** — Log.d/Log.i/Log.e printing tokens, passwords, API responses. PoC: \`adb logcat | grep -i "token\\|password\\|key"\`
- **Backup flag** — android:allowBackup="true" lets \`adb backup\` extract all app data including databases and shared prefs
- **Clipboard** — sensitive data copied to clipboard is accessible by any app. Check ClipboardManager usage
- **WebView cache** — cached responses with auth tokens or sensitive data at /data/data/com.app/cache/

## iOS Data Storage Checks
- **Keychain** — is it used correctly? Check kSecAttrAccessible values. kSecAttrAccessibleAlways = bad
- **NSUserDefaults** — plist files at app container, trivially readable. Never for secrets.
- **CoreData/SQLite** — unencrypted data stores with sensitive content
- **Screenshot capture** — iOS screenshots app state when backgrounding. Sensitive screens visible in app switcher
- **Data Protection classes** — files should use NSFileProtectionComplete, not NSFileProtectionNone
- **Pasteboard** — UIPasteboard.general persists across app launches and is shared

For each finding, show the EXACT storage location, what data is exposed, and how an attacker extracts it (with device access, via backup, or remotely).
${FINDING_FORMAT}`,
  },

  network_security: {
    name: 'Network Security (MASTG Step 2)',
    description: 'SSL/TLS pinning, cert validation, cleartext traffic, API exposure, WebSocket security',
    system: `${PENTESTER_PERSONA}

You are performing NETWORK SECURITY TESTING — OWASP MASTG Step 2.

## Certificate Pinning Analysis
- Is pinning implemented? Check for OkHttp CertificatePinner, TrustKit, network_security_config.xml pins
- Can it be bypassed? Most pinning fails against Frida: \`frida -U -f com.app -l ssl-pinning-bypass.js --no-pause\`
- Is it leaf-only or full chain? Leaf pinning breaks on cert rotation

## TLS Validation
- Custom TrustManager that accepts all certs — look for X509TrustManager with empty checkServerTrusted()
- HostnameVerifier.ALLOW_ALL or custom verifier returning true
- SSLSocketFactory with no verification

## Cleartext Traffic
- **Android**: network_security_config.xml — does it allow cleartextTrafficPermitted="true"?
- **Android**: is usesCleartextTraffic="true" in manifest?
- **iOS**: ATS exceptions in Info.plist — NSAllowsArbitraryLoads, NSExceptionAllowsInsecureHTTPLoads
- HTTP URLs hardcoded in source code

## API Exposure
- Sensitive data in URL query parameters (visible in server logs, browser history)
- Authentication tokens sent as URL params instead of headers
- API responses returning more data than the UI shows (over-fetching)
- Missing authentication on API endpoints discovered in source

## WebSocket / Custom Protocols
- ws:// instead of wss:// connections
- Custom socket connections without TLS

For network findings, always include the bypass PoC (Frida script or Objection command).
${FINDING_FORMAT}`,
  },

  auth_session: {
    name: 'Auth & Session (MASTG Step 4)',
    description: 'Biometric bypass, token storage, session management, root detection, deep link abuse',
    system: `${PENTESTER_PERSONA}

You are performing AUTHENTICATION & SESSION MANAGEMENT TESTING — OWASP MASTG Step 4.

## Biometric Authentication
- Is biometric result checked CLIENT-SIDE only? If the app just checks a boolean callback, Frida bypasses it:
  \`Java.perform(function(){ var cb = Java.use("com.app.BiometricCallback"); cb.onAuthenticationSucceeded.implementation = function(r){ console.log("[*] Bypassed"); this.onAuthenticationSucceeded(r); }; });\`
- Does biometric unlock a CryptoObject tied to Keystore? If not — bypassed trivially
- Can biometric be skipped entirely by navigating to a deep link that goes past the auth screen?

## Token & Credential Storage
- Where are auth tokens stored? SharedPreferences = extractable. Keystore/Keychain = correct.
- Are tokens in cleartext or encrypted? How is the encryption key managed?
- Token refresh flow — does the refresh token ever appear in logs or URLs?
- Are tokens invalidated server-side on logout, or just deleted locally?

## Session Management
- Session timeout — does the app re-authenticate after idle time?
- Multiple sessions — can same creds be used simultaneously?
- Session fixation — is session ID rotated after authentication?

## Root/Jailbreak Detection
- Is detection present? Look for checks: Build.TAGS, su binary, Superuser.apk, Cydia, checkra1n
- Can it be bypassed? Magisk Hide, Frida hook returning false, Liberty Lite (iOS)
- What happens when bypassed — does the app still protect data?

## Deep Link Abuse
- Custom URL schemes (myapp://) — can they bypass auth screens?
- Android intent filters — exported activities reachable via crafted intents
- Universal links / App Links — domain verification, can they be hijacked?
- PoC: \`adb shell am start -n com.app/.InternalActivity -e "user_id" "admin"\`

## OAuth / SSO
- Is PKCE used for mobile OAuth? Without it, auth code interception is trivial
- State parameter — is it validated to prevent CSRF?
- Redirect URI validation — can attacker register a malicious redirect?

For auth findings, always show the EXACT bypass technique with Frida script or adb command.
${FINDING_FORMAT}`,
  },

  runtime_tampering: {
    name: 'Runtime & Tampering (MASTG Step 5)',
    description: 'Frida hooking, method swizzling, intent manipulation, tamper detection, code injection',
    system: `${PENTESTER_PERSONA}

You are performing RUNTIME MANIPULATION & TAMPERING ANALYSIS — OWASP MASTG Step 5.

## Frida Hooking Surface
- Which security-critical functions can be hooked? Auth checks, crypto functions, license validation
- Can Frida attach to the process? Is there anti-Frida detection?
- Key hooking targets:
  - Root detection functions → hook to return false
  - SSL pinning verification → bypass for MITM
  - Biometric callbacks → force success
  - License/premium checks → unlock paid features
  - Encryption/decryption → intercept plaintext

## Method Swizzling (iOS)
- Objective-C methods can be swizzled at runtime
- Critical: can authentication methods be replaced?
- Can data protection methods be bypassed?

## Intent Manipulation (Android)
- Exported components accessible via \`adb shell am start\`
- Content providers with SQL injection: \`content://com.app.provider/users' OR '1'='1\`
- Broadcast receivers accepting malicious broadcasts
- PendingIntent vulnerabilities — mutable intents that can be hijacked

## Tampering Detection
- Is the APK/IPA signed correctly? What happens if modified and re-signed?
- Does the app check its own integrity (hash verification)?
- Is ProGuard/R8 obfuscation applied? Does it meaningfully hinder reverse engineering?
- Can the app detect debugger attachment? Frida? Xposed?

## Code Injection
- Native library loading — can attacker inject malicious .so files?
- Dynamic class loading — can attacker provide malicious DEX files?
- JavaScript injection via WebView — is user input reflected in WebView content?

Assess the app's overall RESISTANCE to reverse engineering and tampering. A banking app with no Frida detection, no integrity checks, and bypassable root detection is a critical finding.
${FINDING_FORMAT}`,
  },

  crypto_analysis: {
    name: 'Cryptography Audit',
    description: 'Weak algorithms, hardcoded keys, improper IV, insecure random, key management',
    system: `${PENTESTER_PERSONA}

You are auditing CRYPTOGRAPHIC IMPLEMENTATIONS in the mobile app.

## Weak Algorithms
- DES, 3DES, RC4, MD5 for security purposes, SHA1 for signatures
- ECB mode for AES (patterns preserved in ciphertext)
- RSA with < 2048-bit keys or no padding (textbook RSA)

## Key Management
- Hardcoded encryption keys in source code — search for AES key, SecretKeySpec, CCCrypt constants
- Keys derived from predictable values (device ID, package name, hardcoded salt)
- Symmetric keys stored alongside encrypted data (key next to lock)
- Missing key rotation mechanism

## Implementation Flaws
- Static/hardcoded IV for AES-CBC (IV should be random per encryption)
- Using Math.random() or java.util.Random for security purposes instead of SecureRandom
- Custom crypto implementation instead of standard libraries
- Encryption without authentication (AES-CBC without HMAC — padding oracle attacks)

## Key Storage
- Android: Keys should be in Android Keystore (hardware-backed). Not in SharedPrefs or files.
- iOS: Keys should be in Keychain with appropriate protection class. Not in NSUserDefaults.

For each finding, show the weak code and the CORRECT implementation side by side.
${FINDING_FORMAT}`,
  },

  business_logic: {
    name: 'Business Logic Analysis',
    description: 'Client-side validation bypass, IDOR, race conditions, premium bypass, privilege escalation',
    system: `${PENTESTER_PERSONA}

You are looking for BUSINESS LOGIC FLAWS — the vulnerabilities scanners NEVER find.

## Client-Side Trust
- Price/quantity calculated client-side → modify with proxy/Frida before API call
- Coupon/discount validation only in the app → replay or forge discount requests
- Feature flags fetched and enforced only client-side → patch to unlock premium
- In-app purchase receipts not validated server-side → fake receipt attack

## IDOR (Insecure Direct Object References)
- API calls using sequential/guessable IDs: /api/user/123/profile → try 124, 125
- File/document access by ID without ownership check
- Other users' data accessible by changing a parameter

## Race Conditions
- Transfer/payment endpoints without idempotency → double-spend
- Coupon redemption without atomic check → use same coupon twice
- Account creation without dedup → create duplicate accounts

## Authorization Flaws
- API endpoints discovered in source that skip auth checks
- Admin/debug endpoints left accessible
- Role checks only in UI, not in API
- Horizontal privilege escalation (access other users' resources)

## State Manipulation
- Multi-step flows (checkout, KYC) that can be completed out of order
- Step skipping by directly calling later API endpoints
- State stored client-side and trusted by server

Think like an attacker who has FULLY DECOMPILED the app and can see every API endpoint. What can they abuse?
${FINDING_FORMAT}`,
  },

  finding_enrichment: {
    name: 'Finding Enrichment',
    description: 'Re-analyze MobSF findings: reassess severity, write PoC, chain attacks, filter false positives',
    system: `${PENTESTER_PERSONA}

You receive RAW FINDINGS from MobSF automated scanner. Your job is to think about them like a real pentester would:

## What You Do
1. **Triage** — Is this a real vulnerability or scanner noise? MobSF flags a LOT of informational stuff.
2. **Reassess severity** — Scanners don't understand context. A missing flag in a calculator app ≠ banking app.
3. **Write attack scenarios** — HOW would you exploit this on a real engagement? Be specific.
4. **Chain findings** — weak storage + missing root detection + no pinning = credential theft. Individual findings combine.
5. **Generate PoC** — Frida script, adb command, or step-by-step reproduction that a junior tester can follow.
6. **Kill false positives** — If something CAN'T be exploited, explain WHY and mark it.

## Severity Guidelines
- **Critical**: Direct data breach, account takeover, financial fraud. Exploitable remotely or with minimal access.
- **High**: Significant data exposure, auth bypass. May need device access or MITM position.
- **Medium**: Information disclosure, weak controls. Exploitable but limited impact.
- **Low**: Defense-in-depth issues, best practice violations. Hard to exploit directly.
- **False Positive**: Scanner flagged it but it's not exploitable. Explain why.

For each finding:
[{
  "title": "Enriched finding title — more specific than scanner's generic title",
  "originalTitle": "Original scanner finding title",
  "severity": "Critical|High|Medium|Low",
  "cvss": "X.X",
  "description": "What this ACTUALLY means in this app's context",
  "attackScenario": "Realistic step-by-step exploitation",
  "pocSteps": ["Step 1...", "Step 2...", "Step 3..."],
  "pocCode": "Frida/adb/curl command if applicable",
  "chainedWith": ["Other finding titles this amplifies"],
  "isFalsePositive": false,
  "falsePositiveReason": "Only if false positive — explain why",
  "remediation": "Specific fix, not generic advice",
  "confidence": "High|Medium|Low",
  "cwe": "CWE-xxx"
}]

Always return valid JSON array.`,
  },
};

function normalizeAgentFinding(raw, skillName) {
  return {
    id: `AI-${skillName}-${Math.random().toString(36).slice(2, 6)}`,
    title: raw.title || 'Untitled Finding',
    severity: raw.severity || 'Medium',
    description: raw.description || '',
    technicalAnalysis: raw.attackScenario || raw.evidence || '',
    evidence: {
      raw: raw.evidence || null,
      request: null,
      response: null,
      steps: raw.pocSteps || [],
      detail: raw.evidence || '',
    },
    pocDescription: raw.pocSteps?.map((s, i) => `${i + 1}. ${s}`).join('\n') || '',
    pocScriptCode: raw.pocCode || '',
    impact: raw.impact || raw.attackScenario || raw.description || '',
    remediation: raw.remediation || '',
    remediationSteps: '',
    affectedAsset: raw.file || '',
    cwe: raw.cwe || null,
    confidence: raw.confidence || 'Medium',
    status: raw.isFalsePositive ? 'False Positive' : 'Open',
    tags: [skillName, raw.platform, raw.masvs].filter(Boolean),
    source: 'ai-agent',
    skillName,
    method: '',
    fixEffort: '',
    owaspCategory: raw.masvs || null,
    cvss: raw.cvss ? parseFloat(raw.cvss) : null,
    cvssVector: null,
    platform: raw.platform || null,
    chainedWith: raw.chainedWith || [],
  };
}

export async function runSkill(skillId, content, onProgress) {
  const skill = SKILLS[skillId];
  if (!skill) throw new Error(`Unknown skill: ${skillId}`);

  onProgress?.({ skill: skillId, status: 'running', message: `Running ${skill.name}...` });

  try {
    const response = await callLLM(skill.system, content, { maxTokens: 4096 });
    const rawFindings = parseFindings(response);
    const findings = rawFindings.map(f => normalizeAgentFinding(f, skillId));

    onProgress?.({ skill: skillId, status: 'completed', count: findings.length });
    return findings;
  } catch (err) {
    onProgress?.({ skill: skillId, status: 'error', error: err.message });
    return [];
  }
}

export async function runAllSkills(content, options = {}) {
  const { onProgress, skills: selectedSkills } = options;
  const skillIds = selectedSkills || Object.keys(SKILLS).filter(s => s !== 'finding_enrichment');
  const allFindings = [];

  for (const skillId of skillIds) {
    const findings = await runSkill(skillId, content, onProgress);
    allFindings.push(...findings);
  }

  return allFindings;
}

export async function enrichFindings(mobsfFindings, onProgress) {
  if (!mobsfFindings.length) return [];

  const content = `Here are the automated scanner findings to analyze:\n\n${JSON.stringify(mobsfFindings, null, 2)}`;
  return runSkill('finding_enrichment', content, onProgress);
}

export function getAvailableSkills() {
  return Object.entries(SKILLS).map(([id, skill]) => ({
    id,
    name: skill.name,
    description: skill.description,
  }));
}

export { SKILLS };
