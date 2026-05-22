// ============================================================
//  DB 초기화 — 스키마 생성 + 종족 시드
//  서버 부팅 시 자동 호출 (멱등), CLI: npm run initdb
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, query } from './pool.js';
import { CONFIG } from '../game/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initDb({ verbose = true } = {}) {
  const log = verbose ? console.log : () => {};
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  log('스키마 적용 중...');
  await query(schema);
  log('스키마 적용 완료.');

  for (let i = 0; i < CONFIG.TRIBE_COUNT; i++) {
    await query(
      `INSERT INTO tribes (id, name, soul_pool, total_cells)
       VALUES ($1, $2, 0, 0)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [i, CONFIG.TRIBE_NAMES[i]]
    );
  }
  log(`종족 ${CONFIG.TRIBE_COUNT}개 시드 완료.`);

  await query(
    `INSERT INTO game_state (key, value)
     VALUES ('tick', '0'::jsonb)
     ON CONFLICT (key) DO NOTHING`
  );
  log('전역 상태 초기화 완료.');
}

// CLI로 직접 실행한 경우만 풀 종료 + 프로세스 종료
const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  initDb()
    .then(async () => {
      await getPool().end();
      console.log('✅ DB 초기화 끝.');
    })
    .catch((e) => {
      console.error('초기화 실패:', e.message);
      process.exit(1);
    });
}
