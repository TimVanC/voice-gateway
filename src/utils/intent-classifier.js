/**
 * Intent classification for caller utterances.
 *
 * Extracted from server-rse.js (pure function, no connection state) so the
 * classifier can be tested directly — server-rse.js starts the HTTP listener
 * on require, which makes it unimportable from test scripts.
 *
 * Callers pass lowercased transcripts.
 */

const { INTENT_TYPES } = require('../scripts/rse-script');

// "air condition" alone misses "air conditioner"/"conditioning" (the \b after
// "condition" fails mid-word), so match the whole word family. "ac" covers
// "my AC" / "AC unit" in lowercased input; "a/c" covers the slash spelling.
const AC_VARIANTS = 'ac|a\\/c|air condition\\w*|central air';

// Membership / maintenance-plan phrasing. The installation branch excludes it
// so "what does your maintenance membership plan cost" is membership, not an
// installation estimate: price/cost/quote words are how callers ask about
// plans too.
// Softer "I want one" phrasing, and "installed"/"installing" (the install
// pattern is the bare word, so "...generator installed" missed it). These also
// occur in service calls ("the furnace you installed won't start", "looking to
// get my generator serviced"), so they count only without service words.
const SOFT_INSTALL_PATTERN = /\b(installed|installing|put in|(?:like|love|want|wanting|looking|hoping|planning) to (?:get|have|buy|add)|thinking (?:about|of) (?:getting|adding|buying))\b/;
const SERVICE_WORDS_PATTERN = /\b(servic\w*|repair\w*|fix\w*|broke\w*|not working|isn'?t working|won'?t|wont|stopped|leak\w*|noise|issue|problem|maintenance|tune|check\w*|look(?:ed)? at)\b/;
const softInstall = (text) => SOFT_INSTALL_PATTERN.test(text) && !SERVICE_WORDS_PATTERN.test(text);

const MEMBERSHIP_PATTERN = /\b(membership|member|maintenance plan|maintenance membership|home comfort plan|service plan|annual coverage|monthly coverage|tune up plan|tune-up plan)\b/;

