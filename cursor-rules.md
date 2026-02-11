AI Receptionist System Rules

This file defines non negotiable architectural constraints.
All code must comply.

1. Call State Machine

Valid states:

greeting

collecting_name

collecting_phone

collecting_email

collecting_address

collecting_issue

collecting_availability

recap

anything_else

closing

completed

Rules:

State transitions must be explicit and linear.

Required fields cannot be skipped.

A state cannot re-enter once completed.

completed is terminal. No logic runs after this state.

2. Field Lifecycle

Each field must contain:

value

confirmed (boolean)

locked (boolean)

Rules:

Once confirmed is true, locked must immediately be set to true.

Locked fields cannot be modified or appended to.

Corrections overwrite the value. They never append.

Parsing must be disabled during recap and closing states.

3. Spelling Mode

When letter by letter spelling is detected:

Enter spelling_mode.

Accept only tokens A through Z and the word "space".

Ignore all other tokens.

Assemble string deterministically.

Force confirm.

Lock field.

Exit spelling_mode.

No language model interpretation allowed during spelling mode.

4. TTS Lifecycle

When TTS is active, no state transitions are allowed.

Do not listen while speaking.

Only transition after TTS complete event fires.

Hangup only after final TTS completes plus a short delay.

Mid sentence cutoffs are not allowed.

5. Negative Intent Routing

If state == anything_else and user expresses:

no

nope

nothing else

that’s all

Then:

Transition immediately to closing.

Play closing message once.

Transition to completed.

Hang up.

Silence after negative response is not allowed.

6. Model Isolation

Each call must:

Instantiate a fresh model session.

Not reuse conversation memory.

Not share buffers between calls.

Be hard locked to English.

Reject unrelated output.

Discard and regenerate any off domain content.

7. Summary Construction

Call summary must be built from structured fields only.

Never summarize from transcript slices.

Include all detected system types.

Include urgency if mentioned.

Why this matters.

You are building a deterministic intake system, not a chatbot.
Autonomous behavior must be constrained.