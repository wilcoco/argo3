// ============================================================
//  매크로 게임 로직 — 영토 점유 / 도전 / 생태계 서버 틱
//  DB와 상호작용. 서버가 권위적으로 상태를 관리한다.
// ============================================================
import { query, tx } from '../db/pool.js';
import { CONFIG, tribeBeats, densityMult, maxBet } from './config.js';
import { latLngToCell, cellToLatLng, cellNeighbors, haversineM } from './geo.js';
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
  // 자연사 제거 — lifespan NULL (수명 무한)
  const r = await query(
    `INSERT INTO players (username, tribe, energy, born_tick, lifespan)
     VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT (username) DO UPDATE SET last_seen = now()
     RETURNING *`,
    [username, tribe, CONFIG.START_ENERGY, tick]
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
     WHERE cell_x BETWEEN $1 AND $2 AND cell_y BETWEEN $3 AND $4
       AND c.owner_id IS NOT NULL`,
    [x0, x1, y0, y1]
  );
  return r.rows;
}

// 셀 가치 → 물리 반경 (m)
function cellRadiusM(value) {
  return MAC.CELL_PHYSICAL_BASE_M * Math.sqrt((value || 40) / 40);
}

// ---- 빈 땅 점유 ----
// 자유 배치: lat/lng 그대로 저장 (그리드 스냅 없음).
// 자기 셀과 겹침 OK (클러스터 형성), 적 셀과 너무 가까우면 도전 안내 응답.
// value = 영역 가치(=점유 비용 = 물리 반경 기준)
// playerLoc = { lat, lng } 플레이어의 현재 GPS 위치 (있으면 1km 반경 강제)
export async function claimCell(playerId, lat, lng, value, playerLoc) {
  // 서버 권위적으로 범위 클램프
  const v = Math.max(MAC.CLAIM_MIN_VALUE,
            Math.min(MAC.CLAIM_MAX_VALUE,
              Math.round(Number.isFinite(value) ? value : MAC.CLAIM_DEFAULT_VALUE)));
  // GPS 반경 제약
  if (playerLoc && Number.isFinite(playerLoc.lat) && Number.isFinite(playerLoc.lng)) {
    const dist = haversineM(playerLoc.lat, playerLoc.lng, lat, lng);
    if (dist > MAC.CLAIM_RADIUS_M) {
      const km = (MAC.CLAIM_RADIUS_M / 1000).toFixed(1);
      const cur = (dist / 1000).toFixed(2);
      throw new Error(`현재 위치에서 ${km}km 이내만 점유 가능 (현재 거리 ${cur}km)`);
    }
  }
  return tx(async (client) => {
    const p = (await client.query(`SELECT * FROM players WHERE id=$1 FOR UPDATE`, [playerId])).rows[0];
    if (!p) throw new Error('플레이어 없음');
    if (p.energy < v) throw new Error('에너지 부족');

    // 적 셀과 충돌 검사: 새 셀 물리 반경 + 적 셀 물리 반경 + 마진(ENEMY_CHALLENGE_DIST_M) 이내면
    // → 점유 대신 *도전 제안* (전선 형성)
    const newR = cellRadiusM(v);
    const margin = MAC.ENEMY_CHALLENGE_DIST_M || 0;
    // 박스 1차 필터 → haversine 정밀
    const searchM = newR + (MAC.CELL_PHYSICAL_BASE_M * Math.sqrt(MAC.CLAIM_MAX_VALUE/40)) + margin;
    const dLat = searchM / 111000;
    const dLng = dLat / Math.cos((lat * Math.PI) / 180);
    const nearby = (await client.query(
      `SELECT id, owner_id, value, lat, lng FROM cells
       WHERE owner_id IS NOT NULL
         AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`,
      [lat - dLat, lat + dLat, lng - dLng, lng + dLng]
    )).rows;
    for (const c of nearby) {
      if (c.owner_id === playerId) continue; // 자기 셀과는 겹쳐도 OK (클러스터)
      const d = haversineM(lat, lng, Number(c.lat), Number(c.lng));
      const enemyR = cellRadiusM(Number(c.value));
      if (d < newR + enemyR + margin) {
        // 충돌 → 점유는 하지 않고 도전 안내
        return {
          challengeSuggested: {
            cellId: Number(c.id),
            ownerId: c.owner_id,
            lat: Number(c.lat),
            lng: Number(c.lng),
            value: Number(c.value),
            distanceM: d,
          },
        };
      }
    }

    // 점유 진행 — 자유 배치 (lat/lng 그대로). cell_x/cell_y는 spatial hint로만.
    const { cellX, cellY } = latLngToCell(lat, lng);
    const defBet = Math.round(v * 0.5);
    const ins = await client.query(
      `INSERT INTO cells (cell_x, cell_y, owner_id, tribe, value, def_bet, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [cellX, cellY, playerId, p.tribe, v, defBet, lat, lng]
    );
    // 에너지 차감 + 저장 상한 LEAST cap
    await client.query(
      `UPDATE players SET energy = LEAST(energy - $1, $2) WHERE id=$3`,
      [v, MAC.MAX_ENERGY, playerId]
    );
    return { cellId: Number(ins.rows[0].id), cellX, cellY, value: v, lat, lng };
  });
}

