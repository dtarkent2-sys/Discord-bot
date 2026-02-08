/**
 * Trade plan JSON validator.
 * Validates AI output against trade_plan.schema.json without external deps.
 */

const schema = require('./trade_plan.schema.json');

class ValidationError extends Error {
  constructor(errors) {
    super(`Trade plan validation failed: ${errors.join('; ')}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Validate a trade plan object against the schema.
 * Returns { valid: true, plan } or { valid: false, errors: [] }.
 */
function validateTradePlan(raw) {
  const errors = [];

  // ── Parse if string ──
  let plan;
  if (typeof raw === 'string') {
    // Try to extract JSON from markdown fences or raw text
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      return { valid: false, errors: ['No JSON object found in output'] };
    }
    try {
      plan = JSON.parse(jsonMatch[1].trim());
    } catch (err) {
      return { valid: false, errors: [`JSON parse error: ${err.message}`] };
    }
  } else {
    plan = raw;
  }

  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    return { valid: false, errors: ['Output is not a JSON object'] };
  }

  // ── Required fields ──
  for (const field of schema.required) {
    if (!(field in plan)) {
      errors.push(`Missing required field: "${field}"`);
    }
  }

  // ── Type & constraint checks ──
  if (plan.ticker !== undefined) {
    if (typeof plan.ticker !== 'string' || !/^[A-Z]{1,5}$/.test(plan.ticker)) {
      errors.push('ticker must be 1-5 uppercase letters');
    }
  }

  if (plan.direction !== undefined) {
    if (!['LONG', 'SHORT', 'NO_TRADE'].includes(plan.direction)) {
      errors.push('direction must be LONG, SHORT, or NO_TRADE');
    }
  }

  if (plan.confidence !== undefined) {
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(plan.confidence)) {
      errors.push('confidence must be LOW, MEDIUM, or HIGH');
    }
  }

  if (plan.reasoning !== undefined) {
    if (typeof plan.reasoning !== 'string' || plan.reasoning.length < 10) {
      errors.push('reasoning must be a string with at least 10 characters');
    }
  }

  for (const numField of ['entry', 'exit', 'stopLoss']) {
    if (plan[numField] !== undefined && plan[numField] !== null) {
      if (typeof plan[numField] !== 'number') {
        errors.push(`${numField} must be a number or null`);
      }
    }
  }

  if (plan.timeframe !== undefined) {
    if (!['intraday', 'swing', 'position'].includes(plan.timeframe)) {
      errors.push('timeframe must be intraday, swing, or position');
    }
  }

  if (plan.dataUsed !== undefined) {
    if (!Array.isArray(plan.dataUsed) || plan.dataUsed.length === 0) {
      errors.push('dataUsed must be a non-empty array of strings');
    }
  }

  // ── Conditional: NO_TRADE requires missingFields ──
  if (plan.direction === 'NO_TRADE') {
    if (!Array.isArray(plan.missingFields) || plan.missingFields.length === 0) {
      errors.push('NO_TRADE plans must include non-empty missingFields array');
    }
  }

  // ── No extra fields ──
  const allowed = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(plan)) {
    if (!allowed.has(key)) {
      errors.push(`Unexpected field: "${key}"`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, plan };
}

module.exports = { validateTradePlan, ValidationError };
