/**
 * RSE Energy Group - Receptionist Script
 * All prompts, responses, and conversation content
 * 
 * Edit this file to adjust script without touching stream logic.
 */

// ============================================================================
// GREETING
// ============================================================================
const GREETING = {
  primary: "Hi, thanks for calling RSE Energy Group. This is Ava. How can I help you today?",
  silence_fallback: "Hi, I can help with service, estimates, generators, or memberships. What are you calling about?"
};

// ============================================================================
// INTENT CLASSIFICATION PROMPTS
// ============================================================================
const INTENT_PROMPTS = {
  service_or_problem: "Okay. Is this for HVAC service, heating, air conditioning, or a generator?",
  estimate_or_new: "Got it. Is this for a new installation or an upgrade?",
  membership: "Okay. Are you calling about our Home Comfort Plans or maintenance memberships?",
  existing_project: "Alright. Is this about a current job in progress?",
  unclear: "No problem. Can you tell me a little more about what's going on?"
};

// ============================================================================
// SAFETY CHECK (hvac_service or generator only)
// ============================================================================
const SAFETY = {
  check: "Before we go further, is there anything unsafe right now? Smoke, gas smell, sparks, or a total system shutdown?",
  emergency_response: "I'm glad you called. For safety, please hang up and call 911 or your utility provider right away.",
  all_clear: "Okay, thank you."
};

// ============================================================================
// BASIC CALLER INFO
// ============================================================================
const CALLER_INFO = {
  name: "Can I get your first and last name?",
  phone: "What's the best phone number to reach you?",
  email: {
    primary: "And what's the best email for updates or confirmations?",
    optional: "That's optional. Phone is totally fine."
  }
};

// ============================================================================
// DETAILS BRANCH QUESTIONS
// ============================================================================
const DETAILS = {
  hvac_service: {
    system_type: "What type of system is it? Furnace, boiler, central air, mini split, or rooftop unit?",
    age: "About how old is the system, if you know?",
    symptoms: "What symptoms are you noticing? No heat, no cooling, noise, leak, high bill?",
    start_time: "When did this start?",
    severity: "Is the system completely out, or still running but not working well?"
  },
  generator: {
    existing_or_new: "Is this for an existing generator or a new installation?",
    existing_issue: "What's the issue you're seeing?",
    new_type: "Is this residential or commercial?",
    new_brand: "Do you already have a generator brand in mind, like Cummins, or are you just exploring options?"
  },
  membership: {
    frequency: "Are you looking for monthly or yearly coverage?",
    systems: "How many systems does the property have?",
    pricing: "Our plans start around thirty dollars per month for one system. I can take your info and note what you're looking for."
  },
  existing_project: {
    site: "Which site is this for?",
    contact: "Who have you been working with at RSE?",
    help: "What do you need help with today?"
  },
  other: {
    clarify: "Can you tell me a bit more about what you need help with?"
  }
};

// ============================================================================
// ADDRESS
// ============================================================================
const ADDRESS = {
  ask: "Can I get the service address?"
};

// ============================================================================
// CONFIRMATION
// ============================================================================
const CONFIRMATION = {
  intro: "Alright, let me read that back.",
  verify: "Does that all sound correct?",
  updated: "Got it, I've updated that. Let me read it back one more time."
};

// ============================================================================
// CLOSE
// ============================================================================
const CLOSE = {
  anything_else: "Is there anything else I can help with today?",
  goodbye: "Alright. Thanks for calling RSE Energy Group. Have a great day."
};

// ============================================================================
// SCHEDULING / NEUTRAL RESPONSES
// ============================================================================
const NEUTRAL = {
  scheduling: "I can take your info and note your request.",
  clarify: "I didn't quite catch that. Could you say it one more time?",
  ramble_redirect: "Okay, I got the gist. Let me get your information so we can help you out."
};

// ============================================================================
// MICRO-RESPONSES (for backchanneling)
// ============================================================================
const MICRO_RESPONSES = {
  general: [
    "Okay.",
    "Got it.",
    "One second.",
    "Thanks."
  ],
  after_capture: [
    "Perfect.",
    "Thank you."
  ],
  before_confirmation: [
    "Alright, let me read that back."
  ]
};

// ============================================================================
// INTENT TYPES
// ============================================================================
const INTENT_TYPES = {
  HVAC_SERVICE: 'hvac_service',
  GENERATOR: 'generator',
  MEMBERSHIP: 'membership',
  EXISTING_PROJECT: 'existing_project',
  OTHER: 'other'
};

// ============================================================================
// STATE NAMES
// ============================================================================
const STATES = {
  GREETING: 'greeting',
  INTENT: 'intent',
  SAFETY_CHECK: 'safety_check',
  NAME: 'name',
  PHONE: 'phone',
  EMAIL: 'email',
  DETAILS_BRANCH: 'details_branch',
  ADDRESS: 'address',
  CONFIRMATION: 'confirmation',
  CLOSE: 'close',
  ENDED: 'ended'
};

// ============================================================================
// SYSTEM PROMPT FOR OPENAI REALTIME
// ============================================================================
const SYSTEM_PROMPT = `You are Ava, a friendly and professional receptionist for RSE Energy Group, an HVAC and generator company.

PERSONALITY:
- Warm, calm, and genuinely helpful
- Professional but not stiff - sound like a real person
- Use natural speech patterns with occasional "okay", "alright", "got it"
- Keep responses SHORT - one or two sentences maximum
- Never sound scripted or robotic

CONVERSATION RULES:
- Ask ONE question at a time
- Use light acknowledgements sparingly
- Confirm key details back before ending
- No promises about scheduling or callbacks
- If caller asks about scheduling, say: "I can take your info and note your request."
- If uncertain, ask a clarifying question - never guess
- If caller rambles, summarize briefly then ask next question
- Never pressure, upsell, or sound salesy

SERVICES RSE OFFERS:
- HVAC service and repair (furnaces, boilers, AC, mini splits, rooftop units)
- Generator sales, installation, and service (residential and commercial)
- Home Comfort Plans / maintenance memberships (starting around $30/month per system)
- New installations and upgrades

SAFETY PROTOCOL:
For service calls, always check for emergencies first:
- If caller mentions smoke, gas smell, sparks, or total shutdown → direct them to call 911 or utility provider
- For non-emergencies, proceed with normal intake

WHAT TO COLLECT:
1. Intent/reason for calling
2. Name (first and last)
3. Phone number
4. Email (optional)
5. Relevant details based on intent
6. Service address
7. Confirm all info before ending

Remember: You're here to help and gather information efficiently. Be human, be brief, be helpful.`;

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  GREETING,
  INTENT_PROMPTS,
  SAFETY,
  CALLER_INFO,
  DETAILS,
  ADDRESS,
  CONFIRMATION,
  CLOSE,
  NEUTRAL,
  MICRO_RESPONSES,
  INTENT_TYPES,
  STATES,
  SYSTEM_PROMPT
};

