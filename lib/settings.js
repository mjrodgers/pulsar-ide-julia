// Pure helpers: turn Pulsar package settings into a JETLS settings object.
// JETLS reads settings (file `.JETLSConfig.toml` > editor config > defaults), so we
// only send values that differ from JETLS's defaults and let the project file win.
const DEFAULTS = { autoInstantiate: "prompt", debounce: 1.0, formatter: "Runic" };

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Objects merge recursively; arrays and scalars from `extra` replace those in `base`.
function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

function parseJsonObject(text, label) {
  if (text === undefined || text === null || String(text).trim() === "") return { value: {}, error: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { value: {}, error: `${label} is not valid JSON: ${e.message}` };
  }
  if (!isPlainObject(parsed)) return { value: {}, error: `${label} must be a JSON object` };
  return { value: parsed, error: null };
}

// `config` is the `pulsar-ide-julia.server` settings group.
function buildJetlsSettings(config = {}) {
  const errors = [];
  const base = {};

  const fullAnalysis = {};
  if (config.autoInstantiate && config.autoInstantiate !== DEFAULTS.autoInstantiate) {
    fullAnalysis.auto_instantiate = config.autoInstantiate;
  }
  if (typeof config.debounce === "number" && config.debounce !== DEFAULTS.debounce) {
    fullAnalysis.debounce = config.debounce;
  }
  if (Object.keys(fullAnalysis).length) base.full_analysis = fullAnalysis;
  if (config.formatter && config.formatter !== DEFAULTS.formatter) base.formatter = config.formatter;

  const extra = parseJsonObject(config.settingsJson, "Additional JETLS settings");
  if (extra.error) errors.push(extra.error);

  return { settings: deepMerge(base, extra.value), errors };
}

module.exports = { DEFAULTS, deepMerge, parseJsonObject, buildJetlsSettings };
