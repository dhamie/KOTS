import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { ApiErrorBody, ErrorCode } from "@kots/shared";
import { ThrottlerException } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { AppError } from "./errors";
import { requestIdOf } from "./request-id.middleware";

const STATUS_CODES: Record<number, ErrorCode> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
};

/** Turns every error into `{ code, message, details?, correlationId }`. Unexpected errors are logged and hidden. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("HTTP");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const correlationId = requestIdOf(req);

    let status = 500;
    let body: ApiErrorBody = { code: "INTERNAL", message: "Something went wrong.", correlationId };

    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, details: exception.details, correlationId };
    } else if (exception instanceof ThrottlerException) {
      status = 429;
      body = { code: "RATE_LIMITED", message: "Too many requests. Try again later.", correlationId };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = { code: STATUS_CODES[status] ?? "INTERNAL", message: exception.message, correlationId };
    } else if (isBodyParserError(exception)) {
      status = exception.status;
      body = { code: STATUS_CODES[status] ?? "VALIDATION_FAILED", message: "Invalid request body.", correlationId };
    }

    if (status >= 500) this.logger.error(`[${correlationId}] ${req.method} ${req.url}`, (exception as Error)?.stack ?? exception);
    res.status(status).json(body);
  }
}

/** Errors thrown by express's JSON body parser (malformed JSON, too large). */
function isBodyParserError(e: unknown): e is { status: number; type: string } {
  return typeof e === "object" && e !== null && "type" in e && "status" in e && typeof (e as { status: unknown }).status === "number";
}
