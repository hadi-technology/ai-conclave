/**
 * The one error type crossing the engine seam. Carries a stable code, a human
 * message, and a `hint` (what to do next) that the UI renders directly — mirrors
 * the engine's own error envelope so the extension never scrapes stderr.
 */
export class EngineError extends Error {
  readonly code: string;
  readonly hint: string | null;

  constructor(code: string, message: string, hint: string | null = null) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.hint = hint;
  }

  /** One-line, user-facing string: "message — hint". */
  toDisplay(): string {
    return this.hint ? `${this.message} — ${this.hint}` : this.message;
  }
}
