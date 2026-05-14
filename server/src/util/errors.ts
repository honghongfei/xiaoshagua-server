export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = 'AppError';
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