// ---- 도전(전투) 시작 ----
// 셀이 한가하면 즉시 전투, 다른 전투 중이거나 휴식 중이면 큐에 등록.
// target = { cellId } 또는 { cellX, cellY } — 자유 배치 이후엔 cellId 권장.
export async function startChallenge(attackerId, target, atkBet) {
  return tx(async (client) => {
    let cell;
    if (target && target.cellId != null) {
      cell = (await client.query(`SELECT * FROM cells WHERE id=$1 FOR UPDATE`, [Number(target.cellId)])).rows[0];
    } else {
      // 레거시 cellX/cellY 호환 — 가장 가까운 셀 1개
      cell = (await client.query(
        `SELECT * FROM cells WHERE cell_x=$1 AND cell_y=$2 AND owner_id IS NOT NULL
         ORDER BY id LIMIT 1 FOR UPDATE`,
        [Number(target.cellX), Number(target.cellY)])).rows[0];
    }
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
    const atkAssets = atk.energy + 30;
    const cap = maxBet(atk.energy, atkAssets);
    if (atkBet > cap) throw new Error(`베팅 상한 ${cap} 초과`);
    if (atk.energy < atkBet) throw new Error('에너지 부족');

    // 한가? — 진행 중 전투 없음 AND 휴식 종료
    const busy = (await client.query(
      `SELECT 1 FROM battles WHERE cell_id=$1 AND status='active' LIMIT 1`, [cell.id])).rowCount > 0;
    const resting = cell.rest_until && tick < cell.rest_until;
    const tickMs = CONFIG.MACRO.SERVER_TICK_MS;

    if (busy || resting) {
      // 큐에 등록 (이미 같은 도전자가 줄 서 있으면 UNIQUE 제약으로 거부)
      try {
        await client.query(
          `INSERT INTO cell_queue (cell_id, challenger_id, atk_bet) VALUES ($1,$2,$3)`,
          [cell.id, attackerId, atkBet]);
      } catch (e) {
        if (String(e.message).includes('duplicate') || e.code === '23505') {
          throw new Error('이미 이 영역의 대기열에 들어 있습니다');
        }
        throw e;
      }
      const queueLen = Number((await client.query(
        `SELECT COUNT(*)::int AS n FROM cell_queue WHERE cell_id=$1`, [cell.id])).rows[0].n);
      // 랜덤 선택 모드에서는 '순서'가 의미 없고 '나도 뽑힐 후보'로만 표시
      const isRandom = CONFIG.MACRO.QUEUE_SELECTION === 'random';
      const restRemainingSec = resting
        ? Math.max(0, (Number(cell.rest_until) - tick) * (tickMs/1000))
        : 0;
      return { queued: {
        queueLen, restRemainingSec,
        cellId: Number(cell.id),
        selection: CONFIG.MACRO.QUEUE_SELECTION,
        // 랜덤이면 "확률 1/N", FIFO면 별도로 계산해 추가 가능
        oddsText: isRandom ? `${queueLen}명 중 무작위 선택` : '순서대로'
      }};
    }

    // 즉시 전투
    const b = (await client.query(
      `INSERT INTO battles (cell_id, attacker_id, defender_id, atk_bet, def_bet, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [cell.id, attackerId, cell.owner_id, atkBet, cell.def_bet]
    )).rows[0];

    const R = CONFIG.MICRO.PROXIMITY_RADIUS_M;
    const proximity = await countProximityCells(client, cell.lat, cell.lng, R, attackerId, cell.owner_id);
    return { battle: b, cell, attacker: atk, defender: def, proximity };
  });
}

// 큐의 다음 도전자를 꺼내 전투 시작. 호출자가 socket으로 알림 보내야 함.
// 도전자가 더 이상 자격 안 되면(에너지 부족 등) 스킵하고 다음을 시도.
export async function popNextChallenger(cellId) {
  return tx(async (client) => {
    const cell = (await client.query(`SELECT * FROM cells WHERE id=$1 FOR UPDATE`, [cellId])).rows[0];
    if (!cell || !cell.owner_id) return null;
    const tick = await getTick();
    if (cell.rest_until && tick < cell.rest_until) return null; // 아직 휴식 중
    const busy = (await client.query(
      `SELECT 1 FROM battles WHERE cell_id=$1 AND status='active' LIMIT 1`, [cellId])).rowCount > 0;
    if (busy) return null;

    // 큐 순회 — 자격 못 되는 도전자 자동 제거
    while (true) {
      // 큐에서 다음 도전자 선정 — FIFO 또는 RANDOM (담합 방지)
      // 랜덤이 기본: 친구끼리 가짜 도전으로 좋은 자리 선점 못 하게.
      const order = CONFIG.MACRO.QUEUE_SELECTION === 'random' ? 'random()' : 'queued_at ASC';
      const next = (await client.query(
        `SELECT * FROM cell_queue WHERE cell_id=$1 ORDER BY ${order} LIMIT 1`, [cellId])).rows[0];
      if (!next) return null;
      const atk = (await client.query(`SELECT * FROM players WHERE id=$1 FOR UPDATE`, [next.challenger_id])).rows[0];
      const bet = Number(next.atk_bet);
      const minBet = Math.ceil(cell.def_bet * CONFIG.BETTING.CHALLENGE_MIN_RATIO);
      // 도전자가 자격 잃었으면 스킵
      if (!atk || !atk.alive || atk.energy < bet || bet < minBet) {
        await client.query(`DELETE FROM cell_queue WHERE id=$1`, [next.id]);
        continue;
      }
      // 전투 생성
      const b = (await client.query(
        `INSERT INTO battles (cell_id, attacker_id, defender_id, atk_bet, def_bet, status)
         VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
        [cellId, next.challenger_id, cell.owner_id, bet, cell.def_bet]
      )).rows[0];
      await client.query(`DELETE FROM cell_queue WHERE id=$1`, [next.id]);
      const def = (await client.query(`SELECT * FROM players WHERE id=$1`, [cell.owner_id])).rows[0];
      const R = CONFIG.MICRO.PROXIMITY_RADIUS_M;
      const proximity = await countProximityCells(client, Number(cell.lat), Number(cell.lng), R, next.challenger_id, cell.owner_id);
      return { battle: b, cell, attacker: atk, defender: def, proximity, challengerId: next.challenger_id };
    }
  });
}

