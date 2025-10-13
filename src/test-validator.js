// test-validator.js - Test the field validation system

const { FieldValidator } = require('./field-validator');

console.log("🧪 Testing Field Validator\n");

const validator = new FieldValidator();

// Test 1: Low confidence email
console.log("Test 1: Low confidence email");
const test1 = validator.captureField('email', 'tim at example dot com', 0.45);
console.log("Result:", test1);
console.log("Awaiting:", validator.getCurrentVerification());
console.log("");

// Test 2: Verify the email
console.log("Test 2: Verify email with spelling");
const verify1 = validator.handleVerificationResponse('t i m @ e x a m p l e . c o m');
console.log("Result:", verify1);
console.log("Field data:", validator.fields.email);
console.log("");

// Test 3: Invalid phone format (even with high confidence)
console.log("Test 3: Invalid phone format");
const test3 = validator.captureField('phone', 'call me at five five five', 0.85);
console.log("Result:", test3);
console.log("");

// Test 4: Valid phone
console.log("Test 4: Valid phone");
const verify2 = validator.handleVerificationResponse('732-555-0199');
console.log("Result:", verify2);
console.log("Field data:", validator.fields.phone);
console.log("");

// Test 5: Low confidence issue description (repeat-back)
console.log("Test 5: Low confidence issue description");
const test5 = validator.captureField('issue_description', 'my AC is making weird noises', 0.55);
console.log("Result:", test5);
console.log("");

// Test 6: Confirm issue (yes)
console.log("Test 6: Confirm issue");
const verify3 = validator.handleVerificationResponse('yes that is correct');
console.log("Result:", verify3);
console.log("Field data:", validator.fields.issue_description);
console.log("");

// Test 7: Already verified field (should skip)
console.log("Test 7: Try to capture email again (should skip)");
const test7 = validator.captureField('email', 'different@email.com', 0.40);
console.log("Result:", test7);
console.log("");

// Test 8: High confidence, valid format (should accept immediately)
console.log("Test 8: High confidence, valid name");
const test8 = validator.captureField('first_name', 'Timothy', 0.95);
console.log("Result:", test8);
console.log("Field data:", validator.fields.first_name);
console.log("");

// Final summary
console.log("📊 Final Summary:");
console.log("All Fields:", JSON.stringify(validator.getAllFields(), null, 2));
console.log("\nVerification Events:", JSON.stringify(validator.getVerificationEvents(), null, 2));
console.log("\n💾 SharePoint Data:");
console.log(JSON.stringify(validator.getSharePointData(), null, 2));

