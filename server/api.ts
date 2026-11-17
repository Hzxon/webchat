import express, { type NextFunction, type Request, type Response } from 'express';
import { HttpError } from './api/helpers.js';
import { createContext, type ApiDeps } from './api/context.js';
import { authRoutes } from './api/auth.js';
import { syncRoutes } from './api/sync.js';
import { conversationsRoutes } from './api/conversations.js';
import { projectsRoutes } from './api/projects.js';
import { docsRoutes } from './api/docs.js';
import { messagesRoutes } from './api/messages.js';
import { pushRoutes } from './api/push.js';
import { barkRoutes } from './api/bark.js';
import { githubRoutes } from './api/github.js';

export function createApiRouter(deps: ApiDeps) {
  const router = express.Router();
  const context = createContext(deps);
  const { config } = context;

  authRoutes(router, context);
  syncRoutes(router, context);
  conversationsRoutes(router, context);
  projectsRoutes(router, context);
  docsRoutes(router, context);
  messagesRoutes(router, context);
  pushRoutes(router, context);
  barkRoutes(router, context);
  githubRoutes(router, context);

  router.use((_req, _res) => {
    throw new HttpError(404, 'Not found.');
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status ?? 500;
    if (status >= 500) config.logger.error('API error', error);
    const message = error instanceof HttpError || status < 500 ? (error as Error).message : 'Something went wrong.';
    res.status(status).json({ error: message, code: error instanceof HttpError ? error.code : undefined });
  });

  return router;
}