export async function cancelQueueEntry(cellId, challengerId) {
  const r = await query(
    `DELETE FROM cell_queue WHERE cell_id=$1 AND challenger_id=$2`, [cellId, challengerId]);
  return r.rowCount > 0;
}

// 방어자가 짧은 휴식(60초)을 스킵하고 곧장 다음 도전자와 싸움. 장기 휴식은 스킵 불가.
export async function skipRest(cellId, defenderId) {
  return tx(async (client) => {
    const cell = (await client.query(`SELECT * FROM cells WHERE id=$1 FOR UPDATE`, [cellId])).rows[0];
    if (!cell) throw new Error('셀 없음');
    if (cell.owner_id !== defenderId) throw new Error('소유자만 스킵 가능');
    const tick = await getTick();
    if (!cell.rest_until || tick >= Number(cell.rest_until)) return { skipped: false, reason: '이미 휴식 종료' };
    const remaining = Number(cell.rest_until) - tick;
    if (remaining > CONFIG.MACRO.DEFENDER_REST_TICKS) {
      return { skipped: false, reason: '장기 강제 휴식은 스킵 불가' };
    }
    await client.query(`UPDATE cells SET rest_until=NULL WHERE id=$1`, [cellId]);
    return { skipped: true };
  });
}

// 휴식 끝났고 큐가 비어있지 않은 셀들을 찾아 다음 도전자 팝 — 호출자(서버 틱)가 사용.
export async function processQueueTick() {
  const tick = await getTick();
  const rows = (await query(
    `SELECT DISTINCT c.id
     FROM cells c
     JOIN cell_queue q ON q.cell_id = c.id
     WHERE (c.rest_until IS NULL OR c.rest_until <= $1)
       AND NOT EXISTS (SELECT 1 FROM battles b WHERE b.cell_id = c.id AND b.status='active')`,
    [tick])).rows;
  const popped = [];
  for (const r of rows) {
    try {
      const res = await popNextChallenger(Number(r.id));
      if (res) popped.push(res);
    } catch (e) { /* 한 셀 실패가 전체를 막지 않게 */ }
  }
  return popped;
}

