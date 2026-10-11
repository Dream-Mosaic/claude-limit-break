// Limit Break's Claude Code mod: the pure half, shared with the extension's node tests (test/modControl.test.ts).
// Plain ECMAScript: the mod runs with no Node APIs, and only `$` reaches outside it (register.mjs).

/** The status file's and control file's protocol; the extension uses the mod only on the same major. */
export const PROTOCOL = 1;
export const MOD_VERSION = '1.1.0';
/** Starts the body of a control message: `[limit-break-control v1] {"jobId","nonce","prompt"}`. */
export const CONTROL_MARKER = '[limit-break-control v1]';
const MAX_CONTINUED = 20;

/** @param {string} home @param {string} sessionId */
export function statusPath(home, sessionId) {
  return `${home}/.limit-break/sessions/${sessionId}.json`;
}

/** @param {string} home @param {string} sessionId */
export function controlPath(home, sessionId) {
  return `${home}/.limit-break/control/${sessionId}.json`;
}

const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

/**
 * Find a control message in a delivery's text (the envelope around it included). The JSON runs from the marker to the end of its line.
 * @param {string} text
 */
export function parseControl(text) {
  const at = text.indexOf(CONTROL_MARKER);
  if (at < 0) {
    return { kind: 'none' };
  }
  const rest = text.slice(at + CONTROL_MARKER.length);
  const line = rest.split('\n')[0].trim();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: 'its payload is not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || !nonEmpty(parsed.jobId) || !nonEmpty(parsed.nonce) || !nonEmpty(parsed.prompt)) {
    return { kind: 'invalid', reason: 'its payload lacks jobId, nonce or prompt' };
  }
  return { kind: 'control', jobId: parsed.jobId, nonce: parsed.nonce, prompt: parsed.prompt };
}

/**
 * Whether a control message may act: the extension's control file (which only it writes) must hold an unexpired entry with this job and nonce, and the job must not have been continued already.
 * @param {{ jobId: string, nonce: string }} control
 * @param {string | undefined} controlFileText
 * @param {{ continued: { jobId: string }[] }} status
 * @param {number} nowMs
 */
export function acceptControl(control, controlFileText, status, nowMs) {
  if (status.continued.some((c) => c.jobId === control.jobId)) {
    return { ok: false, reason: `job ${control.jobId} was already continued` };
  }
  if (controlFileText === undefined) {
    return { ok: false, reason: 'there is no control file for this session' };
  }
  let file;
  try {
    file = JSON.parse(controlFileText);
  } catch {
    return { ok: false, reason: 'the control file is not JSON' };
  }
  const entries = file && file.protocol === PROTOCOL && Array.isArray(file.entries) ? file.entries : [];
  const match = entries.find((e) => e && e.jobId === control.jobId && e.nonce === control.nonce);
  if (!match) {
    return { ok: false, reason: 'no matching entry in the control file' };
  }
  if (!(typeof match.expiresAtMs === 'number' && match.expiresAtMs > nowMs)) {
    return { ok: false, reason: 'its control entry has expired' };
  }
  return { ok: true };
}

/**
 * A fresh status for this process and session. `previous` (the file as last written, parsed) keeps its `continued` list when it is the same session, so a reload of the mod can't continue a job twice.
 */
export function initialStatus(fields, previous) {
  const continued = previous && previous.sessionId === fields.sessionId && Array.isArray(previous.continued) ? previous.continued : [];
  return {
    protocol: PROTOCOL,
    modVersion: MOD_VERSION,
    sessionId: fields.sessionId,
    cwd: fields.cwd,
    ...(fields.entrypoint ? { entrypoint: fields.entrypoint } : {}),
    loadedAtMs: fields.loadedAtMs,
    rateLimits: [],
    continued,
  };
}

/** @param {string} text */
export function parseStatus(text) {
  try {
    const s = JSON.parse(text);
    return s && typeof s === 'object' && typeof s.sessionId === 'string' && Array.isArray(s.continued) ? s : undefined;
  } catch {
    return undefined;
  }
}

export function withRateLimits(status, rateLimits, atMs) {
  return { ...status, rateLimits, rateLimitsAtMs: atMs };
}

export function withStopFailure(status, error, atMs) {
  return { ...status, lastStopFailure: { error: String(error), atMs } };
}

export function withNativeContinue(status, type, atMs) {
  return { ...status, nativeContinue: { type: String(type), atMs } };
}

export function withContinued(status, jobId, atMs) {
  return { ...status, continued: [...status.continued, { jobId, atMs }].slice(-MAX_CONTINUED) };
}

/** The process moved to another session (/clear, resume, fork). The file can't be deleted ($.fs has no delete), so it says where the process went; the extension reads it as absent. */
export function movedTo(status, newSessionId) {
  return { ...status, movedTo: newSessionId };
}
