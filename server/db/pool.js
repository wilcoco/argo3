// ============================================================
//  DB 연결 — PostgreSQL (Railway) / 없으면 안내
// ============================================================
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

// Railway는 DATABASE_URL 환경변수를 자동 주입한다.
const connectionString = process.env.DATABASE_URL;

let pool = null;

export function getPool() {
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL이 설정되지 않았습니다. ' +
      'Railway에서 PostgreSQL 플러그인을 추가하면 자동 주입됩니다. ' +
      '로컬 테스트는 .env에 DATABASE_URL=postgres://... 형식으로 추가하세요.'
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      // Railway 내부 연결은 SSL 불필요, 외부는 필요할 수 있음
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => console.error('PG pool error:', err.message));
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
