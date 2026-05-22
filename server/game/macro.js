// ============================================================
//  매크로 게임 로직 — 영토 점유 / 도전 / 생태계 서버 틱
//  DB와 상호작용. 서버가 권위적으로 상태를 관리한다.
// ============================================================
import { query, tx } from '../db/pool.js';
import { CONFIG, tribeBeats, densityMult, maxBet } from './config.js';
import { latLngToCell, cellToLatLng, cellNeighbors } from './geo.js';
import { simulateBattle } from './battle.js';

const MAC = CONFIG.MACRO;
const ECO = CONFIG.ECOSYSTEM;

// ---- 현재 서버 tick ----
export async function getTick() {
  const r = await query(`SELECT value FROM game_state WHERE key='tick'`);
  return r.rows[0] ? Number(r.rows[0].value) : 0;
}
async function setTick(t) {
  await query(`UPDATE game_state SET value=$1::jsonb WHERE key='tick'`, [JSON.stringify(t)]);
}

// ---- 플레이어 생성/조회 ----
export async function createPlayer(username) {
  // 종족 랜덤 배정 (인구 균형 위해 최소 종족 우선)
  const tribeCounts = await query(
    `SELECT tribe, COUNT(*) c FROM players WHERE alive GROUP BY tribe`
  );
  const counts = new Array(CONFIG.TRIBE_COUNT).fill(0);
  tribeCounts.rows.forEach((r) => (counts[r.tribe] = Number(r.c)));
  // 가장 적은 종족에 배정 (동률이면 랜덤)
  const min = Math.min(...counts);
  const candidates = counts.map((c, i) => (c === min ? i : -1)).filter((i) => i >= 0);
  const tribe = candidates[Math.floor(Math.random() * candidates.length)];

  const tick = await getTick();
  const lifespan = ECO.LIFE_MIN + Math.random() * (ECO.LIFE_MAX - ECO.LIFE_MIN);

  const r = await query(
    `INSERT INTO players (username, tribe, energy, born_tick, lifespan)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username) DO UPDATE SET last_seen = now()
     RETURNING *`,
    [username, tribe, CONFIG.START_ENERGY, tick, Math.round(lifespan)]
  );
  return r.rows[0];
}

export async function getPlayer(id) {
  const r = await query(`SELECT * FROM players WHERE id=$1`, [id]);
  return r.rows[0] || null;
}

// ---- 영토 조회 (지도 영역 내) ----
export async function getCellsInBounds(minLat, minLng, maxLat, maxLng) {
  const a = latLngToCell(minLat, minLng);
  const b = latLngToCell(maxLat, maxLng);
  const x0 = Math.min(a.cellX, b.cellX), x1 = Math.max(a.cellX, b.cellX);
  const y0 = Math.min(a.cellY, b.cellY), y1 = Math.max(a.cellY, b.cellY);
  const r = await query(
    `SELECT c.*, p.username, p.is_hero
     FROM cells c LEFT JOIN players p ON c.owner_id = p.id
     WHERE cell_x BETWEEN $1 AND $2 AND cell_y BETWEEN $3 AND $4`,
    [x0, x1, y0, y1]
  );
  return r.rows;
}

// ---- 빈 땅 점유 ----
export async function claimCell(playerId, lat, lng) {
  const { cellX, cellY } = latLngToCell(lat, lng);
  return tx(async (client) => {
    const p = (await client.query(`SELECT * FROM players WHERE id=$1 FOR UPDATE`, [playerId])).rows[0];
    if (!p) throw new Error('플레이어 없음');
    if (p.energy < MAC.CLAIM_COST) throw new Error('에너지 부족');

    const existing = (await client.query(`SELECT * FROM cells WHERE cell_x=$1 AND cell_y=$2`, [cellX, cellY])).rows[0];
    if (existing && existing.owner_id) throw new Error('이미 점유된 영역');

    const center = cellToLatLng(cellX, cellY);
    await client.query(
      `INSERT INTO cells (cell_x, cell_y, owner_id, tribe, value, def_bet, lat, lng)
       VALUES ($1,$2,$3,$4,40,20,$5,$6)
       ON CONFLICT (cell_x, cell_y) DO UPDATE SET owner_id=$3, tribe=$4`,
      [cellX, cellY, playerId, p.tribe, center.lat, center.lng]
    );
    await client.query(`UPDATE players SET energy = energy - $1 WHERE id=$2`, [MAC.CLAIM_COST, playerId]);
    return { cellX, cellY, ...center };
  });
}

