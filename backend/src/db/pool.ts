import pg from 'pg';
import { env } from '../config/env.js';

export const pool = new pg.Pool({ connectionString: env.databaseUrl });

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL idle client error:', error);
});
