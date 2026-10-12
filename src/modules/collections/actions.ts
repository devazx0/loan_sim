import { prisma } from "../../infrastructure/database/prisma";
import { NotFoundError } from "../../common/errors";
import { audit } from "../../common/audit";

export async function addCollectionAction(admin: { userPublicId: string; role: string }, casePublicId: string, action: string, note: string | undefined, ctx: { requestId?: string }) {
  const kase = await prisma.collectionCase.findUnique({ where: { publicId: casePublicId } });
  if (!kase) throw new NotFoundError("Collection case not found");
  const valid = ["REMINDER_SENT", "EMAIL_SENT", "SMS_SIMULATED", "CALL_ATTEMPT", "PAYMENT_PROMISE", "ESCALATED"];
  if (!valid.includes(action)) throw new NotFoundError("Invalid action");
  const row = await prisma.collectionAction.create({ data: { caseId: kase.id, action, note: note ?? null, actor: admin.userPublicId } });
  if (action === "ESCALATED") await prisma.collectionCase.update({ where: { id: kase.id }, data: { status: "ESCALATED" } });
  await audit({ actor: admin.userPublicId, actorRole: admin.role, action: `COLLECTION_${action}`, resource: "collection-case", resourceId: kase.publicId, requestId: ctx.requestId });
  return { id: row.id, action: row.action, createdAt: row.createdAt };
}

export async function listCollectionCases(opts: { limit: number; cursorId?: number }) {
  const items = await prisma.collectionCase.findMany({
    orderBy: { id: "asc" }, take: opts.limit + 1,
    ...(opts.cursorId ? { cursor: { id: opts.cursorId }, skip: 1 } : {}),
    select: { id: true, publicId: true, loanId: true, daysOverdue: true, outstandingKobo: true, riskLevel: true, status: true, createdAt: true },
  });
  const hasMore = items.length > opts.limit;
  const page = hasMore ? items.slice(0, opts.limit) : items;
  return { items: page.map((c) => ({ id: c.publicId, daysOverdue: c.daysOverdue, outstandingKobo: c.outstandingKobo, riskLevel: c.riskLevel, status: c.status, createdAt: c.createdAt })), nextCursor: hasMore ? String(page[page.length - 1]!.id) : null };
}

