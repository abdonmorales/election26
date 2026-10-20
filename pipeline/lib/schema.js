// Minimal JSON Schema validator (the subset our schemas use), so the pipeline has no dependencies.
// Supports: type, enum, const, required, properties, additionalProperties, patternProperties,
// items, minItems, maxItems, minimum, maximum, minLength, maxLength, pattern, format: date-time,
// anyOf, and local $ref into $defs.

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

export function validate(schema, value, root = schema, path = "$", errors = []) {
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const target = root.$defs?.[name];
    if (!target) { errors.push(`${path}: unknown $ref ${schema.$ref}`); return errors; }
    return validate(target, value, root, path, errors);
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(s, value, root, path, []).length === 0);
    if (!ok) errors.push(`${path}: does not match any allowed shape`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if ("const" in schema && schema.const !== value) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${path}: must be finite`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && !(ISO_RE.test(value) && !Number.isNaN(Date.parse(value)))) errors.push(`${path}: not an ISO date-time`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, root, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === "object") {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = `${path}.${key}`;
      if (schema.properties && key in schema.properties) {
        validate(schema.properties[key], v, root, sub, errors);
        continue;
      }
      const pp = schema.patternProperties && Object.entries(schema.patternProperties).find(([re]) => new RegExp(re).test(key));
      if (pp) {
        validate(pp[1], v, root, sub, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      } else if (typeof schema.additionalProperties === "object") {
        validate(schema.additionalProperties, v, root, sub, errors);
      }
    }
  }
  return errors;
}
