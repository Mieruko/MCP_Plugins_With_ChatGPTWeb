// Bounded UI diagnostics only: never attach raw desktop text or typed values.
export class ComputerUiError extends Error {
  constructor(public code: string, message: string, public diagnostics: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "ComputerUiError";
  }
}
