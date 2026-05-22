// ============================================================
//  DB 초기화 — 스키마 생성 + 종족 시드
//  실행: npm run initdb  (또는 node server/db/init.js)
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, query } from './pool.js';
import { CONFIG } from '../game/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('스키마 적용 중...');
  await query(schema);
  console.log('스키마 적용 완료.');

  // 종족 시드
  for (let i = 0; i < CONFIG.TRIBE_COUNT; i++) {
    await query(
      `INSERT INTO tribes (id, name, soul_pool, total_cells)
       VALUES ($1, $2, 0, 0)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [i, CONFIG.TRIBE_NAMES[i]]
    );
  }
  console.log(`종족 ${CONFIG.TRIBE_COUNT}개 시드 완료.`);

  // 전역 상태 초기화
  await query(
    `INSERT INTO game_state (key, value)
     VALUES ('tick', '0'::jsonb)
     ON CONFLICT (key) DO NOTHING`
  );
  console.log('전역 상태 초기화 완료.');

  await getPool().end();
  console.log('✅ DB 초기화 끝.');
}

main().catch((e) => {
  console.error('초기화 실패:', e.message);
  process.exit(1);
});
