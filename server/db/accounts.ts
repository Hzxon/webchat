import { type AccountKeysInput, PAIRING_TTL_MS, type PairingDTO, type PairingInput } from '../../shared/types.js';
import { randomBytes } from '../../shared/e2ee.js';
import type { Sql } from '../sql.js';
import { ATTENTION_TTL_MS, type PairingRow, type UserRow, one, toUserDTO } from './rows.js';
import type { Helpers } from './helpers.js';

export function accountsQueries(sql: Sql, { removeAccount }: Helpers) {
  return {

    /** Creates an account with its keys. Returns undefined when the username is taken. */
    createUser: async (username: string, displayName: string, loginKeyHash: string, keys: AccountKeysInput) =>
      one(
        sql.query<UserRow>(
          `INSERT INTO webchat.users
             (username, display_name, password_hash, created_at, auth_version, dh_public, sign_public, key_backup)
           VALUES ($1, $2, $3, $4, 2, $5, $6, $7)
           ON CONFLICT DO NOTHING RETURNING *`,
          [username, displayName, loginKeyHash, Date.now(), keys.dh, keys.sign, JSON.stringify(keys.backup)],
        ),
      ),
    /** Deletes an account and the agents it owns. False when removeAccount refuses the person. */
    deleteUser(userId: number): Promise<boolean> {
      return sql.transaction(async (tx) => {
        if (!(await removeAccount(tx, userId))) return false;
        // The person's agents go too (R-030): nobody else may hand them cards. An agent owns nothing.
        for (const { id } of await tx.query<{ id: number }>(
          'SELECT id FROM webchat.users WHERE agent_owner = $1 AND deleted_at IS NULL ORDER BY id',
          [userId],
        )) {
          if (!(await removeAccount(tx, id))) throw new Error(`Agent ${id} owns a project or group with others in it.`);
        }
        return true;
      });
    },

    /**
     * Deletes an agent its owner removes (R-033): it leaves every chat as a deleted account does, and
     * loses its owner, so no menu offers it again. False when it is not this owner's.
     */
    removeAgent: (ownerId: number, agentId: number) =>
      sql.transaction(async (tx) => {
        const agent = await one(
          tx.query<UserRow>('SELECT * FROM webchat.users WHERE id = $1 AND agent_owner = $2 AND deleted_at IS NULL FOR UPDATE', [agentId, ownerId]),
        );
        if (!agent) return false;
        if (!(await removeAccount(tx, agentId))) throw new Error(`Agent ${agentId} owns a project or group with others in it.`);
        await tx.query('UPDATE webchat.users SET agent_owner = NULL WHERE id = $1', [agentId]);
        return true;
      }),

    /** Files the agent's half of a pairing (R-030). False when the code was used already. */
    createPairing: async (input: PairingInput, loginHash: string) =>
      (
        await sql.query(
          `INSERT INTO webchat.pairings (id, dh_public, sign_public, proof, login_hash, expires_at, picks)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
          [input.id, input.keys.dh, input.keys.sign, input.proof, loginHash, Date.now() + PAIRING_TTL_MS, input.picks ?? null],
        )
      ).length > 0,
    /** A pairing while it lasts, with the agent's account and its owner's keys once approved. */
    async pairing(id: string): Promise<PairingDTO | undefined> {
      const row = await one(sql.query<PairingRow>('SELECT * FROM webchat.pairings WHERE id = $1 AND expires_at > $2', [id, Date.now()]));
      if (!row) return;
      const agent = row.agent_id === null ? undefined : await one(sql.query<UserRow>('SELECT * FROM webchat.users WHERE id = $1', [row.agent_id]));
      const owner = agent?.agent_owner ? await one(sql.query<UserRow>('SELECT * FROM webchat.users WHERE id = $1', [agent.agent_owner])) : undefined;
      const approved =
        agent && owner?.dh_public && owner.sign_public && row.owner_proof
          ? { user: toUserDTO(agent), owner: { id: owner.id, keys: { dh: owner.dh_public, sign: owner.sign_public } }, proof: row.owner_proof }
          : null;
      return { keys: { dh: row.dh_public, sign: row.sign_public }, proof: row.proof, approved, ...(row.picks && { picks: row.picks }) };
    },
    /**
     * Makes the agent's account for the owner who approves, once, while the pairing lasts. Nobody but
     * the agent signs in to it, so its username is random. Undefined when the pairing is gone or done.
     */
    approvePairing: (id: string, ownerId: number, displayName: string, ownerProof: string) =>
      sql.transaction(async (tx) => {
        const row = await one(
          tx.query<PairingRow>('SELECT * FROM webchat.pairings WHERE id = $1 AND expires_at > $2 AND agent_id IS NULL FOR UPDATE', [id, Date.now()]),
        );
        if (!row) return undefined;
        const agent = (await one(
          tx.query<UserRow>(
            `INSERT INTO webchat.users (username, display_name, password_hash, created_at, auth_version, dh_public, sign_public, agent_owner)
             VALUES ($1, $2, $3, $4, 2, $5, $6, $7) RETURNING *`,
            [`agent_${Buffer.from(randomBytes(5)).toString('hex')}`, displayName, row.login_hash, Date.now(), row.dh_public, row.sign_public, ownerId],
          ),
        ))!;
        await tx.query('UPDATE webchat.pairings SET agent_id = $2, owner_proof = $3 WHERE id = $1', [id, agent.id, ownerProof]);
        return agent;
      }),
    /** Switches an account from a raw-password hash to a login-key hash. */
    upgradeAuth: (userId: number, loginKeyHash: string) =>
      one(
        sql.query<UserRow>(
          'UPDATE webchat.users SET password_hash = $2, auth_version = 2 WHERE id = $1 AND auth_version = 1 RETURNING *',
          [userId, loginKeyHash],
        ),
      ),
    /** Stores an account's keys once. Returns undefined if the account already has keys. */
    setUserKeys: (userId: number, keys: AccountKeysInput) =>
      one(
        sql.query<UserRow>(
          `UPDATE webchat.users SET dh_public = $2, sign_public = $3, key_backup = $4
           WHERE id = $1 AND dh_public IS NULL RETURNING *`,
          [userId, keys.dh, keys.sign, JSON.stringify(keys.backup)],
        ),
      ),
    getUser: (id: number) => one(sql.query<UserRow>('SELECT * FROM webchat.users WHERE id = $1', [id])),
    findUserByUsername: (username: string) =>
      one(sql.query<UserRow>('SELECT * FROM webchat.users WHERE lower(username) = lower($1) AND deleted_at IS NULL', [username])),
    listUsers: () =>
      sql.query<UserRow>(
        `SELECT u.*, (SELECT json_agg(json_build_object('repo', r.repo, 'last_seen', r.last_seen, 'protocol', r.protocol) ORDER BY r.repo)
           FROM webchat.agent_repos r WHERE r.user_id = u.id) AS repos
         FROM webchat.users u ORDER BY lower(u.display_name)`,
      ),

    /**
     * Records a check-in from a tab. An attentive tab claims the user's attention; when that same
     * tab stops being attentive, the claim ends at once instead of waiting for it to expire. An
     * agent's laptop checks in once for every repository it has a folder for, and names what it can
     * do; an older plugin checks in for the one repository its session is open in (D-094).
     */
    async checkIn(userId: number, attentive: boolean, tabId: string, endpoint: string | null, repos: string[] = [], protocol = 0, laptop = false) {
      const now = Date.now();
      if (attentive) {
        await Promise.all([
          sql.query(
            `UPDATE webchat.users
             SET last_active_at = $2, attentive_until = $3, attentive_tab = $4, attentive_endpoint = $5, protocol = COALESCE($6::integer, protocol)
             WHERE id = $1`,
            [userId, now, now + ATTENTION_TTL_MS, tabId, endpoint, laptop ? protocol : null],
          ),
          ...repos.map((repo) =>
            sql.query(
              `INSERT INTO webchat.agent_repos (user_id, repo, last_seen, protocol) VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, repo) DO UPDATE SET last_seen = EXCLUDED.last_seen, protocol = EXCLUDED.protocol`,
              [userId, repo, now, protocol],
            ),
          ),
        ]);
        // A laptop names every folder it has, so the folders it no longer names are gone from it (R-038).
        if (laptop) await sql.query('DELETE FROM webchat.agent_repos WHERE user_id = $1 AND last_seen < $2', [userId, now]);
      } else {
        await sql.query(
          `UPDATE webchat.users SET attentive_until = 0
           WHERE id = $1 AND attentive_tab = $2 AND attentive_until > 0`,
          [userId, tabId],
        );
      }
    },

    createSession: async (tokenHash: string, userId: number, expiresAt: number) => {
      await sql.query(
        'INSERT INTO webchat.sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
        [tokenHash, userId, Date.now(), expiresAt],
      );
    },
    sessionUser: (tokenHash: string) =>
      one(
        sql.query<UserRow>(
          `SELECT u.* FROM webchat.sessions s JOIN webchat.users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.expires_at > $2`,
          [tokenHash, Date.now()],
        ),
      ),
    deleteSession: async (tokenHash: string) => {
      await sql.query('DELETE FROM webchat.sessions WHERE token_hash = $1', [tokenHash]);
    },
  };
}
