import { app } from "./app";
import { config } from "./config/index";
import { logger } from "./common/logger";
import { relayOutbox } from "./infrastructure/queue/queue";
import { runOverdueJob } from "./modules/collections/service";

const MAX_PORT_ATTEMPTS = 20;

// Outbox relay ticker (simplified transactional outbox worker)
setInterval(() => {
  relayOutbox().catch((e) => logger.error({ err: String(e) }, "outbox relay failed"));
}, 2000);

// Overdue scheduler (every 60s; admin can also trigger manually)
setInterval(() => {
  runOverdueJob().catch((e) => logger.error({ err: String(e) }, "overdue job failed"));
}, 60_000);

/**
 * Start on the configured port (default 9256). If it is already in use,
 * walk upward (9257, 9258, …) so `bun run src/server.ts` just works.
 */
function listen(startPort: number) {
  let port = startPort;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      const server = Bun.serve({ port, fetch: app.fetch });
      if (port !== startPort) {
        logger.warn({ requestedPort: startPort, port }, "requested port busy, using next free port");
      }
      logger.info({ port: server.port }, "lending backend listening (bun)");
      return server;
    } catch (e) {
      if (!isAddrInUse(e) || attempt === MAX_PORT_ATTEMPTS - 1) throw e;
      port++;
    }
  }
  throw new Error("unreachable");
}

function isAddrInUse(e: unknown): boolean {
  const err = e as { message?: unknown; code?: unknown; syscall?: unknown };
  if (err?.code === "EADDRINUSE") return true;
  const msg = String(err?.message ?? e);
  return msg.includes("EADDRINUSE") || msg.includes("address already in use") || msg.includes("Is port");
}

export const server = listen(config.port);
