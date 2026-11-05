// The plugin's background Claude (R-035, D-097): a `claude -p` the plugin starts for each turn of a
// conversation, apart from the owner's own sessions. It runs restricted, so it reads only managed
// settings and the plugin's settings file: none of the owner's settings, and none of the
// repository's settings, hooks or .mcp.json, which a -p run otherwise loads without asking. The
// message goes on stdin, since arguments show in `ps`, and the turn ends with a JSON answer.

/** The only host the shell reaches, for installs (D-097). */
const REGISTRY = 'registry.npmjs.org';

/** Its tools. A restricted run has only those it names, and keeps its file tools in its folder. */
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/**
 * The plugin's settings file for it. The shell never runs outside the sandbox, not even where the
 * sandbox cannot start. It reads nothing outside its working directories but what toolchains need:
 * not the secrets, and not the macOS keychain, where gh keeps the owner's token (K-54). npm reads
 * no config of the owner's, which may hold a publish token, and keeps a cache of its own: the
 * sandbox cannot write the owner's, and a shared one would let it poison the owner's installs. Web
 * search and reading run outside the sandbox, as Claude Code's own tools. The guard hook keeps the
 * file tools from the secrets, and Claude Code refuses a write through a link out of the folder.
 */
export function claudeSettings({ secrets, npmCache, guard }: { secrets: string[]; npmCache: string; guard: string }) {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: secrets, allowWrite: [npmCache] },
      network: { allowedDomains: [REGISTRY] },
    },
    permissions: { allow: ['WebSearch', 'WebFetch'], blockReadsOutsideWorkingDirectories: true },
    env: { npm_config_cache: npmCache, npm_config_userconfig: '/dev/null' },
    hooks: { PreToolUse: [{ matcher: '^(Read|Edit|Write|Glob|Grep)$', hooks: [{ type: 'command', command: guard }] }] },
  };
}

/** One turn's arguments: the first starts the session under its id, a later one resumes it. */
export function claudeArgs({ settings, session, resume, answer }: { settings: string; session: string; resume: boolean; answer: object }) {
  return [
    '-p',
    'Do what the message on stdin asks.',
    '--restricted',
    '--tools',
    TOOLS.join(','),
    '--settings',
    settings,
    // No MCP server at all, not even those of the owner's plugins.
    '--strict-mcp-config',
    // Edits in its folder pass, but not to Claude Code's own files there, such as .claude/settings.json:
    // those ask, and anything that would ask is refused, since nobody is there to answer.
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(answer),
    resume ? '--resume' : '--session-id',
    session,
  ];
}