// 위치 (lat,lng) 반경 radius_m 안에 attackerId/defenderId가 각각 가진 셀 수
// 현재 도전 중인 셀은 방어자 카운트에서 제외 (그건 전투의 무대)
async function countProximityCells(client, lat, lng, radius_m, attackerId, defenderId) {
  // 위경도 도(degree) 단위 대략 박스로 좁힌 뒤 정확히 haversine으로 필터
  const dLat = radius_m / 111000;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const rows = (await client.query(
    `SELECT owner_id, lat, lng FROM cells
     WHERE owner_id IN ($1,$2)
       AND lat BETWEEN $3 AND $4 AND lng BETWEEN $5 AND $6`,
    [attackerId, defenderId, lat - dLat, lat + dLat, lng - dLng, lng + dLng]
  )).rows;
  let atk = 0, def = 0;
  for (const r of rows) {
    const d = haversineM(lat, lng, Number(r.lat), Number(r.lng));
    if (d > radius_m) continue;
    if (r.owner_id === attackerId) atk++;
    else if (r.owner_id === defenderId) def++;
  }
  // 방어자의 "이 셀 자체"는 제외 (lat/lng가 정확히 같으니 1 빼도 안전하지만,
  // 위에서 BETWEEN 매칭으로 잡혔으면 카운트됐을 것. 방어자 본진은 별도 의미 가짐)
  if (def > 0) def -= 1;
  return { atk, def };
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
      await client.query(`UPDATE players SET energy = LEAST(energy + $1, $4::real),
        wins = wins + 1, combat_wins = combat_wins + 1, karma = karma + $2 WHERE id=$3`,
        [b.def_bet, ECO.KARMA_COMBAT_WIN, b.attacker_id, MAC.MAX_ENERGY]);
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

    // 전투 종료 후 피로 누적 + 단계 휴식
    // - 매 전투 후: 짧은 휴식 (60초, 큐는 누적)
    // - 연속 N방어 후: 1시간 강제 휴식 (큐는 누적, 연속 카운터 리셋)
    // - 하루 M방어 후: 8시간 강제 휴식 (큐 누적, 모두 리셋)
    // 도전 성공(점유 이전)이면 카운터 리셋: 새 점유자의 셀이니까.
    let consec, daily, dayStart;
    if (result.winner === 'attacker') {
      // 점유 이전 — 카운터 리셋
      consec = 0; daily = 0; dayStart = null;
    } else {
      // 방어 성공 — 카운터 증가
      // 하루 경계 (24시간) 지났으면 daily 리셋
      const now = new Date();
      const lastDayStart = cell.defenses_day_start ? new Date(cell.defenses_day_start) : null;
      const dayElapsed = lastDayStart ? (now - lastDayStart) / 1000 / 3600 : 999;
      if (!lastDayStart || dayElapsed >= 24) {
        daily = 1; dayStart = now;
      } else {
        daily = (cell.defenses_today || 0) + 1; dayStart = lastDayStart;
      }
      consec = (cell.consec_defenses || 0) + 1;
    }

    const MAC = CONFIG.MACRO;
    let restTicks = MAC.DEFENDER_REST_TICKS;
    let restReason = 'short';
    if (daily >= MAC.REST_FATIGUE_DAILY) {
      restTicks = MAC.REST_FATIGUE_DAILY_TICKS;
      restReason = 'daily_fatigue';
      consec = 0; daily = 0; dayStart = null;  // 풀 리셋
    } else if (consec >= MAC.REST_FATIGUE_CONSEC) {
      restTicks = MAC.REST_FATIGUE_CONSEC_TICKS;
      restReason = 'consec_fatigue';
      consec = 0;  // 연속 카운터만 리셋
    }
    const restUntil = tick + restTicks;
    await client.query(
      `UPDATE cells SET rest_until=$1, consec_defenses=$2, defenses_today=$3, defenses_day_start=$4 WHERE id=$5`,
      [restUntil, consec, daily, dayStart, cell.id]);

    const restSec = restTicks * (MAC.SERVER_TICK_MS / 1000);
    return { winner: result.winner, battleTime: result.t, restUntil, restSec, restReason, consec, daily };
  });
}