function classifyIntent(text) {
  // Normalize ASR artifacts so accented pronunciations still classify correctly.
  // Example: "geneartor"/"genarator"/"generater" should map to generator intent.
  const words = String(text || '')
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z]/g, ''))
    .filter(Boolean);

  const hasGeneratorLikeToken = words.some(w =>
    w === 'generator' ||
    w === 'generators' ||
    w.startsWith('generat') || // generater, generaters, generateor
    w.startsWith('genarat') || // genarator, genarators
    w.startsWith('geneart') || // geneartor, geneartors
    w.startsWith('genrator') || // dropped vowel variants
    w.startsWith('jennerator') || // common phonetic ASR variant
    w.startsWith('generators') // defensive typo variant
  );

  // ============================================================
  // DISALLOWED SERVICES - Check first and reject
  // ============================================================
  if (/\b(solar|photovoltaic|pv panel|solar panel|solar audit|solar energy|solar install)\b/.test(text)) {
    console.log('⚠️ Detected disallowed service: SOLAR');
    return INTENT_TYPES.OUT_OF_SCOPE;
  }

  if (/\b(electrical|electrician|wiring|outlet|circuit|breaker|panel upgrade)\b/.test(text) &&
      !(hasGeneratorLikeToken || new RegExp(`\\b(hvac|furnace|${AC_VARIANTS})\\b`).test(text))) {
    console.log('⚠️ Detected disallowed service: ELECTRICAL');
    return INTENT_TYPES.OUT_OF_SCOPE;
  }

  if (/\b(plumbing|plumber|water heater|pipe|drain|toilet|faucet|sewer)\b/.test(text)) {
    console.log('⚠️ Detected disallowed service: PLUMBING');
    return INTENT_TYPES.OUT_OF_SCOPE;
  }

  if (/\b(roofing|roof|insulation|window|door|siding)\b/.test(text) &&
      !new RegExp(`\\b(hvac|furnace|${AC_VARIANTS}|rooftop unit)\\b`).test(text)) {
    console.log('⚠️ Detected disallowed service: OTHER HOME IMPROVEMENT');
    return INTENT_TYPES.OUT_OF_SCOPE;
  }

  // Energy audit only allowed if HVAC-related or when clearly referring to the Energy Efficiency Program.
  if (/\b(energy audit)\b/.test(text) &&
      !/\b(hvac|heating|cooling)\b/.test(text) &&
      !/\b(energy efficiency|efficiency program|energy savings program|save energy program)\b/.test(text)) {
    console.log('⚠️ Detected disallowed service: ENERGY AUDIT');
    return INTENT_TYPES.OUT_OF_SCOPE;
  }

  // ============================================================
  // ALLOWED SERVICES - Order matters! Check installation FIRST
  // ============================================================

  // Energy Efficiency Program interest
  if (/\b(energy efficiency|efficiency program|energy savings program|save energy program)\b/.test(text)) {
    return INTENT_TYPES.ENERGY_EFFICIENCY;
  }

  // Generator keywords - check for NEW vs SERVICE
  if (hasGeneratorLikeToken || /\b(generac|cummins|backup power|standby|whole house power)\b/.test(text)) {
    // Check if it's for a NEW generator (installation, not service)
    const isNewGenerator = /\b(new|install|installation|buy|purchase|looking for|interested in|want to get|quote|estimate|price|cost)\b/.test(text) ||
      softInstall(text);
    if (isNewGenerator) {
      // Return with a flag that we can use to skip safety check
      // We'll handle this by returning a special object
      return { intent: INTENT_TYPES.GENERATOR, isNew: true };
    }
    return INTENT_TYPES.GENERATOR;
  }

  // Installation/upgrade keywords - CHECK BEFORE service keywords
  // "new", "install", "replace" indicate installation, not service.
  // Membership phrasing is excluded: "cost"/"price" of a plan is a membership
  // question, handled below (after the service checks, as before).
  if ((/\b(new|install|installation|replace|replacement|upgrade|estimate|quote|cost|price|proposal)\b/.test(text) ||
       /\b(installed|installing)\b/.test(text) && !SERVICE_WORDS_PATTERN.test(text)) &&
      !MEMBERSHIP_PATTERN.test(text)) {
    console.log('📋 Detected installation/upgrade keywords');
    return INTENT_TYPES.HVAC_INSTALLATION;
  }

  // Service/repair keywords (HVAC) - HIGH CONFIDENCE patterns
  // These should immediately lock intent as HVAC_SERVICE
  if (/\b(repair|fix|broken|not working|isn't working|isnt working|won't work|wont work|doesn't work|doesnt work)\b/.test(text)) {
    return INTENT_TYPES.HVAC_SERVICE;
  }
  if (/\b(service call|problem|issue|no heat|no cool|no cooling|no heating|not heating|not cooling)\b/.test(text)) {
    return INTENT_TYPES.HVAC_SERVICE;
  }
  if (/\b(noise|leak|leaking|frozen|won't start|wont start|stopped working|not running|won't turn on|wont turn on)\b/.test(text)) {
    return INTENT_TYPES.HVAC_SERVICE;
  }
  if (/\b(heat.{0,10}(not|isn't|isnt|won't|wont|doesn't|doesnt))|((not|isn't|isnt|won't|wont).{0,10}heat)\b/i.test(text)) {
    return INTENT_TYPES.HVAC_SERVICE;
  }
  if (new RegExp(`\\b((${AC_VARIANTS}).{0,10}(not|isn't|isnt|won't|wont|doesn't|doesnt))|((not|isn't|isnt|won't|wont).{0,10}(${AC_VARIANTS}))\\b`, 'i').test(text)) {
    return INTENT_TYPES.HVAC_SERVICE;
  }
  if (/\b(blowing.{0,15}(cold|warm|lukewarm|hot))\b/i.test(text)) {
    return INTENT_TYPES.HVAC_SERVICE;
  }

  // Membership keywords - HIGH CONFIDENCE patterns
  if (MEMBERSHIP_PATTERN.test(text)) {
    return INTENT_TYPES.MEMBERSHIP;
  }

  // Existing project keywords
  if (/\b(existing project|current project|in progress|follow up|following up|job|quote you gave|estimate you gave|spoke to someone)\b/.test(text)) {
    return INTENT_TYPES.EXISTING_PROJECT;
  }

  // HVAC system mentions without clear intent - default to service
  if (new RegExp(`\\b(furnace|boiler|${AC_VARIANTS}|heat pump|mini[\\s-]?split|hvac|heating|cooling|thermostat|ductwork)\\b`).test(text)) {
    return INTENT_TYPES.HVAC_SERVICE;
  }

  // If nothing matched, return null to let AI classify naturally
  return null;
}

// ============================================================================
// DETECT REAL PERSON REQUEST
// ============================================================================

/**
 * Detects explicit requests to reach a human. Explicit phrasings ("real
 * person", "agent", "transfer") fire in any state. Softer "reach" phrasings
 * ("looking for", "speak to", "reach") only fire in early states AND only
 * when aimed at a person AND the utterance carries no service intent —
 * "I'm looking for someone to service my furnace" is intake, not a
 * transfer request.
 * @param {string} transcript - raw transcript (any case)
 * @param {string} [state] - current call state name
 */
function detectRealPersonRequest(transcript, state) {
  const lowerTranscript = String(transcript || '').toLowerCase().replace(/[‘’]/g, "'");
  // A request has a verb aimed at a person. Words on their own used to count:
  // "Hello, is anybody there?" and "am I talking to a real person or a
  // computer?" were transferred to the office, and so would "my transfer
  // switch is broken" or "a team member said they'd call" (simulated calls,
  // Nov 17 2026).
  const WHO = "(?:(?:a|an|the|your|some|one of your)\\s+)?(?:(?:real|live|actual)\\s+)?(?:person|human(?:\\s+being)?|agent|representative|rep|operator|team member|staff member|manager|supervisor|owner|receptionist)";
  const ANYONE = `(?:${WHO}|somebody|someone|anybody|anyone|a real one|people)`;
  const realPersonPatterns = [
    // "talk to a real person", "speak with someone", "talk to the office"
    new RegExp(`\\b(?:speak|talk|chat)\\s+(?:to|with)\\s+(?:${ANYONE}|(?:the|your)\\s+(?:office|front desk|service department|dispatch))\\b`),
    // "get me a person", "connect me to an agent", "put me through to someone"
    new RegExp(`\\b(?:get|give|connect|transfer|put|pass|patch)\\s+me\\s+(?:(?:to|through to|through|over to|on with|with)\\s+)?${ANYONE}\\b`),
    // "I want a human", "I'd like an agent" (not "I need someone to come look at it")
    new RegExp(`\\bi(?:'d| would)?\\s+(?:want|need|like|prefer)\\s+${WHO}\\b(?!\\s+to\\s+(?:come|look|fix|check|see|service))`),
    // "is there a person I can talk to", "is there someone I could speak with"
    new RegExp(`\\bis there\\s+${ANYONE}\\s+(?:i|we)\\s+(?:can|could)\\s+(?:talk|speak)\\b`),
    // "transfer me", "can you transfer my call", "put me through"
    /\b(?:transfer me|transfer (?:my|this|the) call|be transferred|get transferred|(?:can|could|will|would) you (?:please )?transfer|please transfer|put me through|connect me)\b/,
    // "I don't want to talk to a computer"
    /\b(?:don'?t|do not) want (?:to (?:talk|speak) (?:to|with) )?(?:a|an|the|this) (?:computer|machine|robot|bot|ai|recording|automated)\b/,
    // "representative", "agent please", "a real person", "customer service"
    new RegExp(`^\\W*(?:${WHO}|customer service)(?:[\\s,]+please)?\\W*$`),
  ];

  if (realPersonPatterns.some(pattern => pattern.test(lowerTranscript))) return true;

  // Staff name and "reach someone" patterns — ONLY active in greeting/intent state
  // to avoid triggering when a caller gives their own name during intake
  const isEarlyState = !state || state === 'greeting' || state === 'intent';
  if (isEarlyState) {
    const RSE_STAFF_NAMES = /\b(ronald|ron|zelda|raymond|andrew|shamyah|kai)\b/i;
    const REACH_PATTERNS = /\b(get a hold of|reach|trying to reach|speak to|speak with|talk to|talk with|looking for|get through to)\b/i;
    const STAFF_REACH = /\b(get a hold of|reach|trying to reach|speak to|speak with|talk to|talk with|looking for|get through to|calling for|is \w+ (there|in|available|around))\b/i;
    const PERSON_REFERENCE = /\b(someone|somebody|anyone|anybody|a person|person|people|human|staff|manager|owner|receptionist|the office)\b/i;
    // A staff name counts when the caller is asking for that person ("is Ron
    // there?", "can I speak to Zelda"), not when it is the caller's own name
    // ("Hi, this is Andrew Miller, my furnace is out").
    if (RSE_STAFF_NAMES.test(lowerTranscript) && STAFF_REACH.test(lowerTranscript) && !/\b(this is|my name is|i'?m|it'?s)\s+(ronald|ron|zelda|raymond|andrew|shamyah|kai)\b/i.test(lowerTranscript)) return true;
    // Reach phrasing counts as a transfer request only when aimed at a person
    // and not carrying a service need (service needs go through intake).
    if (REACH_PATTERNS.test(lowerTranscript) &&
        PERSON_REFERENCE.test(lowerTranscript) &&
        !classifyIntent(lowerTranscript)) {
      return true;
    }
  }

  return false;
}

module.exports = { classifyIntent, detectRealPersonRequest };
