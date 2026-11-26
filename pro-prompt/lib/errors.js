// Shared failure shape for the host half.
//
// Every user-visible error carries a stable code and an HTTP status. Messages
// may name a model or an action, but must never contain an API key, an
// Authorization header, or a full filesystem path.

export class ProPromptError extends Error {
  constructor(message, code = 'PRO_PROMPT_FAILED', status = 502) {
    super(message);
    this.name = 'ProPromptError';
    this.code = code;
    this.status = status;
  }
}

/** Keep a short, path-free, credential-free message for the browser. */
export function safeMessage(value, max = 300) {
  return redactSecrets(value).replace(/[A-Za-z]:[\\/][^\s'"]+/g, '[path]').slice(0, max);
}

/** Remove anything that looks like an API key or bearer token. */
export function redactSecrets(value, max = 300) {
  return String(value ?? '')
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, '[key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [key]')
    .slice(0, max);
}
