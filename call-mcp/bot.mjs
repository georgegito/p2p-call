// A call participant with no screen: a headless browser opens the app and joins like
// anyone else. What the others say is cut into utterances and transcribed locally
// (whisper.cpp); what the bot says is synthesised locally (macOS `say`) and played into
// the page as its microphone. Nothing here talks to a cloud service.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

export const config = {
  whisper: env.CALL_MCP_WHISPER || 'whisper-cli',
  model: env.CALL_MCP_MODEL || join(HERE, 'models', 'ggml-small.bin'),
  lang: env.CALL_MCP_LANG || 'auto',          // e.g. "en" or "el"; "auto" guesses per utterance
  voice: env.CALL_MCP_VOICE || '',            // a `say -v` voice; empty = the system voice
  threshold: num(env.CALL_MCP_VAD_THRESHOLD, 0.015),   // loudness (0..1) that counts as speech
  endMs: num(env.CALL_MCP_VAD_END_MS, 900),   // this much quiet ends an utterance
  minVoicedMs: 250,                           // shorter than this is a click or a cough
  maxMs: 28000,                               // whisper works on 30 s windows
  followUpMs: num(env.CALL_MCP_FOLLOWUP_S, 12) * 1000,   // after the bot speaks, a reply needs no name for this long
  wakeWords: (env.CALL_MCP_WAKE_WORDS || '').split(',').map(w => w.trim()).filter(Boolean),
  headless: env.CALL_MCP_HEADFUL !== '1'
};

// How speech-to-text tends to spell "Claude".
const CLAUDE_SPELLINGS = ['claude', 'claud', 'clawd', 'klaud', 'klod', 'κλοντ', 'κλωντ'];
const escapeRe = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function wakePattern(name) {
  const words = new Set([name, ...name.split(/\s+/), ...config.wakeWords].map(w => w.toLowerCase()).filter(w => w.length >= 3));
  if ([...words].some(w => CLAUDE_SPELLINGS.includes(w))) for (const w of CLAUDE_SPELLINGS) words.add(w);
  return new RegExp(`(?<!\\p{L})(${[...words].map(escapeRe).join('|')})(?!\\p{L})`, 'iu');
}

const RATE = 16000;   // what whisper wants
const log = (...a) => console.error('[call-mcp]', ...a);   // stdout belongs to the MCP protocol

/* ------------------------------------------------------- inside the page */

// Runs before the app's own code. The app asks for camera + microphone; it gets a
// "microphone" that is really a Web Audio node the bot can play speech into, and no
// camera, so it takes its own sound-only path.
function pageInit() {
  const bot = (window.__callBot = { out: null, dest: null, taps: new Map(), nextId: 1, timer: 0 });
  if (!navigator.mediaDevices) return;
  navigator.mediaDevices.getUserMedia = async c => {
    if (c && c.video) throw new DOMException('No camera', 'NotFoundError');
    if (!bot.out) bot.out = new AudioContext();
    await bot.out.resume();
    bot.dest = bot.out.createMediaStreamDestination();
    return bot.dest.stream;
  };
}

