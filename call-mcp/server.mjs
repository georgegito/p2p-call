#!/usr/bin/env node
// MCP server: lets an assistant join a call as a participant.
//   join_call(link, name)  open the invite link and join, sound only
//   listen(timeout_s)      wait until someone has said something; returns the transcript
//   say(text)              speak into the call
//   call_status()          who is here
//   leave_call()           hang up

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CallBot, checkSetup } from './bot.mjs';

const bot = new CallBot();
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
const safely = fn => async args => {
  try { return await fn(args); } catch (e) { return text(e.message || String(e), true); }
};
const people = names => (names.length ? names.join(', ') : 'nobody else yet');

function transcript(items) {
  const now = Date.now();
  return items.map(h => {
    const age = Math.round((now - h.at) / 1000);
    const when = age >= 20 ? ` (${age}s ago)` : '';
    return h.event ? `* ${h.event}${when}` : `${bot.wakeMode && h.wake ? '→ ' : ''}${h.who}${when}: ${h.text}`;
  }).join('\n');
}

const server = new McpServer({ name: 'call', version: '0.1.0' }, {
  instructions: [
    'Lets you take part in a voice call. You hear through speech-to-text and talk through text-to-speech.',
    'After join_call, stay in a loop: listen, then say your reply, then listen again. You only hear what is said while you are in the call, and it is queued until your next listen.',
    'Speak like a person on a call: one to three short sentences, plain words, no markdown, lists, code or URLs (they are read aloud literally).',
    'Transcripts are machine-made and can be wrong, especially names and short words. If something makes no sense, ask the person to repeat it.',
    'By default listen only returns when someone addresses you: they say your name, or reply within a few seconds of you speaking. Those lines are marked with "→"; unmarked lines are other conversation given as context, not requests to you. Answer what was addressed to you.',
    'When listen reports that nobody addressed you, call listen again and stay quiet. Leave when asked to, or when everyone else has left.'
  ].join(' ')
});

server.registerTool('join_call', {
  title: 'Join a call',
  description: 'Join a call from its invite link (a URL containing "#room=...&key=..."). You join with sound only, no camera. Returns who is already there.',
  inputSchema: {
    link: z.string().describe('The invite link, exactly as it was shared.'),
    name: z.string().min(3).max(30).optional().describe('The name the others see, and the word that gets your attention. Defaults to "Claude".'),
    only_when_addressed: z.boolean().optional().describe('Default true: listen returns only when someone says your name or replies right after you spoke. Set false to hear everything as it is said (good for a one-to-one call).')
  }
}, safely(async ({ link, name, only_when_addressed }) => {
  const here = await bot.join(link, name || 'Claude', only_when_addressed !== false);
  const notes = checkSetup();
  return text(`Joined as "${name || 'Claude'}". In the call: ${people(here)}.` +
    (notes.length ? `\nNote: ${notes.join(' ')}` : '') +
    (bot.wakeMode ? `\nlisten will return when someone says "${name || 'Claude'}" or replies right after you speak.` : '\nlisten will return whatever anyone says.') +
    '\nNow call listen.');
}));

server.registerTool('listen', {
  title: 'Listen to the call',
  description: 'Wait until someone in the call has finished saying something to you, then return what was said since your last listen, as "Name: words" lines (plus notes when people join or leave). Lines addressed to you start with "→". Returns "(nobody addressed you)" or "(silence)" when the timeout passes; just call it again.',
  inputSchema: {
    timeout_s: z.number().min(1).max(600).optional().describe('How long to wait for speech, in seconds. Default 60.')
  }
}, safely(async ({ timeout_s }) => {
  const items = await bot.listen((timeout_s || 60) * 1000);
  if (!bot.joined) return text((items.length ? transcript(items) + '\n' : '') + 'The call has been closed.');
  return text(items.length ? transcript(items) : bot.heard.length ? '(nobody addressed you)' : '(silence)');
}));

server.registerTool('say', {
  title: 'Speak in the call',
  description: 'Say something out loud in the call. Returns once it has been spoken. Keep it short and conversational; everything is read aloud literally. While you speak, others may talk too; you will get that from the next listen.',
  inputSchema: {
    text: z.string().min(1).max(2000).describe('What to say, as plain spoken sentences.')
  }
}, safely(async ({ text: words }) => {
  const seconds = await bot.say(words);
  return text(`Said (${seconds.toFixed(1)}s).`);
}));

server.registerTool('call_status', {
  title: 'Who is in the call',
  description: 'Report whether you are in a call, who else is there, and whether someone is speaking right now.',
  inputSchema: {}
}, safely(async () => {
  if (!bot.joined) return text('Not in a call.');
  return text(`In the call as "${bot.name}"${bot.inCall ? '' : ' (the page has left the call)'}. Others: ${people(bot.roster)}. ` +
    `${bot.someoneSpeaking ? 'Someone is speaking right now.' : 'Nobody is speaking right now.'} Unheard items waiting: ${bot.heard.length}.`);
}));

server.registerTool('leave_call', {
  title: 'Leave the call',
  description: 'Hang up and close the call.',
  inputSchema: {}
}, safely(async () => text((await bot.leave()) ? 'Left the call.' : 'Not in a call.')));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await bot.leave().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
