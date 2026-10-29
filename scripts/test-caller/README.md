# Test caller: a bot that calls Ava

Repeatable test calls for tuning Ava's turn-taking (dead air, barge-in) and
checking intake, without dialling in by hand. A scripted caller (an OpenAI
Realtime session playing "Maria Lopez, no heat since this morning") talks to
Ava over the same 8 kHz mu-law stream Twilio would carry, and every run leaves
a transcript, a recording, a latency table and a pass/fail check of what Ava
captured.

Nothing under `src/` changes; Ava behaves exactly as in production.

## Pieces

| file | role |
|------|------|
| `run.js` | wires everything together, writes the outputs, exits 0/1/2 |
| `fake-twilio.js` | local mode: WebSocket client that speaks Twilio's media-stream protocol to Ava's `/stream` (`connected`, `start`, 20 ms `media`, `mark`, `dtmf`, `stop`; honours `clear`, echoes marks after a real-time playout buffer) |
| `phone-leg.js` | phone mode: places a real outbound Twilio call to Ava's number and takes the caller leg back over `<Connect><Stream>` |
| `persona.js` | the caller: a `gpt-realtime` session with PCMU in/out, server VAD, and an out-of-band clip synthesiser for interjections ("mm-hm") |
| `audio.js` | frame inspection and WAV writing, decoding with `src/g711.js` |
| `report.js` | reads Ava's intake from her log (or the Neon row), checks it, renders the transcript and latency table |
| `scenarios/*.json` | who is calling, what they want, what Ava should end up with |

## Running locally

Terminal 1, Ava:

```bash
npm run rse:dev
```

Terminal 2, the caller:

```bash
node scripts/test-caller/run.js --scenario no-heat
```

That connects to `ws://localhost:$PORT/stream` (default 8080; `--host ws://localhost:3000` to override). With Ava started by hand the harness cannot read her log, so it looks for the call's Neon row when `DATABASE_URL` is set, or else infers the outcome from what the caller heard and skips the field checks. For the full check, either point it at Ava's log:

```bash
npm run rse:dev 2>&1 | tee ava.log
node scripts/test-caller/run.js --scenario no-heat --server-log ava.log
```

or let the harness start Ava itself on a free port, capture her log and stop her afterwards:

```bash
node scripts/test-caller/run.js --scenario no-heat --spawn
```

`--spawn` strips the Google Sheets, SendGrid and Twilio variables from Ava's
environment so test calls never land in the real Sheet or email the office
(`--keep-side-effects` keeps them). Ava's `/twilio/voice` webhook is not
involved in local mode, so the Twilio signature check is never exercised here.

Scenarios: `no-heat`, `generator-install`, `membership-pricing`,
`solar-out-of-scope`, `asks-for-person`. Run them all:

```bash
for s in no-heat generator-install membership-pricing solar-out-of-scope asks-for-person; do node scripts/test-caller/run.js --scenario $s --spawn || echo "FAILED: $s"; done
```

## Output

Each run writes `scripts/test-caller/out/<timestamp>-<scenario>/` (gitignored):

- `transcript.txt`: two columns with timestamps, caller left, Ava right, with
  barge-in (`clear`) and interjection events inline; `transcript.json` is the same data.
- `call.wav`: both sides mixed, 8 kHz mono; `call-stereo.wav`: caller left, Ava right.
- `latency.md`: per caller turn, time from the end of the caller's speech to
  Ava's first audio frame (and first audible frame), p50/p90/max, how often
  Ava talked over the caller, dead-air gaps of 3 s or more, how many times
  Ava cleared playback.
- `events.jsonl`: the raw timeline (speech starts/ends, VAD, clears, interjections).
- `report.json`: everything above plus the intake Ava captured and the check result.
- `server.log`: Ava's own log, when spawned.

Exit code 0 when the expected outcome was reached and every required field
matched; 1 when a required field is wrong or the call never reached the
expected state (confirmation, out-of-scope close, or transfer); 2 when the
harness itself failed (no server, bad key, no tunnel).

## Scenarios

```json
{
  "name": "no-heat",
  "callerNumber": "+19735550142",
  "persona": { "voice": "ash", "silenceMs": 700, "interruptible": false, "instructions": "You are Maria Lopez, ..." },
  "interjections": [ { "text": "mm-hm", "onAvaUtterance": 2, "afterMs": 1500 } ],
  "maxCallSeconds": 240,
  "expect": {
    "outcome": "confirmation",
    "fields": { "intent": "hvac_service", "firstName": "Maria", "phone": "9735550142", "address": "14 Elm" },
    "required": ["intent", "firstName", "lastName", "phone", "address"]
  }
}
```

- `persona.silenceMs` is how long the caller waits after Ava stops before answering.
- `persona.interruptible` lets Ava cut the caller off mid-sentence (the Realtime
  `interrupt_response` flag); off by default so the caller finishes what they say.
- `interjections` make the caller say a clip while Ava is still talking: the
  Nth Ava utterance, after so many ms. Use it to test barge-in handling.
- `expect.fields` are compared loosely: phone by last ten digits, email exactly,
  everything else as a case-insensitive substring of what Ava stored.
  Only `required` fields fail the run; the rest warn.

## Phone mode (real PSTN call)

```bash
ngrok http 3100
TEST_CALLER_PUBLIC_URL=https://xxxx.ngrok.app node scripts/test-caller/run.js --scenario no-heat --mode phone
```

The harness calls Ava's number (`TWILIO_NUMBER`, or `TEST_CALLER_TO`) from the
first number in `TEST_CALLER_NUMBERS` (or `TEST_CALLER_FROM`), which must be a
Twilio number on the account, so the call is flagged as a test downstream.
Twilio connects the caller leg to this script's WebSocket server on
`TEST_CALLER_PORT` (default 3100) through the public URL, and the whole
carrier path is exercised, including Ava's webhook signature check. Ava's
`clear` messages are not visible on this side (Twilio consumes them), so
barge-in shows up only as her audio stopping.

**Never run phone mode from GitHub Actions.** Twilio has locked the account
twice for API calls made from Actions runners. `phone-leg.js` refuses to start
when `GITHUB_ACTIONS` is set; keep it that way.

## Cost per run

Two Realtime sessions (Ava's and the caller's) for a 2 to 4 minute call, plus
transcription on both sides. At the published `gpt-realtime` audio rates this is
roughly $0.50 to $1.50 per local run; check the OpenAI usage page after the
first few runs and adjust. Phone mode adds Twilio: an outbound leg plus Ava's
inbound leg and two media streams, a few cents per minute. Nothing else is
billed; no new services are involved.

## Reading the numbers

`latency.md` is the before/after instrument for turn-taking work. The
interesting columns are "first frame" (Ava's pacing loop started sending real
audio) and "first audible" (the caller could actually hear something), the
"Ava started before caller finished" flags (Ava talking over the caller), the
dead-air gaps, and the clear count (Ava cut herself off because she heard the
caller). The caller side has its own VAD delay (`silenceMs`, default 700 ms),
so compare runs with the same scenario settings.