// Taps every remote person's audio, resampled to 16 kHz mono, and hands it to Node in
// small chunks together with the name on their tile. Also reports who is in the call.
export function pageCapture() {
  const bot = window.__callBot;
  if (bot.timer) return;
  const ctx = (bot.in = new AudioContext({ sampleRate: 16000 }));
  ctx.resume();
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  const nameOf = tile => (tile.querySelector('.tag span') || {}).textContent || '';
  const drop = (v, tap) => {
    try { tap.src.disconnect(); tap.proc.disconnect(); } catch {}
    tap.proc.onaudioprocess = null;
    bot.taps.delete(v);
    window.__callGone(tap.id);
  };
  const scan = () => {
    const seen = new Set();
    const names = [];
    for (const tile of document.querySelectorAll('#grid .tile')) {
      const v = tile.querySelector('video');
      if (!v) continue;
      seen.add(v);
      const name = nameOf(tile);
      if (name) names.push(name);
      const stream = v.srcObject;
      const track = stream ? stream.getAudioTracks()[0] : null;
      let tap = bot.taps.get(v);
      if (tap && (tap.track !== track || track.readyState === 'ended')) { drop(v, tap); tap = null; }
      if (tap || !track || track.readyState === 'ended') continue;
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      const id = bot.nextId++;
      proc.onaudioprocess = e => {
        const f = e.inputBuffer.getChannelData(0);
        const bytes = new Uint8Array(f.length * 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < f.length; i++) view.setInt16(i * 2, Math.max(-1, Math.min(1, f[i])) * 32767, true);
        let s = '';
        for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
        window.__callAudio(id, nameOf(tile), btoa(s));
      };
      src.connect(proc);
      proc.connect(sink);
      bot.taps.set(v, { id, track, src, proc });
    }
    for (const [v, tap] of bot.taps) if (!seen.has(v)) drop(v, tap);
    window.__callRoster({ names, inCall: !document.getElementById('call').hidden });
  };
  bot.timer = setInterval(scan, 500);
  scan();
}

// Plays a WAV file into the bot's "microphone" and resolves when it has finished.
async function pagePlay(b64) {
  const bot = window.__callBot;
  if (!bot.dest) throw new Error('no microphone');
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const buf = await bot.out.decodeAudioData(bytes.buffer);
  await bot.out.resume();
  const src = bot.out.createBufferSource();
  src.buffer = buf;
  src.connect(bot.dest);
  bot.playing = src;
  await new Promise(res => { src.onended = res; src.start(); });
  if (bot.playing === src) bot.playing = null;
  return buf.duration;
}

function pageStopPlaying() {
  const bot = window.__callBot;
  if (bot.playing) { try { bot.playing.stop(); } catch {} }
}

/* --------------------------------------------------------------- helpers */

export function wav(chunks) {
  const data = Buffer.concat(chunks);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function loudness(buf) {
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2) / 32768; sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
}

// Whisper describes silence and noise as "[BLANK_AUDIO]", "(music)" and the like.
export const cleanTranscript = out => out.split('\n').map(l => l.trim()).filter(Boolean).join(' ')
  .replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ').replace(/\s+/g, ' ').trim();

export function checkSetup() {
  const problems = [];
  if (!existsSync(config.model)) problems.push(`Speech model not found at ${config.model}. Run "npm run setup" in call-mcp/.`);
  if (process.platform !== 'darwin') problems.push('Speaking uses the macOS "say" command, so this version only talks on a Mac.');
  return problems;
}

/* ------------------------------------------------------------------- bot */

export class CallBot {
  constructor() {
    this.browser = null;
    this.page = null;
    this.name = '';
    this.roster = [];
    this.inCall = false;
    this.voices = new Map();      // tap id -> utterance in progress
    this.heard = [];              // finished: { who, text, at } and { event, at }
    this.pending = 0;             // utterances being transcribed
    this.order = Promise.resolve();
    this.waiters = new Set();
    this.speech = Promise.resolve();
    this.tmp = '';
    this.wakeMode = true;         // only being addressed by name ends a listen
    this.wakeRe = /$^/;
    this.followUntil = 0;
  }

  get joined() { return !!this.page; }
  get someoneSpeaking() { return [...this.voices.values()].some(v => v.speaking); }
  wake() { for (const w of this.waiters) w(); }

