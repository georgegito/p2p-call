// One-time setup: checks the speech tools and downloads the speech-to-text model.
//   node setup.mjs            the default model (small, about 470 MB, many languages)
//   node setup.mjs base       a smaller, faster, less accurate one (about 140 MB)

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const size = process.argv[2] || 'small';
if (!/^[\w.-]+$/.test(size)) throw new Error(`Bad model name: ${size}`);
const file = join(HERE, 'models', `ggml-${size}.bin`);
let ok = true;

try { execFileSync(process.env.CALL_MCP_WHISPER || 'whisper-cli', ['--help'], { stdio: 'ignore' }); console.log('ok  whisper-cli'); }
catch { ok = false; console.log('MISSING  whisper-cli. Install it with: brew install whisper-cpp'); }

try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); console.log('ok  say'); }
catch { ok = false; console.log('MISSING  say (macOS text-to-speech). Speaking only works on a Mac in this version.'); }

try { execFileSync('npx', ['playwright', 'install', 'chromium'], { cwd: HERE, stdio: 'inherit' }); console.log('ok  browser'); }
catch { ok = false; console.log('MISSING  browser. Run: npx playwright install chromium'); }

if (existsSync(file)) console.log(`ok  model ${file}`);
else {
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${size}.bin`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  mkdirSync(dirname(file), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file + '.part'));
  renameSync(file + '.part', file);
  console.log(`ok  model ${file}`);
}
if (size !== 'small') console.log(`To use this model, set CALL_MCP_MODEL=${file}`);
process.exit(ok ? 0 : 1);
