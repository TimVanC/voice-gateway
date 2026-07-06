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
    const isNewGenerator = /\b(new|install|installation|buy|purchase|looking for|interested in|want to get|quote|estimate|price|cost)\b/.test(text);
    if (isNewGenerator) {
      // Return with a flag that we can use to skip safety check
      // We'll handle this by returning a special object
      return { intent: INTENT_TYPES.GENERATOR, isNew: true };
    }
    return INTENT_TYPES.GENERATOR;
  }

  // Installation/upgrade keywords - CHECK BEFORE service keywords
  // "new", "install", "replace" indicate installation, not service
  if (/\b(new|install|installation|replace|replacement|upgrade|estimate|quote|cost|price|proposal)\b/.test(text)) {
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
  if (/\b(membership|member|maintenance plan|home comfort plan|service plan|annual coverage|monthly coverage|tune up plan)\b/.test(text)) {
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

module.exports = { classifyIntent };
