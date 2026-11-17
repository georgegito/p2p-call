// End-to-end check, entirely on this machine: a "human" browser whose microphone plays
// a recorded sentence joins a room; the MCP server is driven like an assistant would
// drive it. Passes when the bot hears the human's sentence and the human hears the bot's.
//
//   node test/e2e.mjs      (run from call-mcp/; needs `npm ci` in the repo root too)

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { cleanTranscript, config, pageCapture, wav } from '../bot.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SITE = 'http://localhost:8800';
const tmp = await mkdtemp(join(tmpdir(), 'call-mcp-test-'));
const step = (...a) => console.log('·', ...a);
const cleanup = [];
let failed = false;
const check = (ok, what, detail = '') => { console.log(ok ? 'PASS' : 'FAIL', what, detail); if (!ok) failed = true; };

try {
  // The test site + local relay (the same one the app's own tests use).
  const up = () => fetch(`${SITE}/meta.json`).then(r => r.ok, () => false);
  if (!(await up())) {
    step('starting the test site');
    const srv = spawn('node', ['tests/serve.mjs'], { cwd: ROOT, stdio: 'ignore' });
    cleanup.push(() => srv.kill());
    for (let i = 0; i < 120 && !(await up()); i++) await new Promise(r => setTimeout(r, 500));
    if (!(await up())) throw new Error('test site did not start');
  }

  // The human's "microphone": a sentence, then quiet, on a loop.
  const spoken = join(tmp, 'spoken.wav');
  const mic = join(tmp, 'mic.wav');
  await run('say', ['-o', spoken, '--file-format=WAVE', '--data-format=LEI16@48000', 'Hello Claude. What is the capital of France?']);
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', spoken, '-af', 'apad=pad_dur=6', '-ar', '48000', '-ac', '1', mic]);

  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
  cleanup.push(() => browser.close());
  const context = await browser.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'], viewport: { width: 390, height: 844 } });
  const human = await context.newPage();
  human.on('dialog', d => d.dismiss().catch(() => {}));

  // What the human hears, captured the same way the bot captures.
  const heardByHuman = [];
  await human.addInitScript(() => { window.__callBot = { taps: new Map(), nextId: 1, timer: 0 }; });
  await human.exposeFunction('__callAudio', (id, who, b64) => heardByHuman.push(Buffer.from(b64, 'base64')));
  await human.exposeFunction('__callGone', () => {});
  await human.exposeFunction('__callRoster', () => {});

  step('human creates a room and joins');
  await human.goto(`${SITE}/current/`);
  await human.click('#addBtn');
  await human.fill('#addName', 'Bot test');
  await human.click('#saveBtn');
  await human.locator('.room', { hasText: 'Bot test' }).locator('.icon-btn').click();
  await human.locator('#sheet').waitFor({ state: 'visible' });
  const link = await human.inputValue('#sheetLink');
  await human.click('#sheetDone');
  await human.locator('.room', { hasText: 'Bot test' }).locator('.main').click();
  await human.fill('#nameInput', 'Maria');
  await human.click('#joinBtn');
  await human.locator('#call').waitFor({ state: 'visible', timeout: 15000 });
  await human.evaluate(pageCapture);

  step('starting the MCP server');
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(HERE, '..', 'server.mjs')], stderr: 'inherit' }));
  cleanup.push(() => client.close());
  const call = async (name, args = {}) => {
    const t = Date.now();
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    const out = r.content.map(c => c.text).join('\n');
    step(`${name} → ${JSON.stringify(out)} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    return { out, isError: !!r.isError };
  };

  const tools = (await client.listTools()).tools.map(t => t.name).sort();
  check(tools.join() === 'call_status,join_call,leave_call,listen,say', 'tools are listed', tools.join(', '));

  const joined = await call('join_call', { link });
  check(!joined.isError && /Maria/.test(joined.out), 'bot joins and sees the human');
  const tile = human.locator('#grid .tile', { hasText: 'Claude' });
  await tile.waitFor({ state: 'visible', timeout: 20000 });
  check(true, 'human sees a "Claude" tile');

  // The sentence loops, so the first thing heard may be its tail; allow a few tries.
  let heard = '';
  for (let i = 0; i < 4 && !/capital of France/i.test(heard); i++) heard += '\n' + (await call('listen', { timeout_s: 30 })).out;
  check(/→ Maria: .*capital of France/i.test(heard), 'bot hears and transcribes the human, with their name, and notices it was addressed');

  heardByHuman.length = 0;
  const said = await call('say', { text: 'The capital of France is Paris.' });
  check(!said.isError, 'bot speaks');
  await new Promise(r => setTimeout(r, 1500));
  const file = join(tmp, 'human-heard.wav');
  await writeFile(file, wav(heardByHuman));
  const { stdout } = await run(config.whisper, ['-m', config.model, '-f', file, '-l', 'en', '-nt', '-np']);
  const whatHumanHeard = cleanTranscript(stdout);
  check(/Paris/i.test(whatHumanHeard), 'human hears the bot', JSON.stringify(whatHumanHeard));

  const status = await call('call_status');
  check(/Maria/.test(status.out), 'status names the human');

  await call('leave_call');
  await tile.waitFor({ state: 'detached', timeout: 10000 }).then(() => check(true, 'bot leaves cleanly (tile gone at once)'), () => check(false, 'bot leaves cleanly'));
} catch (e) {
  failed = true;
  console.error('ERROR', e);
} finally {
  for (const f of cleanup.reverse()) await Promise.resolve().then(f).catch(() => {});
  await rm(tmp, { recursive: true, force: true });
}
console.log(failed ? '\nFAILED' : '\nALL PASSED');
process.exit(failed ? 1 : 0);
