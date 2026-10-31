// Vercel entry point. vercel.json routes every /api/* request here, and the Express app handles
// it with the original URL. Locally, server/index.ts serves the same app instead.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp, type WebChatApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

// Created once per function instance and reused by later requests to it.
let ready: Promise<WebChatApp> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= createApp(loadConfig()).catch((error: unknown) => {
    ready = undefined; // try again on the next request
    throw error;
  });
  try {
    const { app } = await ready;
    app(req, res);
  } catch (error) {
    console.error('WebChat failed to start', error);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'The server cannot reach its database. Try again in a minute.' }));
  }
}
