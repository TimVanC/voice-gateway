# 🔍 Confidence Checking & Verification System

## Overview

The RSE Energy AI receptionist includes a comprehensive confidence checking and verification system that automatically validates all collected information to ensure accuracy and data quality.

---

## 🎯 Key Features

### 1. **Automatic Confidence Monitoring**
- Every transcription receives a confidence score (0.0 to 1.0)
- Threshold: **0.60** (60%)
- Below threshold → automatic verification triggered

### 2. **Format Validation**
Independent of confidence, certain fields have format requirements:

| Field Type | Validation | Example |
|------------|------------|---------|
| **Email** | Regex: `user@domain.tld` | Must have @, domain, TLD |
| **Phone** | 10-11 digits only | (732) 555-0199 |
| **Address** | Min 3 chars, has letters | 123 Main St |
| **Names** | No numbers/symbols | Timothy (not Tim123) |

### 3. **Smart Verification Prompts**

#### Personal Info → Spelling Required
```
First Name:  "Could you please spell your first name for me?"
Last Name:   "Could you please spell your last name for me?"
Email:       "Do you mind spelling out that email for me?"
Phone:       "Could you say your phone number slowly, digit by digit?"
Street:      "Could you please spell that street name for me?"
City:        "Could you please spell the city name for me?"
```

#### Problem Context → Repeat-Back
```
Issue:       "I heard: 'my AC is making weird noises'. Is that correct?"
Equipment:   "I heard: 'central air conditioner'. Is that correct?"
Symptoms:    "I heard: 'blowing warm air'. Is that correct?"
```

If caller says **NO**:
```
"No problem. Please repeat that once more, and I will confirm."
```

### 4. **Once-Per-Field Rule**
- Each field verified **ONCE** only
- After successful verification: `verified: true`
- System won't re-verify unless caller explicitly requests correction
- Prevents verification loops and caller frustration

---

## 📊 Data Model

### Field Structure
```json
{
  "field": "email",
  "raw_value": "tim at example dot com",
  "final_value": "tim@example.com",
  "confidence": 0.54,
  "verified": true,
  "verified_at": "2025-10-13T21:30:00.000Z"
}
```

**Fields:**
- `field`: Field name (e.g., "email", "phone", "first_name")
- `raw_value`: Original transcription before verification
- `final_value`: Normalized/corrected value after verification
- `confidence`: Original transcription confidence (0-1)
- `verified`: Boolean - has this field been verified?
- `verified_at`: ISO timestamp of verification

### Verification Event Log
```json
{
  "field": "email",
  "reason": "low_confidence",
  "prompt_used": "Do you mind spelling out that email for me?",
  "timestamp": "2025-10-13T21:30:00.000Z",
  "confidence": 0.54
}
```

**Reasons:**
- `low_confidence` - Confidence ≤ 0.60
- `invalid_format` - Failed format validation
- `unlikely_characters` - Names with numbers/symbols

---

## 🔄 Workflow

### Example: Email Collection

**Scenario 1: Low Confidence**
```
User says: "tim at example dot com"
Confidence: 0.45
System detects: Low confidence + invalid format

Zelda: "Thanks. Do you mind spelling out that email for me?"
User: "t i m @ e x a m p l e . c o m"
System: Normalizes to "tim@example.com"
Result: ✅ Verified and saved
```

**Scenario 2: High Confidence, Valid Format**
```
User says: "tim@example.com"
Confidence: 0.92
System detects: High confidence + valid format

Result: ✅ Accepted immediately (no verification needed)
```

**Scenario 3: High Confidence, Invalid Format**
```
User says: "my email is tim example dot com"
Confidence: 0.88
System detects: High confidence BUT invalid format

Zelda: "Do you mind spelling out that email for me?"
(Format validation overrides high confidence)
```

### Example: Issue Description

**Scenario: Low Confidence**
```
User says: "my AC is making weird noises"
Confidence: 0.55
System detects: Low confidence

Zelda: "I heard: 'my AC is making weird noises'. Is that correct?"
User: "Yes"
Result: ✅ Verified and saved

OR

User: "No, it's blowing warm air"
Zelda: "No problem. Please repeat that once more, and I will confirm."
User: "It's blowing warm air instead of cold"
Zelda: "I heard: 'It's blowing warm air instead of cold'. Is that correct?"
User: "Yes"
Result: ✅ Verified and saved
```

---

## 📋 Monitored Fields

### Personal Information
- `first_name` - First name
- `last_name` - Last name
- `email` - Email address
- `phone` - Phone number
- `street` - Street address
- `city` - City
- `state` - State
- `zip` - Zip code
- `preferred_contact_method` - How to contact

