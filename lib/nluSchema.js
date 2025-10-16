// lib/nluSchema.js
const toolSpec = [{
  type: "function",
  function: {
    name: "capture_field",
    description: "Capture a structured field from the user with confidence",
    parameters: {
      type: "object",
      properties: {
        field: {
          type: "string",
          enum: ["first_name","last_name","full_name","email","phone","street","city","state","zip","issue","equipment","brand","symptoms","urgency","preferred_time"]
        },
        value: { type: "string" },
        reason: { type: "string", enum: ["user_said","verified","corrected"] },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["field","value","confidence"]
    }
  }
}];

const systemPreamble = `
You are a concise HVAC receptionist. Keep replies to 1 or 2 sentences.
When the user provides a data field, always call capture_field with your best guess and a confidence between 0 and 1.
If confidence < 0.6, ask a quick micro confirmation next turn. Avoid long monologues.
`;

module.exports = { toolSpec, systemPreamble };

