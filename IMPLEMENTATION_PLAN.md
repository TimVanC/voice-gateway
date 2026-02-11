# Implementation Plan: Alignment with cursor-rules.md

**Source of truth:** `cursor-rules.md`  
**Principle:** This system is deterministic, not conversational. The rules file wins over any conflicting implementation.

---

## 1. State Machine Implementation Plan

### 1.1 Mapping: cursor-rules.md → Code

| Rule state              | Code state(s)                    | Notes |
|-------------------------|-----------------------------------|-------|
| `greeting`              | `STATES.GREETING`                 | Entry point. |
| `collecting_name`       | `STATES.INTENT` → `SAFETY_CHECK` → `STATES.NAME` | Intent + safety then name; required field. |
| `collecting_phone`      | `STATES.PHONE`                    | Required. |
| `collecting_email`      | `STATES.EMAIL`                    | Optional field. |
| `collecting_address`    | `STATES.DETAILS_BRANCH` → `STATES.ADDRESS` | Details then address; required. |
| `collecting_issue`      | Inlined in `DETAILS_BRANCH` / intent | Situation summary. |
| `collecting_availability` | `STATES.AVAILABILITY`           | Required. |
| `recap`                 | `STATES.CONFIRMATION`             | Read-back only; no parsing. |
| `anything_else`         | `STATES.CLOSE`                   | "Is there anything else?" |
| `closing`               | `STATES.ENDED`                   | Goodbye played once. |
| `completed`             | `_callCompleted === true`        | Terminal; no logic runs after. |

### 1.2 Enforcement

- **Explicit linear transitions:** All transitions go through `transitionTo()` in `call-state-machine.js`; no arbitrary jumps.
- **Required fields cannot be skipped:** `hasRequiredName()` gates CONFIRMATION and CLOSE; availability/phone/address are required before recap.
- **A state cannot re-enter once completed:** When `_nameLocked`, `_phoneLocked`, etc., we do not overwrite; we advance. `_callCompleted` prevents any further TTS or state logic.
- **completed is terminal:** After `STATES.ENDED` and goodbye TTS, we set `_callCompleted`; server ignores further input and only hangs up after TTS + buffer.

**Implementation:** State machine in `src/state/call-state-machine.js` and terminal/guard logic in `src/server-rse.js` already enforce the above. No re-entry of completed states; required-field gating is in place.

---

## 2. Field Locking Implementation Plan

### 2.1 Rule: value, confirmed, locked

Each field must have:

- **value** — The stored value (e.g. `data.firstName`, `data.phone`).
- **confirmed** — User confirmed (e.g. "yes" or spelled and accepted). Implemented as `_nameComplete`, `_phoneLocked` (locked implies confirmed), etc.
- **locked** — Immutable. Implemented as `_nameLocked`, `_phoneLocked`, `_availabilityLocked`, etc.

### 2.2 Rules

- **Once confirmed → locked:** On confirmation we set both the completion flag and the locked flag in the same transition (e.g. CONFIRMATION "yes" → `_nameLocked = true`).
- **Locked fields cannot be modified or appended:** All write paths check `_*Locked` and skip parsing or overwrite; no append logic on locked fields.
- **Corrections overwrite:** When user corrects, we replace the value and then lock (e.g. availability correction replaces `data.availability` then sets `_availabilityLocked`).
- **Parsing disabled during recap and closing:** In CONFIRMATION and CLOSE/ENDED we do not parse transcript for field updates; recap is read-only from locked fields.

**Implementation:** `call-state-machine.js` uses `_*Locked` and `_*Complete`; parsing is disabled in CONFIRMATION (recap) and CLOSE/ENDED. Corrections overwrite via `extract*` then set locked.

---

## 3. TTS Lifecycle Enforcement Plan

### 3.1 Rules (cursor-rules.md §4)

- When TTS is active, no state transitions are allowed.
- Do not listen while speaking (no processing of user input for state change while TTS active).
- Only transition after TTS complete event fires.
- Hangup only after final TTS completes plus a short delay.
- Mid-sentence cutoffs are not allowed.

### 3.2 Implementation

- **tts_active flag:** Set `true` on `response.created`; set `false` when playBuffer empties and `response.audio.done` received (in media pump).
- **No state transitions while tts_active:** Transcript handling and `processUserInput` queue input when `tts_active`; processing runs only after buffer empty (tts_active cleared).
- **Silence timeouts:** Silence recovery and global silence monitor do not run when `tts_active`.
- **Barge-in / cancel:** When state is ENDED or `_callCompleted`, we do not cancel or clear buffer (goodbye plays to completion).
- **Hangup:** After goodbye TTS, we wait for buffer to empty then `GOODBYE_BUFFER_MS` before disconnect.

**Implementation:** `src/server-rse.js` implements the above. No incremental patches; architecture already aligned.

---

## 4. Model Isolation Confirmation

### 4.1 Rules (cursor-rules.md §6)

- Each call must instantiate a fresh model session.
- Not reuse conversation memory.
- Not share buffers between calls.
- Hard locked to English; reject unrelated output; discard/regenerate off-domain content.

### 4.2 Implementation

- **Per-call session:** Each Twilio call creates a new WebSocket to OpenAI Realtime in `server-rse.js`; `connectToOpenAI()` is called per call. No shared `openaiWs` across calls (each call handler has its own closure with its own `openaiWs`, `playBuffer`, `stateMachine`).
- **No shared buffers:** `playBuffer`, `pendingUserInput`, and state machine `data` are in the per-request closure, not global.
- **English / domain:** System prompt and script constrain to intake only; off-script detection (e.g. hallucination) discards bad TTS and retries. No cross-call conversation memory.

**Confirmation:** Model session and buffers are isolated per call. Architecture complies with rule §6.

---

## 5. Spelling Mode (§3) and Negative Intent (§5)

- **Spelling mode:** Implemented in `call-state-machine.js`: `parseSpelledLettersOnly()` accepts only A–Z and "space"; spelling mode path forces confirm, lock, advance; no language model interpretation during spelling.
- **Negative intent:** When state is CLOSE (anything_else) and `isNegativeResponse()` (no, nope, nothing else, that's all, etc.), we transition to ENDED, play goodbye once, then complete and hang up. No silence after negative response.

---

## 6. Summary Construction (§7)

- Call summary (CSV/recap) is built from structured fields only (`data.firstName`, `data.lastName`, `data.phone`, etc.) and locked fields. We do not summarize from raw transcript slices. Urgency and system types are taken from structured details.

---

## 7. Conflict Resolution

If any current implementation conflicts with `cursor-rules.md`, the rules file wins. This plan documents the alignment; future changes must not violate the rules.

---

## 8. No Incremental Patches

Architecture is aligned first:

- State machine: linear transitions, required fields, terminal completed — **enforced**.
- Field lifecycle: value/confirmed/locked, no parse in recap/closing — **enforced**.
- TTS lifecycle: tts_active gate, no transition until TTS complete, hangup after final TTS + delay — **enforced**.
- Model isolation: per-call session and buffers — **confirmed**.

Further fixes must stay within these constraints.
