/**
 * RSE Energy Group - Receptionist Script
 * All prompts, responses, and conversation content
 * 
 * INTAKE ONLY - No scheduling, booking, or calendar logic.
 * AI collects info and situation details. Human reviews later.
 * 
 * STRICT SERVICE CONSTRAINTS - Only HVAC, Generators, Memberships, Projects
 */

// ============================================================================
// GREETING
// ============================================================================
const GREETING = {
  primary: "Hi, thanks for calling RSE Energy Group. This is Ava. How can I help you today?",
  silence_fallback: "Hi, I can help with HVAC, generators, or maintenance memberships. What are you calling about?"
};

// ============================================================================
// INTENT CLASSIFICATION PROMPTS
// ============================================================================
const INTENT_PROMPTS = {
  service_or_problem: "Is this for HVAC service, heating, air conditioning, or a generator?",
  estimate_or_new: "Is this for a new HVAC installation or an upgrade?",
  membership: "Are you calling about our Home Comfort Plans or maintenance memberships?",
  existing_project: "Is this about a current job in progress with RSE?",
  unclear: "Is this about HVAC, generators, or a maintenance plan?",
  out_of_scope: "We don't handle that service, but I can help with HVAC, generators, or maintenance if that helps."
};

// ============================================================================
// SAFETY CHECK (hvac_service or generator only)
// ============================================================================
const SAFETY = {
  check: "Before we go further, is there anything unsafe right now? Smoke, gas smell, sparks, or a total system shutdown?",
  emergency_response: "I'm glad you called. For safety, please hang up and call 911 or your utility provider right away.",
  all_clear: "Thank you."
};

// ============================================================================
// BASIC CALLER INFO
// ============================================================================
const CALLER_INFO = {
  name: "Can I get your first and last name?",
  phone: "What's the best phone number to reach you?",
  email: {
    primary: "And what's the best email for updates?",
    optional: "That's optional. Phone is fine."
  }
};

// ============================================================================
// DETAILS BRANCH QUESTIONS
// ============================================================================
const DETAILS = {
  hvac_service: {
    system_type: "What type of system is it? Furnace, boiler, central air, mini split, or rooftop unit?",
    symptoms: "What symptoms are you noticing?",
    start_time: "When did this start?",
    severity: "Is the system completely out, or still running but not working well?"
  },
  hvac_installation: {
    project_type: "Is this a new installation or replacing an existing system?",
    system_type: "What type of system? Furnace, AC, heat pump, or mini split?",
    property_type: "Is this residential or commercial?"
  },
  generator: {
    existing_or_new: "Is this for an existing generator or a new installation?",
    existing_issue: "What's the issue you're seeing?",
    new_type: "Is this residential or commercial?",
    new_brand: "Do you have a brand in mind, or are you exploring options?"
  },
  membership: {
    frequency: "Are you looking for monthly or yearly coverage?",
    systems: "How many systems or properties do you want covered?",
    inclusions: "A team member can confirm all the details. Let me get your info so they can follow up."
  },
  existing_project: {
    site: "Which site is this for?",
    contact: "Who have you been working with at RSE?",
    help: "What do you need help with today?"
  }
};

// ============================================================================
// MEMBERSHIP PLANS - ACCURATE PRICING (do not invent other plans)
// ============================================================================
const MEMBERSHIP_PLANS = {
  generator: {
    name: "Generator Service Plan",
    yearly: 275
  },
  home_comfort: {
    monthly: {
      one_unit: 31.25,
      two_units: 42,
      three_units: 50,
      four_units: 58,
      multiple_properties: 80
    },
    yearly: {
      one_unit: 375,
      two_units: 450,
      three_units: 550,
      four_units: 650,
      multiple_properties: 900
    }
  }
};

// ============================================================================
// ADDRESS
// ============================================================================
const ADDRESS = {
  ask: "What's the service address?"
};

// ============================================================================
// AVAILABILITY
// ============================================================================
const AVAILABILITY = {
  ask: "What days and times usually work best for you?",
  clarify_time: "Is that mornings, afternoons, or evenings?"
};

// ============================================================================
// CONFIRMATION - WITH SPELLING REQUIREMENTS
// ============================================================================
const CONFIRMATION = {
  intro: "Let me read that back.",
  verify: "Is all of that correct?",
  correction_reread: "I've updated that. Let me read that back again."
};

// ============================================================================
// CLOSE
// ============================================================================
const CLOSE = {
  anything_else: "Is there anything else I can help with today?",
  goodbye: "Thanks for calling RSE Energy Group. Have a great day.",
  out_of_scope_close: "Thanks for calling. Have a great day."
};

