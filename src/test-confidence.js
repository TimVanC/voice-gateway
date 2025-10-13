// test-confidence.js - Test the confidence estimator

const { estimateConfidence, inferFieldContext } = require('./confidence-estimator');

console.log("🧪 Testing Confidence Estimator\n");

const tests = [
  // High confidence cases
  { text: "Timothy", context: "first_name", expected: "high" },
  { text: "tim@example.com", context: "email", expected: "high" },
  { text: "973-885-2528", context: "phone", expected: "high" },
  { text: "My AC is making weird noises", context: "issue_description", expected: "high" },
  
  // Low confidence cases - gibberish
  { text: "xyzqwrtplmnk", context: "first_name", expected: "low" },
  { text: "um uh like you know", context: "email", expected: "low" },
  { text: "123", context: "first_name", expected: "low" },
  
  // Low confidence - spoken format
  { text: "tim at example dot com", context: "email", expected: "low" },
  { text: "nine seven three eight eight five", context: "phone", expected: "low" },
  
  // Edge cases
  { text: "Can I get you a good word for what you want?", context: "email", expected: "low" },
  { text: "No", context: "general", expected: "medium" },
  { text: "[inaudible]", context: "first_name", expected: "low" },
  { text: "um um um um", context: "general", expected: "low" },
];

tests.forEach((test, i) => {
  const result = estimateConfidence(test.text, test.context);
  
  console.log(`Test ${i + 1}: ${test.expected.toUpperCase()} confidence expected`);
  console.log(`  Text: "${test.text}"`);
  console.log(`  Context: ${test.context}`);
  console.log(`  Estimated Confidence: ${result.confidence.toFixed(2)}`);
  console.log(`  Indicators: ${result.indicators.join(', ') || 'none'}`);
  
  // Verify expectation
  let pass = false;
  if (test.expected === "high" && result.confidence >= 0.70) pass = true;
  if (test.expected === "medium" && result.confidence >= 0.40 && result.confidence < 0.70) pass = true;
  if (test.expected === "low" && result.confidence < 0.60) pass = true;
  
  console.log(`  Result: ${pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log("");
});

// Test field context inference
console.log("\n🔍 Testing Field Context Inference\n");

const contextTests = [
  { question: "What's your email?", expected: "email" },
  { question: "What's your phone number?", expected: "phone" },
  { question: "What's your first name?", expected: "first_name" },
  { question: "What seems to be the issue?", expected: "issue_description" },
  { question: "How urgent is this?", expected: "urgency" },
  { question: "What type of system do you have?", expected: "equipment_type" },
];

contextTests.forEach((test, i) => {
  const inferred = inferFieldContext(test.question);
  const pass = inferred === test.expected;
  
  console.log(`Context Test ${i + 1}: ${pass ? '✅' : '❌'}`);
  console.log(`  Question: "${test.question}"`);
  console.log(`  Expected: ${test.expected}`);
  console.log(`  Inferred: ${inferred}`);
  console.log("");
});

