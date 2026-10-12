// Cross-platform test runner: migrates + seeds an isolated test DB, then runs bun test.
// Never touches dev.db (helpers.ts additionally refuses non-test DATABASE_URLs).
process.env["DATABASE_URL"] = "file:./test.db";

await Bun.$`bunx prisma migrate deploy`;
await Bun.$`bun run prisma/seed-test.ts`;
await Bun.$`bun test`;