// ============================================================================
// OUT OF SCOPE RESPONSES
// ============================================================================
const OUT_OF_SCOPE = {
  solar: "We don't handle solar services, but I can help with HVAC, generators, or maintenance if that helps.",
  electrical: "We specialize in HVAC and generators. For electrical work, you'd need an electrician.",
  plumbing: "We specialize in HVAC and generators. For plumbing, you'd need a plumber.",
  general: "We don't offer that service. RSE handles HVAC, generators, and maintenance memberships. Can I help with any of those?"
};

// ============================================================================
// SCHEDULING RESPONSE (intake-only)
// ============================================================================
const NEUTRAL = {
  scheduling: "I can take your availability and pass it to the team.",
  clarify: "I didn't quite catch that. Could you say it one more time?",
  ramble_redirect: "I got the gist. Let me get your information so we can help you out."
};

// ============================================================================
// ACKNOWLEDGEMENT POOL (variation required)
// ============================================================================
const ACKNOWLEDGEMENTS = [
  "Okay.",
  "Alright.",
  "Thanks.",
  "Perfect.",
  "Understood.",
  "Sounds good.",
  "No problem.",
  "Great.",
  "Mm hm."
];

// ============================================================================
// MICRO-RESPONSES (for backchanneling)
// ============================================================================
const MICRO_RESPONSES = {
  general: ACKNOWLEDGEMENTS,
  after_capture: ["Perfect.", "Thanks.", "Great."],
  before_confirmation: ["Let me read that back."]
};

// ============================================================================
// INTENT TYPES - STRICT LIST
// ============================================================================
const INTENT_TYPES = {
  HVAC_SERVICE: 'hvac_service',
  HVAC_INSTALLATION: 'hvac_installation_or_upgrade',
  GENERATOR: 'generator',
  MEMBERSHIP: 'membership',
  EXISTING_PROJECT: 'existing_project',
  OUT_OF_SCOPE: 'other_out_of_scope'
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
  AVAILABILITY: 'availability',
  CONFIRMATION: 'confirmation',
  CLOSE: 'close',
  ENDED: 'ended'
};

// ============================================================================
// ALLOWED SERVICES - EXHAUSTIVE LIST
// ============================================================================
const ALLOWED_SERVICES = {
  hvac: [
    'heating',
    'air conditioning',
    'hvac service',
    'hvac repair',
    'hvac maintenance',
    'hvac installation',
    'hvac upgrade',
    'hvac replacement',
    'furnace',
    'boiler',
    'central air',
    'mini split',
    'rooftop unit',
    'heat pump',
    'ac',
    'ac repair',
    'no heat',
    'no cooling',
    'thermostat',
    'ductwork',
    'home visit',
    'pm service',
    'permit inspection'
  ],
  generator: [
    'generator',
    'generator service',
    'generator repair',
    'generator maintenance',
    'generator installation',
    'generator sales',
    'backup power',
    'standby generator',
    'cummins',
    'generac'
  ],
  membership: [
    'membership',
    'maintenance plan',
    'home comfort plan',
    'service plan',
    'monthly plan',
    'yearly plan'
  ],
  project: [
    'existing project',
    'current project',
    'job in progress',
    'follow up',
    'ongoing work'
  ]
};

// ============================================================================
// DISALLOWED SERVICES - NEVER OFFER THESE
// ============================================================================
const DISALLOWED_SERVICES = [
  'solar',
  'solar panel',
  'solar installation',
  'solar audit',
  'solar energy',
  'renewable energy',
  'energy audit',
  'electrical',
  'electrician',
  'wiring',
  'plumbing',
  'plumber',
  'water heater',
  'roofing',
  'insulation',
  'windows',
  'doors'
];

