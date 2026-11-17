# call-mcp

An MCP server that lets Claude join a call as a participant, hear what is said and talk back.

It is separate from the app: the site stays a static page with no server. This is a local
program that opens the app in a headless browser and joins a room like anyone else.

```
you ── call ──▶ headless browser ──▶ voice detection ──▶ whisper.cpp ──▶ text ──▶ Claude
you ◀── call ── headless browser ◀── macOS `say` ◀───────────────────── text ◀── Claude
```

Speech-to-text and text-to-speech both run on this machine. Call audio is not sent to
any service; only the transcript reaches Claude.

## Setup (once)

```sh
brew install whisper-cpp
cd call-mcp
npm install
npm run setup        # checks the tools, downloads the browser and the speech model (~470 MB)
```

The repo's `.mcp.json` registers the server for Claude Code as `call`. Restart Claude Code
in this repo and approve the server when asked.

## Use

Join a call yourself, copy its invite link, and tell Claude:

> Join this call and talk with me: https://…/#room=…&key=…

Claude then loops over these tools:

| Tool | What it does |
| --- | --- |
| `join_call(link, name?, only_when_addressed?)` | Opens the invite link and joins with sound only. |
| `listen(timeout_s?)` | Waits until someone addresses Claude; returns `Name: words` lines (addressed ones marked `→`) and join/leave notes. |
| `say(text)` | Speaks the text into the call; returns when done. |
| `call_status()` | Who is there, and whether someone is speaking. |
| `leave_call()` | Hangs up. |

## Getting Claude's attention

By default Claude only reacts when it is addressed, so a group conversation is not
interrupted by replies to everything:

- Say its name ("Claude, what do you think?"). The name can be anywhere in the sentence.
- For about 12 seconds after Claude speaks, a reply needs no name, so follow-ups feel natural.
- Everything else is still transcribed and handed to Claude as context the next time it is addressed.

For a one-to-one call where Claude should answer everything, ask it to join with
`only_when_addressed: false`.

## Models

- Speech-to-text: OpenAI's Whisper, `small` multilingual model (about 470 MB), run locally by
  whisper.cpp. A short sentence takes well under a second on an Apple Silicon Mac.
- Text-to-speech: the voices built into macOS, through the `say` command.

## What to expect

- It is turn-based: expect a pause of a few seconds between you finishing and Claude answering.
- Claude hears you only while it keeps calling `listen`. What is said in between is queued.
- An utterance ends after about a second of quiet, so pause when you are done.
- Transcripts can be wrong, more so with several people talking at once.
- Use headphones if Claude seems to hear itself through your speakers.

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CALL_MCP_LANG` | `auto` | Spoken language, e.g. `en` or `el`. Setting it is faster and more accurate than `auto`. |
| `CALL_MCP_VOICE` | system voice | A `say -v` voice (list them with `say -v '?'`). Pick one that matches the language. |
| `CALL_MCP_MODEL` | `models/ggml-small.bin` | Path to a whisper.cpp model. |
| `CALL_MCP_WHISPER` | `whisper-cli` | The whisper.cpp program. |
| `CALL_MCP_WAKE_WORDS` | none | Extra comma-separated words that count as the name, e.g. a spelling the transcript keeps producing. |
| `CALL_MCP_FOLLOWUP_S` | `12` | Seconds after Claude speaks during which a reply needs no name. `0` turns this off. |
| `CALL_MCP_VAD_THRESHOLD` | `0.015` | Loudness that counts as speech. Raise it if noise triggers transcripts. |
| `CALL_MCP_VAD_END_MS` | `900` | Quiet time that ends an utterance. |
| `CALL_MCP_HEADFUL` | unset | `1` shows the browser window, for debugging. |

Set them in `.mcp.json` under `"env"`.

## Test

```sh
npm test
```

Runs fully on this machine: a browser whose microphone plays a recorded question joins a
room on the local test site, the MCP server joins it, and the test passes when the bot's
transcript contains the question and the "human" side hears the bot's spoken answer.
It needs `npm ci` in the repo root (for the local test site and relay) and `ffmpeg`.