  async join(link, name = 'Claude', wakeMode = true) {
    if (this.joined) throw new Error('Already in a call. Leave it first.');
    let url;
    try { url = new URL(link); } catch { throw new Error('That is not a link.'); }
    if (!/^https?:$/.test(url.protocol) || !url.hash.startsWith('#room=')) throw new Error('That is not a call invite link (it should contain "#room=").');
    const problems = checkSetup().filter(p => p.startsWith('Speech model'));
    if (problems.length) throw new Error(problems[0]);

    this.tmp = await mkdtemp(join(tmpdir(), 'call-mcp-'));
    this.browser = await chromium.launch({
      headless: config.headless,
      args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio']
    });
    try {
      const context = await this.browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      await page.addInitScript(pageInit);
      await page.exposeFunction('__callAudio', (id, who, b64) => this.onAudio(id, who, Buffer.from(b64, 'base64')));
      await page.exposeFunction('__callGone', id => this.onGone(id));
      await page.exposeFunction('__callRoster', r => this.onRoster(r));
      page.on('pageerror', e => log('page error:', e.message));
      page.on('dialog', d => d.dismiss().catch(() => {}));
      await page.goto(url.href, { waitUntil: 'load', timeout: 30000 });
      await page.locator('#lobby').waitFor({ state: 'visible', timeout: 15000 });
      await page.fill('#nameInput', String(name).slice(0, 30));
      await page.click('#joinBtn');
      await page.locator('#call').waitFor({ state: 'visible', timeout: 30000 });
      this.page = page;
      this.name = name;
      this.wakeMode = wakeMode;
      this.wakeRe = wakePattern(name);
      this.followUntil = 0;
      this.inCall = true;
      this.heard = [];
      this.roster = [];
      await page.evaluate(pageCapture);
      // Connecting to the others takes a few seconds; wait for them before reporting who is here.
      for (let i = 0; i < 16 && (i < 4 || !this.roster.length); i++) await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      await this.close();
      throw new Error(`Could not join: ${String(e.message).split('\n')[0]}`);
    }
    this.heard = this.heard.filter(h => !h.event);   // "joined" notes for people who were already here
    return this.roster.slice();
  }

  onRoster({ names, inCall }) {
    const before = this.roster.slice();
    const left = before.slice();
    const came = [];
    for (const n of names) { const i = left.indexOf(n); if (i >= 0) left.splice(i, 1); else came.push(n); }
    this.roster = names;
    for (const n of came) this.heard.push({ event: `${n} joined the call`, at: Date.now() });
    for (const n of left) this.heard.push({ event: `${n} left the call`, at: Date.now() });
    if (this.inCall && !inCall) { this.inCall = false; this.heard.push({ event: 'The call ended on this side (the page left the call)', at: Date.now(), wake: true }); }
    if (came.length || left.length || !inCall) this.wake();
  }

  /* ------------------------------------------------------------ hearing */

  onAudio(id, who, chunk) {
    let v = this.voices.get(id);
    if (!v) this.voices.set(id, (v = { who: '', pre: [], buf: [], speaking: false, quiet: 0, voiced: 0, total: 0 }));
    if (who) v.who = who;
    const ms = (chunk.length / 2 / RATE) * 1000;
    const loud = loudness(chunk) >= config.threshold;
    if (!v.speaking) {
      v.pre.push(chunk);
      if (v.pre.length > 3) v.pre.shift();   // keep a little lead-in so first syllables survive
      if (!loud) return;
      v.speaking = true; v.buf = v.pre; v.pre = []; v.quiet = 0; v.voiced = ms; v.total = v.buf.length * ms;
      return;
    }
    v.buf.push(chunk);
    v.total += ms;
    if (loud) { v.voiced += ms; v.quiet = 0; } else v.quiet += ms;
    if (v.quiet >= config.endMs || v.total >= config.maxMs) this.finish(v);
  }

  onGone(id) {
    const v = this.voices.get(id);
    if (v && v.speaking) this.finish(v);
    this.voices.delete(id);
  }

  finish(v) {
    const { buf, voiced, who, total } = v;
    v.speaking = false; v.buf = []; v.pre = []; v.quiet = 0; v.voiced = 0; v.total = 0;
    if (voiced < config.minVoicedMs) { this.wake(); return; }
    const at = Date.now();
    const isReply = at - total <= this.followUntil;   // started right after the bot spoke
    this.pending++;
    // One at a time, so what was said first is reported first.
    this.order = this.order.then(async () => {
      try {
        const text = await this.transcribe(buf);
        if (text) this.heard.push({ who: who || 'Someone', text, at, wake: isReply || this.wakeRe.test(text) });
      } catch (e) {
        log('transcription failed:', e.message);
        this.heard.push({ event: `Could not transcribe something ${who || 'someone'} said (${String(e.message).split('\n')[0]})`, at });
      } finally {
        this.pending--;
        this.wake();
      }
    });
  }