// ---- 도전(전투) 시작: 검증 후 battle 레코드 생성 ----
export async function startChallenge(attackerId, cellX, cellY, atkBet) {
  return tx(async (client) => {
    const cell = (await client.query(`SELECT * FROM cells WHERE cell_x=$1 AND cell_y=$2 FOR UPDATE`, [cellX, cellY])).rows[0];
    if (!cell || !cell.owner_id) throw new Error('점유되지 않은 영역');
    if (cell.owner_id === attackerId) throw new Error('자기 영역');

    const tick = await getTick();
    if (cell.exempt_until && tick < cell.exempt_until) throw new Error('방어 면제 기간');

    const atk = (await client.query(`SELECT * FROM players WHERE id=$1 FOR UPDATE`, [attackerId])).rows[0];
    const def = (await client.query(`SELECT * FROM players WHERE id=$1`, [cell.owner_id])).rows[0];
    if (!atk) throw new Error('도전자 없음');

    // 베팅 검증 (명세서 6장)
    const minBet = Math.ceil(cell.def_bet * CONFIG.BETTING.CHALLENGE_MIN_RATIO);
    if (atkBet < minBet) throw new Error(`최소 베팅 ${minBet} 이상 필요`);
    const atkAssets = atk.energy + 30; // 간이 자산
    const cap = maxBet(atk.energy, atkAssets);
    if (atkBet > cap) throw new Error(`베팅 상한 ${cap} 초과`);
    if (atk.energy < atkBet) throw new Error('에너지 부족');

    const b = (await client.query(
      `INSERT INTO battles (cell_id, attacker_id, defender_id, atk_bet, def_bet, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [cell.id, attackerId, cell.owner_id, atkBet, cell.def_bet]
    )).rows[0];
    return { battle: b, cell, attacker: atk, defender: def };
  });
}

// ---- 도전 결과 판정 (서버 권위) ----
export async function resolveChallenge(battleId, opts = {}) {
  return tx(async (client) => {
    const b = (await client.query(`SELECT * FROM battles WHERE id=$1 FOR UPDATE`, [battleId])).rows[0];
    if (!b || b.status !== 'active') throw new Error('유효하지 않은 전투');
    const cell = (await client.query(`SELECT * FROM cells WHERE id=$1 FOR UPDATE`, [b.cell_id])).rows[0];

    // 승패 결정: PvP면 클라이언트 보고 승자, 아니면 서버 AI 시뮬 (권위)
    let result;
    if (opts.pvpWinner === 'attacker' || opts.pvpWinner === 'defender') {
      result = { winner: opts.pvpWinner, t: 0 };
    } else {
      result = simulateBattle(Number(b.atk_bet), Number(b.def_bet), opts);
    }
    const tick = await getTick();

    if (result.winner === 'attacker') {
      // 도전 성공: 점유 이전 + 베팅 흡수
      const atk = (await client.query(`SELECT * FROM players WHERE id=$1`, [b.attacker_id])).rows[0];
      await client.query(
        `UPDATE cells SET owner_id=$1, tribe=$2, def_bet=$3, def_wins=0, exempt_until=NULL WHERE id=$4`,
        [b.attacker_id, atk.tribe, Math.min(cell.value, b.atk_bet), cell.id]
      );
      await client.query(`UPDATE players SET energy = energy + $1, wins = wins + 1, combat_wins = combat_wins + 1, karma = karma + $2 WHERE id=$3`,
        [b.def_bet, ECO.KARMA_COMBAT_WIN, b.attacker_id]);
      await client.query(`UPDATE players SET energy = GREATEST(0, energy - $1), losses = losses + 1 WHERE id=$2`,
        [b.def_bet, b.defender_id]);
    } else {
      // 방어 성공: 도전자 베팅 손실, 방어자 누적승 + 면제 판정
      await client.query(`UPDATE players SET energy = GREATEST(0, energy - $1), losses = losses + 1 WHERE id=$2`,
        [b.atk_bet, b.attacker_id]);
      const newWins = cell.def_wins + 1;
      let exemptUntil = null;
      if (newWins >= CONFIG.EXEMPT.WINS) {
        let hrs = CONFIG.EXEMPT.HOURS;
        if (CONFIG.EXEMPT.VALUE_SCALING) hrs = Math.max(1, Math.round(CONFIG.EXEMPT.HOURS * (60 / Math.max(40, cell.value))));
        // tick은 5초=1시간 가정 → 시간을 tick으로
        exemptUntil = tick + hrs;
      }
      await client.query(`UPDATE cells SET def_wins=$1, exempt_until=$2 WHERE id=$3`,
        [newWins >= CONFIG.EXEMPT.WINS ? 0 : newWins, exemptUntil, cell.id]);
      await client.query(`UPDATE players SET wins = wins + 1, combat_wins = combat_wins + 1, karma = karma + $1 WHERE id=$2`,
        [ECO.KARMA_COMBAT_WIN, b.defender_id]);
    }

    await client.query(`UPDATE battles SET status='done', winner=$1, ended_at=now() WHERE id=$2`,
      [result.winner, battleId]);
    return { winner: result.winner, battleTime: result.t };
  });
}

// ============================================================
//  생태계 서버 틱 — 수입, 자연사/환생, 종족 상성 압박, 영웅
//  주기적으로 호출 (SERVER_TICK_MS).
// ============================================================
export async function ecosystemTick(io) {
  const tick = (await getTick()) + 1;
  await setTick(tick);

  // 1) 수입 (밀도 기반은 무거우므로 간이: 셀당 기본 + 노른자 보너스)
  //    소유 셀 수 × 수입을 플레이어에 적립
  await query(`
    UPDATE players p SET energy = energy + sub.inc
    FROM (
      SELECT owner_id, COUNT(*) * $1 AS inc
      FROM cells WHERE owner_id IS NOT NULL GROUP BY owner_id
    ) sub
    WHERE p.id = sub.owner_id AND p.alive
  `, [MAC.INCOME_PER_CELL]);

  // 2) 카르마 누적 (생존 + 영토)
  await query(`
    UPDATE players p SET karma = karma + $1 + COALESCE(sub.cnt,0)*$2
    FROM (SELECT owner_id, COUNT(*) cnt FROM cells WHERE owner_id IS NOT NULL GROUP BY owner_id) sub
    WHERE p.id = sub.owner_id AND p.alive
  `, [ECO.KARMA_SURVIVAL * 0.1, ECO.KARMA_TERRITORY * 0.01]);

  // 3) 자연사: 수명 다한 플레이어 → 사망 + 카르마 영혼풀 이월
  const dying = (await query(
    `SELECT id, tribe, karma, combat_wins FROM players
     WHERE alive AND lifespan IS NOT NULL AND ($1 - born_tick) >= lifespan`,
    [tick]
  )).rows;
  for (const d of dying) {
    const contrib = Number(d.karma) + Number(d.combat_wins) * ECO.COMBAT_DEATH_HERO_BONUS;
    await query(`UPDATE tribes SET soul_pool = soul_pool + $1 WHERE id=$2`, [contrib, d.tribe]);
    await query(`UPDATE players SET alive=FALSE WHERE id=$1`, [d.id]);
    await query(`UPDATE cells SET owner_id=NULL, tribe=NULL WHERE owner_id=$1`, [d.id]);
  }

  // 4) 종족 영토 캐시 + 약자 추적
  const tc = (await query(
    `SELECT tribe, COUNT(*) c FROM cells WHERE tribe IS NOT NULL GROUP BY tribe`
  )).rows;
  const counts = new Array(CONFIG.TRIBE_COUNT).fill(0);
  tc.forEach((r) => (counts[r.tribe] = Number(r.c)));
  for (let i = 0; i < CONFIG.TRIBE_COUNT; i++) {
    await query(`UPDATE tribes SET total_cells=$1 WHERE id=$2`, [counts[i], i]);
  }

  // 5) 영웅 만료
  await query(`UPDATE players SET is_hero=FALSE WHERE is_hero AND hero_until IS NOT NULL AND hero_until < $1`, [tick]);

  // 6) 상성 경계 압박 (마이크로 도전을 유도하는 "긴장"만, 점유이전은 마이크로에서)
  //    여기서는 압박 받는 셀의 def_bet을 약화시키는 정도로 표현 (간이)
  //    실제 점유 변화는 플레이어 도전으로만.

  // 상태 브로드캐스트
  if (io) {
    io.emit('ecosystem:update', {
      tick,
      tribes: counts.map((c, i) => ({ id: i, name: CONFIG.TRIBE_NAMES[i], cells: c })),
      deaths: dying.length,
    });
  }
  return { tick, tribeCounts: counts, deaths: dying.length };
}