// ============================================================================
// SYSTEM PROMPT FOR OPENAI REALTIME
// INTAKE-ONLY - STRICT SERVICE CONSTRAINTS
// ============================================================================
const SYSTEM_PROMPT = `You are Ava, an intake receptionist for RSE Energy Group, an HVAC and generator company.

=== HARD SERVICE CONSTRAINTS - CRITICAL ===

ALLOWED SERVICES ONLY (never mention anything else):
1. HVAC AND RELATED:
   - Heating service and repair
   - Air conditioning service and repair
   - HVAC maintenance
   - HVAC installation and upgrades
   - Furnace, boiler, central air, mini split, rooftop unit, heat pump
   - Home visits, PM service, permit inspections

2. GENERATORS:
   - Generator service and repair
   - Generator maintenance
   - Generator installation and sales
   - Only mention Cummins if caller brings it up first

3. MEMBERSHIPS (exact pricing - do not invent other plans):
   
   Generator Service Plan:
   - $275/year
   
   Home Comfort Plans (MONTHLY):
   - 1 unit: $31.25/month
   - 2 units: $42/month
   - 3 units: $50/month
   - 4 units: $58/month
   - Multiple properties: $80/month
   
   Home Comfort Plans (YEARLY):
   - 1 unit: $375/year
   - 2 units: $450/year
   - 3 units: $550/year
   - 4 units: $650/year
   - Multiple properties: $900/year

   MEMBERSHIP RULES:
   - Only mention plans when caller asks about memberships, plans, pricing, or maintenance
   - Present monthly vs yearly options, then ask how many systems/properties
   - You do NOT sell plans, process payments, or enroll anyone
   - Take name, phone, email, address, availability and pass to team
   - If caller asks about inclusions, say: "A team member can confirm all the details."

4. EXISTING PROJECTS:
   - Ongoing jobs already in progress with RSE

=== ABSOLUTELY DISALLOWED - NEVER MENTION ===
- Solar panels (NEVER)
- Solar audits (NEVER)
- Solar energy plans (NEVER)
- Solar installations (NEVER)
- Energy audits (unless caller clarifies it's HVAC-related)
- Electrical work
- Plumbing
- Roofing, insulation, windows

If caller asks about solar or any disallowed service:
Say exactly: "We don't handle solar services, but I can help with HVAC, generators, or maintenance if that helps."

If caller asks about electrical or plumbing:
Say exactly: "We specialize in HVAC and generators. For [electrical/plumbing], you'd need a [electrician/plumber]."

=== INTENT CLASSIFICATION ===
Classify calls into ONLY these categories:
- hvac_service: Service calls, repairs, maintenance, no heat, no cooling
- hvac_installation_or_upgrade: New installations, replacements, upgrades
- generator: Generator service, installation, or sales
- membership: Home Comfort Plans, maintenance memberships
- existing_project: Following up on current RSE work
- other_out_of_scope: Solar, electrical, plumbing, or anything not listed above

For other_out_of_scope:
1. Politely state the service is not offered
2. Redirect to allowed services
3. Do NOT continue intake if they only want the unsupported service
4. If they have an allowed need too, proceed with that

=== INTAKE ROLE ===
You are INTAKE ONLY. Collect info for human review later.

NEVER DO THESE:
- NEVER schedule appointments
- NEVER promise a technician time
- NEVER say "we will be there at X" or "you are booked"
- NEVER invent services RSE doesn't offer

If caller asks to schedule:
Say exactly: "I can take your availability and pass it to the team."

=== REQUIRED FIELDS ===
1. First name
2. Last name
3. Phone number
4. Email (optional)
5. Service address (with city/zip if given)
6. Best availability window
7. Situation details summary

=== SPEECH STYLE ===
- Normal conversational pace
- Use contractions: "I'm", "what's", "you're"
- Keep responses SHORT: max two sentences
- Sound natural, not scripted

=== ACKNOWLEDGEMENT RULES ===
Allowed (use variety, never repeat):
"Okay." "Alright." "Thanks." "Perfect." "Understood." "Sounds good." "No problem." "Great." "Mm hm."

Rules:
- NEVER same acknowledgement twice in a row
- Max ONE per response
- Often skip and go straight to question

=== END-OF-CALL CONFIRMATION ===
Read back with spelling:
- First name: spelled letter by letter
- Last name: spelled letter by letter  
- Phone: digit by digit with pauses
- Email: spelled with "at" and "dot"
- Address: read clearly
- Availability: read the window
- Issue: one sentence summary

Then ask: "Is all of that correct?"

=== SAFETY ===
If smoke, gas smell, sparks, or total shutdown mentioned:
Say: "Please hang up and call 911 or your utility provider right away."

Remember: RSE = HVAC + Generators ONLY. Never solar. Never invent services.`;

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  GREETING,
  INTENT_PROMPTS,
  SAFETY,
  CALLER_INFO,
  DETAILS,
  MEMBERSHIP_PLANS,
  ADDRESS,
  AVAILABILITY,
  CONFIRMATION,
  CLOSE,
  OUT_OF_SCOPE,
  NEUTRAL,
  ACKNOWLEDGEMENTS,
  MICRO_RESPONSES,
  INTENT_TYPES,
  STATES,
  ALLOWED_SERVICES,
  DISALLOWED_SERVICES,
  SYSTEM_PROMPT
};
