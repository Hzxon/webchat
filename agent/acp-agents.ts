// The ACP agents WebChat runs, and the only place a command for one comes from (docs/decisions/acp-adapter.md).
// Nothing takes a command from a request, a setup choice or a file, so an agent that is not here is
// never linked or run. An entry is added in its own pull request, after someone runs the agent for
// real and fills in both dated checks.

export interface AcpAgent {
  /** What `webchat-agent link` takes: lower case letters, digits and dashes. */
  id: string;
  /** Its name for the owner, such as in Settings, `linked` and a request's `harness`. */
  name: string;
  /** A file name that the finder looks up in its folders: never a path, and never a launcher such as npx, which would run an unpinned package. */
  program: string;
  /** What makes it speak ACP on stdio. */
  args: string[];
  /** What makes it skip the owner's own settings and MCP servers, which ACP cannot turn off. Required: an agent that always loads them is not listed. */
  isolation: { args: string[]; env: Record<string, string>; checked: string };
  /** What prints its version, `--version` when left out. */
  version?: string[];
  /** The first version that speaks what the adapter needs. */
  min: string;
  /** Variables it may keep for its own sign-in; every other credential in the environment is taken out. */
  login?: string[];
  /** 'YYYY-MM-DD: the command run and what it printed'. */
  checked: string;
}

/** Empty until an agent has been run for real (docs/decisions/acp-adapter.md). */
export const ACP_AGENTS: readonly AcpAgent[] = [];
