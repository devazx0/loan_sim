import { prisma } from "../../infrastructure/database/prisma";
import { NotFoundError, ValidationError } from "../../common/errors";
import { MAX_MONEY_KOBO } from "../../common/money";
import { cache, productListKey, productKey, CACHE_TTLS } from "../../infrastructure/cache/memory-cache";
import type { ProductInput } from "./dto";

export function toProductDto(p: { publicId: string; code: string; name: string; description: string | null; minAmountKobo: number; maxAmountKobo: number; minTenorMonths: number; maxTenorMonths: number; interestRateBps: number; interestMethod: string; processingFeeKobo: number; lateFeeKobo: number; status: string }) {
  return { id: p.publicId, ...p };
}

export async function listActiveProducts() {
  const cached = await cache.get<ReturnType<typeof toProductDto>[]>(productListKey());
  if (cached) return cached;
  // select only needed columns (N+1 prevention: single query, no relations)
  const rows = await prisma.loanProduct.findMany({
    where: { status: "ACTIVE" },
    select: { publicId: true, code: true, name: true, description: true, minAmountKobo: true, maxAmountKobo: true, minTenorMonths: true, maxTenorMonths: true, interestRateBps: true, interestMethod: true, processingFeeKobo: true, lateFeeKobo: true, status: true },
    orderBy: { id: "asc" },
  });
  const dto = rows.map(toProductDto);
  await cache.set(productListKey(), dto, CACHE_TTLS.loanProducts);
  return dto;
}

export async function getProduct(publicId: string) {
  const cached = await cache.get<ReturnType<typeof toProductDto>>(productKey(publicId));
  if (cached) return cached;
  const p = await prisma.loanProduct.findUnique({ where: { publicId } });
  if (!p || p.status !== "ACTIVE") throw new NotFoundError("Loan product not found");
  const dto = toProductDto(p);
  await cache.set(productKey(publicId), dto, CACHE_TTLS.loanProduct);
  return dto;
}

export async function createProduct(input: ProductInput) {
  if (input.minAmountKobo > input.maxAmountKobo) throw new ValidationError("minAmount > maxAmount");
  if (input.minTenorMonths > input.maxTenorMonths) throw new ValidationError("minTenor > maxTenor");
  if (input.maxAmountKobo > MAX_MONEY_KOBO) throw new ValidationError(`maxAmount exceeds monetary ceiling ${MAX_MONEY_KOBO}`);
  const p = await prisma.loanProduct.create({ data: { ...input, description: input.description ?? null } });
  await cache.del(productListKey());
  return toProductDto(p);
}

export async function updateProduct(publicId: string, input: Partial<ProductInput>) {
  const p = await prisma.loanProduct.findUnique({ where: { publicId } });
  if (!p) throw new NotFoundError("Loan product not found");
  const updated = await prisma.loanProduct.update({ where: { publicId }, data: { ...input } });
  await cache.del(productListKey());
  await cache.del(productKey(publicId));
  return toProductDto(updated);
}

