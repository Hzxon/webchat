// JSON-RPC 2.0 over lines, which the MCP servers (answer.ts, approve.ts) and the ACP client
// (acp.ts) all speak: each message is one line, and either side may ask.
import type { Readable, Writable } from 'node:stream';
import readline from 'node:readline';
import { messageOf } from './runs.ts';

/** An error the other side answered with. */
export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Message = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

export interface PeerOptions {
  input: Readable;
  output: Writable;
  /** Answers a request from the other side; what it throws goes back as an error, `-32601` unless it is an `RpcError`. */
  handle?: (method: string, params: any) => Promise<unknown>;
  /** Takes a message that asks nothing, such as notifications/initialized. */
  notified?: (method: string, params: any) => void;
  /** Runs when the input ends. */
  closed?: () => void;
}

/** One end of a connection. */
export class Peer {
  private next = 1;
  private waiting = new Map<number | string, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  private output: Writable;

  constructor({ input, output, handle, notified, closed }: PeerOptions) {
    this.output = output;
    readline.createInterface({ input }).on('line', (line) => {
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        return;
      }
      if (message.method !== undefined) {
        if (message.id === undefined) return notified?.(message.method, message.params);
        const id = message.id;
        (handle?.(message.method, message.params) ?? Promise.reject(new Error(`Unknown method ${message.method}.`))).then(
          (result) => this.send({ id, result: result ?? null }),
          (error: unknown) => this.send({ id, error: { code: error instanceof RpcError ? error.code : -32601, message: messageOf(error) } }),
        );
      } else if (message.id !== undefined) {
        const call = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) call?.reject(new RpcError(message.error.code, message.error.message));
        else call?.resolve(message.result);
      }
    })
      .on('close', () => closed?.())
      // On Linux a child's pipes are socket pairs, so one that exits with output unread resets them,
      // and readline passes the failed read on; the exit says why.
      .on('error', () => undefined);
    // A peer that exits before it reads closes the pipe; its exit says why.
    this.output.on('error', () => undefined);
  }

  /** Fails every request still waiting, with the reason the other side is gone. */
  fail(error: Error) {
    for (const call of this.waiting.values()) call.reject(error);
    this.waiting.clear();
  }

  private send(message: object) {
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  notify(method: string, params?: object) {
    this.send({ method, params });
  }

  request<T = any>(method: string, params: object) {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
}

/** What an MCP server answers `initialize` with. */
export const mcpInit = (params: { protocolVersion?: string } = {}, listChanged = false) => ({
  protocolVersion: params.protocolVersion ?? '2025-06-18',
  capabilities: { tools: listChanged ? { listChanged } : {} },
  serverInfo: { name: 'webchat', version: '1' },
});
