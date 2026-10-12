import { type CanActivate, createParamDecorator, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { Request, Response } from "express";
import { CONFIG } from "../../common/tokens";
import { unauthenticated } from "../../common/errors";
import type { ServerConfig } from "../../config";
import { readCookie, SESSION_COOKIE, setSessionCookie } from "./cookies";
import { type AuthContext, SESSION_TTL_MS, SessionsService } from "./sessions.service";

type AuthedRequest = Request & { auth?: AuthContext };

/** Requires a valid session cookie and attaches the session to the request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionsService,
    @Inject(CONFIG) private readonly config: ServerConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const auth = token ? await this.sessions.resolve(token) : undefined;
    if (!token || !auth) throw unauthenticated();
    if (auth.refreshed) setSessionCookie(context.switchToHttp().getResponse<Response>(), token, SESSION_TTL_MS, this.config.secureCookies);
    req.auth = auth;
    return true;
  }
}

/** The authenticated session. Only valid on routes behind AuthGuard. */
export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw unauthenticated();
  return auth;
});
