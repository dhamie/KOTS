import { Body, Controller, HttpCode, Inject, Post, Res, UseGuards } from "@nestjs/common";
import { LoginRequest, RegisterRequest } from "@kots/shared";
import type { Response } from "express";
import { AuthRateLimited } from "../../common/rate-limit";
import { CONFIG } from "../../common/tokens";
import { ZodPipe } from "../../common/zod.pipe";
import type { ServerConfig } from "../../config";
import { AccountsService } from "./accounts.service";
import { Auth, AuthGuard } from "./auth.guard";
import { clearSessionCookie, setSessionCookie } from "./cookies";
import { type AuthContext, SESSION_TTL_MS, SessionsService } from "./sessions.service";

/** Register, log in, log out. The client calls GET /api/me afterwards for the account details. */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly sessions: SessionsService,
    @Inject(CONFIG) private readonly config: ServerConfig,
  ) {}

  @Post("register")
  @HttpCode(204)
  @AuthRateLimited()
  async register(@Body(new ZodPipe(RegisterRequest)) body: RegisterRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = await this.accounts.register(body.email, body.password, body.handle);
    setSessionCookie(res, token, SESSION_TTL_MS, this.config.secureCookies);
  }

  @Post("login")
  @HttpCode(204)
  @AuthRateLimited()
  async login(@Body(new ZodPipe(LoginRequest)) body: LoginRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = await this.accounts.login(body.email, body.password);
    setSessionCookie(res, token, SESSION_TTL_MS, this.config.secureCookies);
  }

  @Post("logout")
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.delete(auth.sessionId);
    clearSessionCookie(res, this.config.secureCookies);
  }
}
