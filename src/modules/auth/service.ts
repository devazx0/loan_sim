import { prisma } from "../../infrastructure/database/prisma";
import { ConflictError, UnauthorizedError, ValidationError } from "../../common/errors";
import { hashPassword, verifyPassword, signAccessToken, newRefreshToken } from "../../common/middleware";
import { sha256 } from "../../common/crypto";
import { audit, AUDIT_ACTIONS } from "../../common/audit";
import { queue } from "../../infrastructure/queue/queue";
import { stageEvent } from "../../common/events";
import type { RegisterInput, LoginInput } from "./dto";
import { config } from "../../config/index";

function toUserDto(u: { publicId: string; email: string; phone: string; role: string; status: string }) {
  return { id: u.publicId, email: u.email, phone: u.phone, role: u.role, status: u.status };
}

export async function register(input: RegisterInput, ctx: { ip?: string; ua?: string; requestId?: string }) {
  const existing = await prisma.user.findFirst({ where: { OR: [{ email: input.email }, { phone: input.phone }] } });
  if (existing) throw new ConflictError("Email or phone already registered");
  const passwordHash = await hashPassword(input.password);
  const { user, msg } = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: { email: input.email, phone: input.phone, passwordHash, role: "CUSTOMER", status: "ACTIVE" },
    });
    await tx.customerProfile.create({
      data: { userId: u.id, firstName: input.firstName, lastName: input.lastName },
    });
    const staged = await stageEvent(tx, "customer.registered", u.publicId, { userId: u.publicId, email: input.email });
    return { user: u, msg: staged };
  });
  const tokens = await issueTokens(user.id, ctx);
  await audit({ actor: user.publicId, actorRole: "CUSTOMER", action: AUDIT_ACTIONS.USER_REGISTER, resource: "user", resourceId: user.publicId, requestId: ctx.requestId, userId: user.id });
  await queue.publish(msg);
  return { user: toUserDto(user), ...tokens };
}

export async function login(input: LoginInput, ctx: { ip?: string; ua?: string; requestId?: string }) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) throw new UnauthorizedError("Invalid credentials");
  if (user.status !== "ACTIVE") throw new UnauthorizedError("Account suspended");
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) throw new UnauthorizedError("Invalid credentials");
  const tokens = await issueTokens(user.id, ctx);
  await audit({ actor: user.publicId, actorRole: user.role, action: AUDIT_ACTIONS.USER_LOGIN, resource: "user", resourceId: user.publicId, requestId: ctx.requestId, userId: user.id });
  return { user: toUserDto(user), ...tokens };
}

async function issueTokens(userId: number, ctx: { ip?: string; ua?: string }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const accessToken = await signAccessToken({ userId: user.id, userPublicId: user.publicId, role: user.role as never, email: user.email });
  const { token, hash } = newRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 3600 * 1000);
  await prisma.session.create({ data: { userId: user.id, refreshHash: hash, expiresAt, ipAddress: ctx.ip, userAgent: ctx.ua } });
  return { accessToken, refreshToken: token, expiresIn: config.accessTokenTtlSec };
}

export async function refresh(refreshToken: string) {
  if (!refreshToken) throw new ValidationError("refreshToken required");
  const hash = sha256(refreshToken);
  const session = await prisma.session.findUnique({ where: { refreshHash: hash }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw new UnauthorizedError("Invalid refresh token");
  if (session.user.status !== "ACTIVE") throw new UnauthorizedError("Account suspended");
  // rotate
  const { token, hash: newHash } = newRefreshToken();
  await prisma.$transaction([
    prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }),
    prisma.session.create({ data: { userId: session.userId, refreshHash: newHash, expiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 24 * 3600 * 1000) } }),
  ]);
  const accessToken = await signAccessToken({ userId: session.user.id, userPublicId: session.user.publicId, role: session.user.role as never, email: session.user.email });
  return { accessToken, refreshToken: token, expiresIn: config.accessTokenTtlSec };
}

export async function logout(refreshToken: string): Promise<void> {
  const hash = sha256(refreshToken);
  await prisma.session.updateMany({ where: { refreshHash: hash, revokedAt: null }, data: { revokedAt: new Date() } });
}

