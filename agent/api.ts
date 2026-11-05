// Requests to /api from Node (R-027). The page's api.ts relies on the browser for the cookie
// jar, the origin and the account check; this one keeps the session cookie itself and takes the
// server's URL. Both read answers by the same rule (D-056).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** How long a request waits for its answer to start (D-077). */
const ANSWER_TIMEOUT_MS = 60_000;

export class Api {
  constructor(
    readonly baseUrl: string,
    /** The cookies the server set, as a Cookie header: the session, and the device mark of D-080. */
    public cookie = '',
  ) {
    // A sign-in sends the login key, so it never travels in the clear, except on this machine (K-47).
    // Every name under .localhost is this machine too, such as alice.localhost in AGENTS.md (K-48).
    const { protocol, hostname } = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');
    if (protocol !== 'https:' && !local) {
      throw new Error(`Use the https:// address of the server, not ${baseUrl}.`);
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie: this.cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError(0, 'Cannot reach the server.');
    }
    // Like a browser, a new cookie replaces the one of the same name and leaves the others.
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0]!;
      const name = pair.slice(0, pair.indexOf('=') + 1);
      this.cookie = [...this.cookie.split('; ').filter((c) => c && !c.startsWith(name)), pair].join('; ');
    }
    if (res.status === 204) return undefined as T;
    let data: { error?: string; code?: string };
    try {
      data = (await res.json()) as { error?: string; code?: string };
    } catch {
      if (res.ok) throw new ApiError(res.status, 'The server answer broke off.');
      data = {};
    }
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`, data.code);
    return data as T;
  }
}
