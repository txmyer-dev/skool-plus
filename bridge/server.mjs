#!/usr/bin/env node
// skool+ bridge: a tiny localhost server that runs Claude Code headless
// (`claude -p`) so the extension uses the laptop's Claude subscription login
// instead of an API key. Binds to 127.0.0.1 only. No tools are enabled for
// the model; it just writes text.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.SKOOLPLUS_BRIDGE_PORT || 47391);
// Spawn the executable directly (no shell): with a shell, the empty `--tools ""` argument is dropped
// and `--tools` swallows the next flag. On Windows Node needs the .exe suffix to resolve it on PATH.
const CLAUDE = process.env.SKOOLPLUS_CLAUDE_BIN || (process.platform === 'win32' ? 'claude.exe' : 'claude');
const VERSION = '0.1.0';

function runClaude({ system, prompt, model = 'claude-opus-5', effort = 'low' }) {
  return new Promise(async (resolve, reject) => {
    const dir = await mkdtemp(join(tmpdir(), 'skoolplus-'));
    const sysFile = join(dir, 'system.txt');
    await writeFile(sysFile, system || '', 'utf8');
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--model', model, '--effort', effort, '--system-prompt-file', sysFile];
    const child = spawn(CLAUDE, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(e));
    child.on('close', async (code) => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      let json;
      try {
        json = JSON.parse(out);
      } catch {
        return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 500)}`));
      }
      if (json.is_error) return reject(new Error(json.result || `claude error (${json.terminal_reason || code})`));
      resolve({ text: String(json.result ?? '').trim(), model: Object.keys(json.modelUsage || {})[0], durationMs: json.duration_ms });
    });
    child.stdin.end(prompt);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') return send(204, {});
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, version: VERSION, claude: CLAUDE });
  if (req.method === 'POST' && req.url === '/complete') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.prompt) return send(400, { error: 'prompt required' });
      const started = Date.now();
      const r = await runClaude(body);
      console.log(`[bridge] ${r.model ?? body.model} ${body.effort ?? ''} ${Date.now() - started}ms → ${r.text.length} chars`);
      return send(200, r);
    } catch (e) {
      console.error('[bridge] error', e.message);
      return send(500, { error: e.message });
    }
  }
  send(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[bridge] skool+ bridge listening on http://127.0.0.1:${PORT} (claude: ${CLAUDE})`));
