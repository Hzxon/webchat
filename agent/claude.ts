// The plugin's background Claude (R-035, D-097): a `claude -p` the plugin starts for each turn of a
// conversation, apart from the owner's own sessions. It runs restricted, so it reads only managed
// settings and the plugin's settings file: none of the owner's settings, and none of the
// repository's settings, hooks or .mcp.json, which a -p run otherwise loads without asking. The
// message goes on stdin, since arguments show in `ps`, and the turn ends with a JSON answer.

/** The only host the shell reaches, for installs (D-097). */
const REGISTRY = 'registry.npmjs.org';

/** Its tools. A restricted run has only those it names, and keeps its file tools in its folder. */
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/** Whether a variable holds a credential: by its name, by a known token's prefix, or by a password in a URL. */
const isCredential = ([name, value = '']: [string, string | undefined]) =>
  /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH/i.test(name) ||
  /^(gh[opsur]_|github_pat_|npm_|sk-|xox[abprs]-|glpat-|AKIA)|:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);

/**
 * The plugin's settings file for it. The shell never runs outside the sandbox, not even where the
 * sandbox cannot start. It reads nothing outside its working directories but what toolchains need:
 * not the secrets, and not the macOS keychain, where gh keeps the owner's token (K-54). npm reads
 * no config of the owner's, which may hold a publish token, and keeps a cache of its own: the
 * sandbox cannot write the owner's, and a shared one would let it poison the owner's installs. Web
 * search and reading run outside the sandbox, as Claude Code's own tools. The shell gets no variable
 * of `env`, the environment it starts with, that holds a credential, while Claude Code keeps them for
 * its own login. The guard hook keeps the file tools from the secrets, and Claude Code refuses a
 * write through a link out of the folder. When the owner chose no AI attribution, empty lines hide
 * the ones Claude Code adds to commits and pull requests (R-039).
 */
export function claudeSettings({ secrets, npmCache, guard, env, noAttribution }: { secrets: string[]; npmCache: string; guard: string; env: NodeJS.ProcessEnv; noAttribution?: boolean }) {
  return {
    // Only the object form: older Claude Code rejects `false` here, and a -p run drops a whole
    // settings file that fails validation, the sandbox with it (D-097).
    ...(noAttribution && { attribution: { commit: '', pr: '' } }),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: secrets, allowWrite: [npmCache] },
      network: { allowedDomains: [REGISTRY] },
      // Named one by one: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB makes every sandboxed command ask first,
      // and nobody is there to answer.
      credentials: { envVars: Object.entries(env).filter(isCredential).map(([name]) => ({ name, mode: 'deny' })) },
    },
    permissions: { allow: ['WebSearch', 'WebFetch'], blockReadsOutsideWorkingDirectories: true },
    env: { npm_config_cache: npmCache, npm_config_userconfig: '/dev/null' },
    hooks: { PreToolUse: [{ matcher: '^(Read|Edit|Write|Glob|Grep)$', hooks: [{ type: 'command', command: guard }] }] },
  };
}

/**
 * One turn's arguments: the first starts the session under its id, a later one resumes it. With
 * the owner's choice (R-039), their CLAUDE.md goes in as a system prompt, and `skills` is a plugin
 * folder made for the turn, which holds only copies of their skills. It is also a working
 * directory, so a skill's scripts and references can be read there.
 */
export function claudeArgs({ settings, session, resume, answer, claudeMd, skills }: { settings: string; session: string; resume: boolean; answer: object; claudeMd?: string; skills?: string }) {
  return [
    '-p',
    'Do what the message on stdin asks.',
    '--restricted',
    '--tools',
    [...TOOLS, ...(skills ? ['Skill'] : [])].join(','),
    '--settings',
    settings,
    ...(claudeMd ? ['--append-system-prompt-file', claudeMd] : []),
    ...(skills ? ['--plugin-dir', skills, '--add-dir', skills] : []),
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