// ============================================================
//  생태계 서버 틱 — 수입, 자연사/환생, 종족 상성 압박, 영웅
//  주기적으로 호출 (SERVER_TICK_MS).
// ============================================================
export async function ecosystemTick(io) {
  const tick = (await getTick()) + 1;
  await setTick(tick);

  // 1) 수입 — 셀 가치(value)에 비례, 저장 상한 MAX_ENERGY로 클램프
  //    큰 영역일수록 많이 생산. 그러나 상한에 도달하면 손해 → 사용 압박.
  await query(`
    UPDATE players p SET energy = LEAST(energy + sub.inc, $2::real)
    FROM (
      SELECT owner_id, SUM(value) * $1::real AS inc
      FROM cells WHERE owner_id IS NOT NULL GROUP BY owner_id
    ) sub
    WHERE p.id = sub.owner_id AND p.alive
  `, [MAC.INCOME_PER_VALUE, MAC.MAX_ENERGY]);

  // 2) 카르마 누적 (생존 + 영토)
  await query(`
    UPDATE players p SET karma = karma + $1::real + COALESCE(sub.cnt,0) * $2::real
    FROM (SELECT owner_id, COUNT(*) cnt FROM cells WHERE owner_id IS NOT NULL GROUP BY owner_id) sub
    WHERE p.id = sub.owner_id AND p.alive
  `, [ECO.KARMA_SURVIVAL * 0.1, ECO.KARMA_TERRITORY * 0.01]);

  // (3) 자연사 — 제거됨. 영구 캐릭터.
  //     수명 만료 기반 환생/영웅 풀은 보류 (lifespan=NULL이라 트리거 안 됨).
  const dying = [];

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
