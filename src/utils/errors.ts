export const ErrorCodes = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  PARSE_ERROR: 'PARSE_ERROR',
  GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
  DIRTY_WORKTREE: 'DIRTY_WORKTREE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  RESTORE_CONFLICT: 'RESTORE_CONFLICT',
  INVALID_STATE: 'INVALID_STATE',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  UNKNOWN_OPTION: 'UNKNOWN_OPTION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class VibeguardError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'VibeguardError';
    this.code = code;
    this.details = details;
  }
}

export function getExitCode(code: ErrorCode): number {
  switch (code) {
    case ErrorCodes.UNKNOWN_COMMAND:
    case ErrorCodes.UNKNOWN_OPTION:
      return 2;
    case ErrorCodes.INTERNAL_ERROR:
      return 3;
    default:
      return 1;
  }
}

export const SCHEMA_VERSION = '1.0.0';

export interface ErrorJsonOutput {
  schemaVersion: string;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function formatErrorJson(error: VibeguardError): ErrorJsonOutput {
  return {
    schemaVersion: SCHEMA_VERSION,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export function formatErrorTerminal(error: VibeguardError): string {
  return `Error [${error.code}]: ${error.message}`;
}