  async transcribe(chunks) {
    const file = join(this.tmp, `in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    await writeFile(file, wav(chunks));
    try {
      const { stdout } = await run(config.whisper, ['-m', config.model, '-f', file, '-l', config.lang, '-nt', '-np', '-sns', '--prompt', `${this.name}.`], { timeout: 120000, maxBuffer: 1 << 20 });
      return cleanTranscript(stdout);
    } finally {
      rm(file, { force: true }).catch(() => {});
    }
  }

  // Resolves with everything heard since the last call. Waits for someone to finish a
  // thought: while a person is still talking, or their words are still being
  // transcribed, it holds on a little longer rather than returning half a sentence.
  // In wake mode only something addressed to the bot (its name, or a reply right after
  // it spoke) ends the wait; other talk is kept and handed over then, as context.
  async listen(timeoutMs = 60000) {
    if (!this.joined) throw new Error('Not in a call.');
    const deadline = Date.now() + timeoutMs;
    const ready = () => (this.wakeMode ? this.heard.some(h => h.wake) : this.heard.length > 0);
    let firstAt = 0;
    for (;;) {
      const busy = this.someoneSpeaking || this.pending > 0;
      if (ready()) {
        firstAt ||= Date.now();
        if (!busy || Date.now() - firstAt > 10000) break;
      }
      const left = deadline - Date.now();
      if (left <= 0 && !(busy && ready())) break;
      if (!this.joined) break;
      await new Promise(res => {
        const done = () => { clearTimeout(t); this.waiters.delete(done); res(); };
        const t = setTimeout(done, Math.max(50, Math.min(left > 0 ? left : 500, 500)));
        this.waiters.add(done);
      });
    }
    if (!ready() && this.joined) {
      if (this.heard.length > 40) this.heard.splice(0, this.heard.length - 40);   // background talk: keep the recent part
      return [];
    }
    return this.heard.splice(0);
  }

  /* ----------------------------------------------------------- speaking */

  say(text) {
    if (!this.joined) throw new Error('Not in a call.');
    const job = this.speech.then(() => this.speak(text));
    this.speech = job.catch(() => {});
    return job;
  }

  async speak(text) {
    if (!this.joined) throw new Error('Not in a call.');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const txt = join(this.tmp, `out-${id}.txt`);
    const out = join(this.tmp, `out-${id}.wav`);
    await writeFile(txt, text);
    try {
      await run('say', [...(config.voice ? ['-v', config.voice] : []), '-f', txt, '-o', out, '--file-format=WAVE', '--data-format=LEI16@24000'], { timeout: 120000 });
      const b64 = (await readFile(out)).toString('base64');
      const seconds = await this.page.evaluate(pagePlay, b64);
      this.followUntil = Date.now() + config.followUpMs;
      return seconds;
    } finally {
      rm(txt, { force: true }).catch(() => {});
      rm(out, { force: true }).catch(() => {});
    }
  }

  async stopSpeaking() {
    if (this.joined) await this.page.evaluate(pageStopPlaying).catch(() => {});
  }

  /* ------------------------------------------------------------ leaving */

  async leave() {
    if (!this.joined) return false;
    try {
      // The Leave button says a proper goodbye, so the others see "left", not "reconnecting".
      if (this.inCall) { await this.page.click('#cLeave', { timeout: 3000 }); await new Promise(r => setTimeout(r, 800)); }
    } catch {}
    await this.close();
    return true;
  }

  async close() {
    const b = this.browser, tmp = this.tmp;
    this.browser = null; this.page = null; this.inCall = false; this.tmp = '';
    this.voices.clear(); this.roster = [];
    this.wake();
    if (b) await b.close().catch(() => {});
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
