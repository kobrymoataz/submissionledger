export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export class InputError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export class ConflictError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