### Problem Context
- `issue_description` - Main problem description
- `equipment_type` - Type of HVAC system
- `brand` - Equipment brand/manufacturer
- `symptoms` - Specific symptoms
- `urgency` - Urgency level (not urgent / somewhat / very)

---

## 💾 SharePoint Integration

At the end of each call, the system outputs SharePoint-ready JSON:

```json
{
  "fields": [
    {
      "field": "first_name",
      "raw_value": "Timothy",
      "final_value": "Timothy",
      "confidence": 0.95,
      "verified": true,
      "verified_at": "2025-10-13T21:30:00.000Z"
    },
    {
      "field": "email",
      "raw_value": "tim at example dot com",
      "final_value": "tim@example.com",
      "confidence": 0.54,
      "verified": true,
      "verified_at": "2025-10-13T21:30:15.000Z"
    }
  ],
  "verification_events": [
    {
      "field": "email",
      "reason": "low_confidence",
      "prompt_used": "Do you mind spelling out that email for me?",
      "timestamp": "2025-10-13T21:30:10.000Z",
      "confidence": 0.54
    }
  ]
}
```

**Usage:**
```javascript
// At call end
const sharePointData = fieldValidator.getSharePointData();

// Send to SharePoint/Database
await saveToSharePoint(callSid, sharePointData);
```

---

## 🧪 Testing

Run the test suite:
```bash
node src/test-validator.js
```

**Test Coverage:**
- ✅ Low confidence email → spelling verification
- ✅ Invalid phone format → digit-by-digit input
- ✅ Low confidence issue → repeat-back confirmation
- ✅ High confidence valid data → immediate acceptance
- ✅ Already verified field → skip re-verification
- ✅ Normalization (phone formatting, email lowercase)

---

## 🎨 UX Best Practices

### ✅ DO:
- Keep verification prompts **short and friendly**
- Use **natural language** ("Could you spell that for me?")
- **Thank the caller** before asking for verification
- Accept **common phonetics** if available (Alpha, Bravo, Charlie)
- **Confirm** after successful verification ("Got it, thanks!")

### ❌ DON'T:
- Loop verification **more than once** per field
- Sound **robotic** or accusatory ("INVALID INPUT")
- Ask for verification on **high-confidence, valid data**
- **Interrupt** the caller mid-sentence
- Make the caller feel like they **did something wrong**

---

## 🔧 Configuration

### Adjust Confidence Threshold
```javascript
// In src/field-validator.js
const CONFIDENCE_THRESHOLD = 0.60; // Change to 0.50 for more lenient, 0.70 for stricter
```

### Customize Verification Prompts
```javascript
// In src/field-validator.js
const VERIFY_PROMPTS = {
  email: (transcript) => `Your custom prompt here`,
  // ... other fields
};
```

### Add New Fields
```javascript
// In src/field-validator.js
const PERSONAL_INFO_FIELDS = [
  'first_name', 'last_name', 'email', 'phone',
  'your_new_field_here'  // Add here
];
```

---

## 📈 Benefits

### For RSE Energy:
- ✅ **Higher data accuracy** (fewer typos, wrong numbers)
- ✅ **Reduced callbacks** (correct info first time)
- ✅ **Audit trail** (verification events logged)
- ✅ **Quality metrics** (track confidence scores)
- ✅ **Compliance** (verify critical contact info)

### For Customers:
- ✅ **Confidence** in data accuracy
- ✅ **Natural conversation** (not robotic)
- ✅ **Quick verification** (only when needed)
- ✅ **No loops** (verify once, move on)
- ✅ **Professional experience**

---

## 🚀 Future Enhancements

Potential improvements:
- [ ] Phonetic alphabet support (Alpha, Bravo, Charlie)
- [ ] Multi-language support
- [ ] Address validation via Google Maps API
- [ ] Real-time SharePoint integration
- [ ] Confidence score analytics dashboard
- [ ] Machine learning to improve threshold per field type
- [ ] Voice biometrics for caller verification
- [ ] Automatic retry on persistent low confidence

---

## 📞 Support

For questions or issues with the confidence checking system:
- Review logs: Look for `📝 Transcription (conf: X.XX)` entries
- Check verification events: Logged at call end
- Test manually: `node src/test-validator.js`
- Adjust threshold: Modify `CONFIDENCE_THRESHOLD` in `field-validator.js`

---

**System Status:** ✅ Production Ready  
**Last Updated:** October 13, 2025  
**Version:** 1.0.0

