import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { auth } from '../modules/auth/auth.js';
import { ensureProfile } from '../modules/social/profile.js';
import { pool } from './pool.js';

const demoUsers = [
  { name: 'Aarav', username: 'aarav.demo' },
  { name: 'Meera', username: 'meera.demo' },
  { name: 'Kabir', username: 'kabir.demo' },
  { name: 'Diya', username: 'diya.demo' },
  { name: 'Rohan', username: 'rohan.demo' },
  { name: 'Isha', username: 'isha.demo' },
];

async function seed() {
  const credentials: { username: string; email: string; password: string }[] = [];
  try {
    for (const person of demoUsers) {
      const email = `${person.username}@example.com`;
      let result = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email]);
      if (!result.rows[0]) {
        const password = randomBytes(24).toString('base64url');
        await auth.api.signUpEmail({ body: { email, password, name: person.name } });
        credentials.push({ username: person.username, email, password });
        result = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email]);
      }
      if (!result.rows[0]) throw new Error(`Could not create ${person.username}`);
      await ensureProfile(result.rows[0].id);
      await pool.query('UPDATE "user" SET username = $2 WHERE id = $1', [result.rows[0].id, person.username]);
      console.log(`Ready: @${person.username}`);
    }
    if (credentials.length) {
      await writeFile(new URL('../../seed-credentials.json', import.meta.url), JSON.stringify(credentials, null, 2));
      console.log('New demo login credentials saved to backend/seed-credentials.json (gitignored).');
    }
  } finally { await pool.end(); }
}

seed().catch((error: unknown) => { console.error('Seed failed:', error); process.exitCode = 1; });
