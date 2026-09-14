/**
 * Uniform API error shape: { error: { code, message, details? } }.
 *
 * ApiError is thrown from routes/helpers and mapped by the central error
 * handler registered in app.ts. Zod issues are converted to a secret-free
 * details payload (path + message + code only — never the received value).
 */
import { z } from 'zod';

export type ApiErrorCode =
    | 'VALIDATION_ERROR'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RUN_ALREADY_ACTIVE'
    | 'RUN_NOT_CANCELLABLE'
    | 'RUN_NOT_RETRYABLE'
    | 'SCAN_HAS_ACTIVE_RUN'
    | 'SCAN_DISABLED'
    | 'PROFILE_NOT_FOUND'
    | 'INTERNAL';

export class ApiError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: ApiErrorCode,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

export function notFound(message: string): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
}

export function conflict(code: ApiErrorCode, message: string, details?: unknown): ApiError {
    return new ApiError(409, code, message, details);
}

/** Zod issue projection — deliberately excludes `received`/`expected` values. */
export interface ValidationIssue {
    path: string;
    message: string;
    code: string;
}

export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
    return error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
    }));
}

/**
 * Validates `value` against a Zod schema; on failure throws
 * ApiError(400, VALIDATION_ERROR) with secret-free issue details.
 * `undefined` bodies are treated as {} so required-field messages surface.
 */
export function parseWith<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
    const result = schema.safeParse(value ?? {});
    if (!result.success) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'request validation failed', {
            issues: toValidationIssues(result.error),
        });
    }
    return result.data as z.infer<S>;
}
