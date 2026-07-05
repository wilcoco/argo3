// ============================================================
//  데일리 퀘스트 — 진행 누적 / 조회 / 보상 수령
//  일일 리셋: KST 자정 (행 자체가 날짜로 분리 — 리셋 작업 불필요)
// ============================================================
import { query, tx } from '../db/pool.js';
import { CONFIG } from './config.js';

const KST_TODAY = `(now() at time zone 'Asia/Seoul')::date`;

// 진행 누적 — tx 안에서 client와 함께 호출 (봇은 조용히 무시)
export async function incQuest(client, playerId, key, amount = 1) {
  if (!CONFIG.QUESTS.some((q) => q.key === key)) return;
  await client.query(
    `INSERT INTO player_quests (player_id, day, quest_key, progress)
     SELECT $1, ${KST_TODAY}, $2, $3::real
     WHERE EXISTS (SELECT 1 FROM players WHERE id=$1 AND NOT is_bot)
     ON CONFLICT (player_id, day, quest_key)
     DO UPDATE SET progress = player_quests.progress + $3::real`,
    [playerId, key, amount]
  );
}

// 오늘 퀘스트 목록 + 진행 (정의는 config, 진행은 DB)
export async function listQuests(playerId) {
  const rows = (await query(
    `SELECT quest_key, progress, claimed FROM player_quests
     WHERE player_id=$1 AND day=${KST_TODAY}`, [playerId])).rows;
  const map = new Map(rows.map((r) => [r.quest_key, r]));
  return CONFIG.QUESTS.map((q) => {
    const r = map.get(q.key);
    const progress = r ? Number(r.progress) : 0;
    return {
      key: q.key, icon: q.icon, label: q.label, target: q.target, reward: q.reward,
      progress: Math.min(progress, q.target),
      done: progress >= q.target,
      claimed: !!(r && r.claimed),
    };
  });
}

// 보상 수령 — 완료 && 미수령 검증 후 에너지 지급 (지갑 상한 클램프)
export async function claimQuest(playerId, key) {
  const def = CONFIG.QUESTS.find((q) => q.key === key);
  if (!def) throw new Error('없는 퀘스트');
  return tx(async (client) => {
    const r = (await client.query(
      `SELECT progress, claimed FROM player_quests
       WHERE player_id=$1 AND day=${KST_TODAY} AND quest_key=$2 FOR UPDATE`,
      [playerId, key])).rows[0];
    if (!r || Number(r.progress) < def.target) throw new Error('아직 완료하지 못했습니다');
    if (r.claimed) throw new Error('이미 보상을 받았습니다');
    await client.query(
      `UPDATE player_quests SET claimed=TRUE
       WHERE player_id=$1 AND day=${KST_TODAY} AND quest_key=$2`, [playerId, key]);
    await client.query(
      `UPDATE players SET energy = LEAST(energy + $1::real, $2::real) WHERE id=$3`,
      [def.reward, CONFIG.MACRO.MAX_ENERGY, playerId]);
    const p = (await client.query(`SELECT energy FROM players WHERE id=$1`, [playerId])).rows[0];
    return { reward: def.reward, energy: Number(p.energy) };
  });
}
