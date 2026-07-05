// ============================================================
//  매크로 게임 로직 — 영토 점유 / 도전 / 생태계 서버 틱
//  DB와 상호작용. 서버가 권위적으로 상태를 관리한다.
// ============================================================
import { query, tx } from '../db/pool.js';
import { CONFIG, tribeBeats, densityMult, maxBet } from './config.js';
import { latLngToCell, cellToLatLng, cellNeighbors, haversineM } from './geo.js';
import { simulateBattle, estimateWinProb } from './battle.js';
import { incQuest } from './quests.js';

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
  const r = await query(
    `SELECT p.*,
       COALESCE(sub.cells_value, 0) AS cells_value,
       COALESCE(sub.cells_count, 0) AS cells_count,
       COALESCE(sub.stored_total, 0) AS stored_total
     FROM players p
     LEFT JOIN (SELECT owner_id, SUM(value) cells_value, COUNT(*) cells_count,
                       SUM(stored_energy) stored_total
                FROM cells GROUP BY owner_id) sub ON sub.owner_id = p.id
     WHERE p.id=$1`, [id]);
  return r.rows[0] || null;
}

// ---- 순위표 — 영토 가치 기준 상위 N (봇 제외) ----
export async function getLeaderboard(limit = 10) {
  const r = await query(
    `SELECT p.id, p.username, p.tribe, p.is_hero, p.wins, p.losses,
       COALESCE(SUM(c.value), 0)::real AS territory,
       COUNT(c.id)::int AS cells
     FROM players p
     LEFT JOIN cells c ON c.owner_id = p.id
     WHERE p.alive AND NOT p.is_bot
     GROUP BY p.id
     HAVING COUNT(c.id) > 0
     ORDER BY territory DESC, p.wins DESC
     LIMIT $1`, [limit]);
  return r.rows;
}

// ---- 한번에 수확 — 내 모든 타워의 저장 에너지를 지갑으로 (상한까지) ----
export async function harvestAll(playerId) {
  return tx(async (client) => {
    const p = (await client.query(`SELECT * FROM players WHERE id=$1 FOR UPDATE`, [playerId])).rows[0];
    if (!p) throw new Error('플레이어 없음');
    const cells = (await client.query(
      `SELECT id, stored_energy FROM cells WHERE owner_id=$1 AND stored_energy >= 1
       ORDER BY stored_energy DESC FOR UPDATE`, [playerId])).rows;
    if (!cells.length) throw new Error('수확할 에너지가 없습니다');
    let room = Math.max(0, MAC.MAX_ENERGY - Number(p.energy));
    if (room <= 0) throw new Error(`지갑이 가득 찼습니다 (상한 ${MAC.MAX_ENERGY})`);
    let harvested = 0;
    for (const c of cells) {
      if (room <= 0) break;
      const take = Math.min(Number(c.stored_energy), room);
      await client.query(`UPDATE cells SET stored_energy = stored_energy - $1::real WHERE id=$2`, [take, c.id]);
      harvested += take; room -= take;
    }
    await client.query(`UPDATE players SET energy = energy + $1::real WHERE id=$2`, [harvested, playerId]);
    await incQuest(client, playerId, 'harvest', harvested);
    return { harvested, towers: cells.length, energy: Number(p.energy) + harvested };
  });
}

// 본인 조회 = 활동 신호 — 수면 보호(SHIELD) 판정에 쓰는 last_seen 갱신
export async function touchPlayer(id) {
  await query(`UPDATE players SET last_seen=now() WHERE id=$1`, [id]);
}

// 내 셀 목록 (지도에서 내 영토로 점프용)
export async function getPlayerCells(playerId) {
  const r = await query(
    `SELECT id, lat, lng, value, def_bet, stored_energy FROM cells
     WHERE owner_id=$1 ORDER BY value DESC`, [playerId]);
  return r.rows;
}

// ---- 영토 조회 (지도 영역 내) ----
export async function getCellsInBounds(minLat, minLng, maxLat, maxLng) {
  const a = latLngToCell(minLat, minLng);
  const b = latLngToCell(maxLat, maxLng);
  const x0 = Math.min(a.cellX, b.cellX), x1 = Math.max(a.cellX, b.cellX);
  const y0 = Math.min(a.cellY, b.cellY), y1 = Math.max(a.cellY, b.cellY);
  const sql = `SELECT c.*, p.username, p.is_hero, p.is_bot
     FROM cells c LEFT JOIN players p ON c.owner_id = p.id
     WHERE cell_x BETWEEN $1 AND $2 AND cell_y BETWEEN $3 AND $4
       AND c.owner_id IS NOT NULL`;
  let cells = (await query(sql, [x0, x1, y0, y1])).rows;
  // 시야 내 적 셀 부족하면 봇 셀로 보충 (신규 유저에게 즉시 도전·클러스터 환경 제공)
  if (cells.length < MAC.BOT_TARGET_PER_VIEW) {
    const needed = MAC.BOT_TARGET_PER_VIEW - cells.length;
    await ensureBotCells(minLat, minLng, maxLat, maxLng, needed);
    cells = (await query(sql, [x0, x1, y0, y1])).rows;
  }
  return cells;
}

// ---- NPC 봇 ----
// 봇 셀은 보통 플레이어 셀처럼 도전·점유 이전 가능.
// 봇 자체는 income/karma/hero 처리 대상에서 제외.
async function getOrCreateBot(client) {
  // 임의의 기존 봇 재사용 (셀 분산 위해)
  const ex = (await client.query(
    `SELECT id, tribe FROM players WHERE is_bot AND alive ORDER BY random() LIMIT 1`
  )).rows[0];
  if (ex && Math.random() < 0.6) return ex; // 60% 확률로 기존 봇 사용 (셀 묶임)
  // 새 봇 생성 — 종족 랜덤 분포
  const tribe = Math.floor(Math.random() * CONFIG.TRIBE_COUNT);
  const suffix = ['α','β','γ','δ','ε','ζ','η','θ','ι','κ','λ','μ'][Math.floor(Math.random()*12)];
  const username = `🤖 Sentinel-${suffix}-${Date.now().toString(36).slice(-4)}`;
  const ins = await client.query(
    `INSERT INTO players (username, tribe, energy, born_tick, lifespan, is_bot)
     VALUES ($1, $2, 0, 0, NULL, TRUE) RETURNING id, tribe`,
    [username, tribe]
  );
  return ins.rows[0];
}

async function ensureBotCells(minLat, minLng, maxLat, maxLng, count) {
  return tx(async (client) => {
    // 전세계 봇 셀 총량 상한 — 지도 팬만으로 무한 증식하지 않게
    const total = Number((await client.query(
      `SELECT COUNT(*)::int n FROM cells c JOIN players p ON c.owner_id=p.id WHERE p.is_bot`
    )).rows[0].n);
    count = Math.min(count, Math.max(0, MAC.BOT_CELLS_MAX - total));
    for (let i = 0; i < count; i++) {
      const bot = await getOrCreateBot(client);
      // 시야 안쪽 어디에 — 가장자리 살짝 안으로
      const padLat = (maxLat - minLat) * 0.1;
      const padLng = (maxLng - minLng) * 0.1;
      const lat = minLat + padLat + Math.random() * (maxLat - minLat - padLat*2);
      const lng = minLng + padLng + Math.random() * (maxLng - minLng - padLng*2);
      const value = MAC.BOT_VALUE_MIN + Math.floor(Math.random() * (MAC.BOT_VALUE_MAX - MAC.BOT_VALUE_MIN));
      const defBet = Math.max(5, Math.round(value * MAC.BOT_DEF_BET_RATIO));
      // 봇 셀엔 약탈 에너지를 실어 둔다 — 신규 유저가 첫 5분에 "이기면 뜯는다"를 체험
      const loot = MAC.BOT_LOOT_MIN + Math.floor(Math.random() * (MAC.BOT_LOOT_MAX - MAC.BOT_LOOT_MIN));
      const { cellX, cellY } = latLngToCell(lat, lng);
      await client.query(
        `INSERT INTO cells (cell_x, cell_y, owner_id, tribe, value, def_bet, lat, lng, stored_energy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [cellX, cellY, bot.id, bot.tribe, value, defBet, lat, lng, loot]
      );
    }
  });
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
// playerLoc = { lat, lng } 도전자 GPS — 점유와 같은 반경 제한 (물리적 존재가 정체성)
export async function startChallenge(attackerId, target, atkBet, playerLoc) {
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

    // GPS 도전 반경 — 점유와 동일한 물리 제약
    if (playerLoc && Number.isFinite(playerLoc.lat) && Number.isFinite(playerLoc.lng)) {
      const dist = haversineM(playerLoc.lat, playerLoc.lng, Number(cell.lat), Number(cell.lng));
      if (dist > MAC.CHALLENGE_RADIUS_M) {
        const km = (MAC.CHALLENGE_RADIUS_M / 1000).toFixed(1);
        throw new Error(`현재 위치에서 ${km}km 이내의 영역만 도전 가능 (현재 ${(dist/1000).toFixed(2)}km)`);
      }
    } else {
      throw new Error('도전하려면 위치 권한이 필요합니다');
    }

    const tick = await getTick();
    if (cell.exempt_until && tick < cell.exempt_until) throw new Error('방어 면제 기간');

    const atk = (await client.query(`SELECT * FROM players WHERE id=$1 FOR UPDATE`, [attackerId])).rows[0];
    const def = (await client.query(`SELECT * FROM players WHERE id=$1`, [cell.owner_id])).rows[0];
    if (!atk) throw new Error('도전자 없음');

    // 수면 보호 — 방어자가 오프라인 전환 후 BASE_HOURS 안이면 도전 불가 (봇 제외)
    if (def && !def.is_bot && def.last_seen) {
      const offlineMs = Date.now() - new Date(def.last_seen).getTime();
      const offlineAfter = CONFIG.SHIELD.OFFLINE_AFTER_MIN * 60 * 1000;
      const shieldEnd = offlineAfter + CONFIG.SHIELD.BASE_HOURS * 3600 * 1000;
      if (offlineMs > offlineAfter && offlineMs < shieldEnd) {
        const remainH = Math.ceil((shieldEnd - offlineMs) / 3600000);
        throw new Error(`방어자 수면 보호 중 (약 ${remainH}시간 후 해제)`);
      }
    }

    // 베팅 검증 (명세서 6장) — 자산 = 에너지 + 보유 셀 가치 합
    const minBet = Math.ceil(cell.def_bet * CONFIG.BETTING.CHALLENGE_MIN_RATIO);
    if (atkBet < minBet) throw new Error(`최소 베팅 ${minBet} 이상 필요`);
    const cellsValue = Number((await client.query(
      `SELECT COALESCE(SUM(value),0) v FROM cells WHERE owner_id=$1`, [attackerId])).rows[0].v);
    const atkAssets = Number(atk.energy) + cellsValue;
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
    const hero = { atk: !!atk.is_hero, def: !!(def && def.is_hero) };
    const tribeAdv = tribeAdvOf(atk, def);
    return { battle: b, cell, attacker: atk, defender: def, proximity, hero, tribeAdv };
  });
}

// 종족 상성: 우세 진영 ('atk'|'def'|null) — 마이크로 생산 보너스로 반영
function tribeAdvOf(atk, def) {
  if (!atk || !def) return null;
  if (tribeBeats(atk.tribe, def.tribe)) return 'atk';
  if (tribeBeats(def.tribe, atk.tribe)) return 'def';
  return null;
}

// PvP 아레나 생성용 전투 컨텍스트 — 서버가 직접 재계산 (클라 값 신뢰 안 함)
export async function getBattleContext(battleId) {
  const b = (await query(`SELECT * FROM battles WHERE id=$1`, [Number(battleId)])).rows[0];
  if (!b || b.status !== 'active') return null;
  const cell = (await query(`SELECT * FROM cells WHERE id=$1`, [b.cell_id])).rows[0];
  const atk = (await query(`SELECT * FROM players WHERE id=$1`, [b.attacker_id])).rows[0];
  const def = (await query(`SELECT * FROM players WHERE id=$1`, [b.defender_id])).rows[0];
  if (!cell || !atk || !def) return null;
  const shim = { query };   // countProximityCells는 client 인터페이스만 필요
  const proximity = await countProximityCells(
    shim, Number(cell.lat), Number(cell.lng),
    CONFIG.MICRO.PROXIMITY_RADIUS_M, b.attacker_id, b.defender_id);
  return {
    atkId: b.attacker_id, defId: b.defender_id,
    atkBet: Number(b.atk_bet), defBet: Number(b.def_bet),
    proximity,
    hero: { atk: !!atk.is_hero, def: !!def.is_hero },
    tribeAdv: tribeAdvOf(atk, def),
  };
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
      const hero = { atk: !!atk.is_hero, def: !!(def && def.is_hero) };
      const tribeAdv = tribeAdvOf(atk, def);
      return { battle: b, cell, attacker: atk, defender: def, proximity, hero, tribeAdv, challengerId: next.challenger_id };
    }
  });
}

// ---- 수확 — 타워에 쌓인 에너지를 지갑으로 ----
// amount 미지정 시 전부. 지갑 상한(MAX_ENERGY) 넘는 만큼은 타워에 남는다 (증발 없음).
export async function harvestCell(playerId, cellId, amount) {
  return tx(async (client) => {
    const cell = (await client.query(`SELECT * FROM cells WHERE id=$1 FOR UPDATE`, [Number(cellId)])).rows[0];
    if (!cell) throw new Error('셀 없음');
    if (cell.owner_id !== Number(playerId)) throw new Error('내 영역이 아닙니다');
    const p = (await client.query(`SELECT * FROM players WHERE id=$1 FOR UPDATE`, [playerId])).rows[0];
    if (!p) throw new Error('플레이어 없음');

    const stored = Number(cell.stored_energy) || 0;
    let want = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : stored;
    want = Math.min(want, stored);
    const room = Math.max(0, MAC.MAX_ENERGY - Number(p.energy));   // 지갑 여유
    const harvested = Math.min(want, room);
    if (harvested <= 0) {
      if (stored <= 0) throw new Error('수확할 에너지가 없습니다');
      throw new Error(`지갑이 가득 찼습니다 (상한 ${MAC.MAX_ENERGY})`);
    }
    await client.query(`UPDATE cells SET stored_energy = stored_energy - $1::real WHERE id=$2`, [harvested, cellId]);
    await client.query(`UPDATE players SET energy = energy + $1::real WHERE id=$2`, [harvested, playerId]);
    await incQuest(client, playerId, 'harvest', harvested);
    return {
      harvested,
      stored: stored - harvested,
      energy: Number(p.energy) + harvested,
    };
  });
}

// ---- 방어 베팅 재설정 — 직접 응전 수락 시 (명세서 2.6) ----
// 올리는 것만 허용 (낮추면 도전자가 본 기대 보상이 깎이므로).
export async function raiseDefenseBet(battleId, defenderId, newDefBet) {
  return tx(async (client) => {
    const b = (await client.query(`SELECT * FROM battles WHERE id=$1 FOR UPDATE`, [Number(battleId)])).rows[0];
    if (!b || b.status !== 'active') throw new Error('유효하지 않은 전투');
    if (Number(b.defender_id) !== Number(defenderId)) throw new Error('방어자만 가능');
    const def = (await client.query(`SELECT * FROM players WHERE id=$1`, [defenderId])).rows[0];
    const bet = Math.round(Number(newDefBet));
    if (!Number.isFinite(bet) || bet < Number(b.def_bet)) return { defBet: Number(b.def_bet) }; // 낮추기 불가 — 무시
    if (bet > Number(def.energy)) throw new Error('에너지 부족');
    await client.query(`UPDATE battles SET def_bet=$1 WHERE id=$2`, [bet, battleId]);
    return { defBet: bet };
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

    // 승패 결정 우선순위:
    // 1) opts.pvpWinner — 서버 내부 경로만 (큐 차례 미응답 등). REST에서는 받지 않는다.
    // 2) opts.reports — 소켓으로 양쪽 클라가 보고한 결과. 일치 → 채택, 불일치 → 서버 시뮬.
    // 3) opts.clientWinner — vs AI 전투의 클라 결과. 화면에서 이긴 사람이 지는 일이 없도록
    //    원칙적으로 신뢰하되, 서버 승률 추정이 0이면 (불가능한 승리 주장) 시뮬로 대체.
    // 4) 아무것도 없으면 서버 시뮬.
    let result;
    const rep = opts.reports || {};
    if (opts.pvpWinner === 'attacker' || opts.pvpWinner === 'defender') {
      result = { winner: opts.pvpWinner, t: 0 };
    } else if (rep.atk || rep.def) {
      if (rep.atk && rep.def && rep.atk !== rep.def) {
        result = simulateBattle(Number(b.atk_bet), Number(b.def_bet), opts);  // 보고 충돌 — 서버 판정
      } else {
        result = { winner: rep.atk || rep.def, t: 0 };
      }
    } else if (opts.clientWinner === 'attacker' || opts.clientWinner === 'defender') {
      result = { winner: opts.clientWinner, t: 0 };
      if (opts.clientWinner === 'attacker') {
        const prob = estimateWinProb(Number(b.atk_bet), Number(b.def_bet), opts, 9);
        if (prob === 0) result = simulateBattle(Number(b.atk_bet), Number(b.def_bet), opts);
      }
    } else {
      result = simulateBattle(Number(b.atk_bet), Number(b.def_bet), opts);
    }
    const tick = await getTick();

    let reward = null;   // 승자 보상 상세 (결과 화면용)
    if (result.winner === 'attacker') {
      // 도전 성공: 점유 이전 + 베팅 흡수 + *타워에 쌓인 미수확 에너지 약탈*
      // (수확 안 하고 방치하면 뺏긴다 — 수확 루프의 긴장 장치)
      const atk = (await client.query(`SELECT * FROM players WHERE id=$1`, [b.attacker_id])).rows[0];
      const loot = Number(cell.stored_energy) || 0;
      reward = { defBet: Number(b.def_bet), loot, cellValue: Number(cell.value) };
      // 데일리 퀘스트 진행
      await incQuest(client, b.attacker_id, 'win', 1);
      if (loot >= 1) await incQuest(client, b.attacker_id, 'raid', 1);
      await client.query(
        `UPDATE cells SET owner_id=$1, tribe=$2, def_bet=$3, def_wins=0, exempt_until=NULL, stored_energy=0 WHERE id=$4`,
        [b.attacker_id, atk.tribe, Math.min(cell.value, b.atk_bet), cell.id]
      );
      // 승자: combat_wins는 *평생 누적* (사망 시점 글로리 계산용). 연승 리셋 없음.
      await client.query(`UPDATE players SET energy = LEAST(energy + $1::real, $4::real),
        wins = wins + 1, combat_wins = combat_wins + 1, karma = karma + $2::real WHERE id=$3`,
        [Number(b.def_bet) + loot, ECO.KARMA_COMBAT_WIN, b.attacker_id, MAC.MAX_ENERGY]);
      await client.query(`UPDATE players SET energy = GREATEST(0, energy - $1), losses = losses + 1 WHERE id=$2`,
        [b.def_bet, b.defender_id]);
    } else {
      // 방어 성공: 도전자 베팅을 *방어자가 획득* (증발 아님 — 방어에도 보상이 있어야 지킬 맛이 난다)
      reward = { atkBet: Number(b.atk_bet) };
      await client.query(`UPDATE players SET energy = GREATEST(0, energy - $1), losses = losses + 1 WHERE id=$2`,
        [b.atk_bet, b.attacker_id]);
      await client.query(`UPDATE players SET energy = LEAST(energy + $1::real, $2::real) WHERE id=$3`,
        [Number(b.atk_bet), MAC.MAX_ENERGY, b.defender_id]);
      await incQuest(client, b.defender_id, 'win', 1);   // 방어 승리도 전투 승리 퀘스트
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

    // 사망 + 영웅 환생 — 도전 성공으로 방어자가 마지막 셀까지 잃으면 "사망"
    // 사망 시 누적 노력(combat_wins, karma)에 비례한 확률로 영웅 환생
    // "단순 사망 숫자가 아니라 열심히 하다가 안타깝게 사망해야 영웅 확률"
    let deathInfo = null;
    if (result.winner === 'attacker') {
      const defCells = Number((await client.query(
        `SELECT COUNT(*)::int AS n FROM cells WHERE owner_id=$1`, [b.defender_id]
      )).rows[0].n);
      if (defCells === 0) {
        const dp = (await client.query(
          `SELECT combat_wins, karma FROM players WHERE id=$1`, [b.defender_id]
        )).rows[0];
        const cw = Number(dp.combat_wins) || 0;
        const km = Number(dp.karma) || 0;
        const glory = cw * MAC.HERO_GLORY_PER_WIN + km * MAC.HERO_GLORY_PER_KARMA;
        const prob = Math.min(MAC.HERO_PROB_CAP, glory / MAC.HERO_PROB_DIVISOR);
        const heroRolled = Math.random() < prob;
        if (heroRolled) {
          await client.query(
            `UPDATE players SET combat_wins=0, karma=0,
             is_hero=TRUE, hero_until=$1, hero_power=10 WHERE id=$2`,
            [tick + MAC.HERO_DURATION_TICKS, b.defender_id]
          );
        } else {
          // 평범한 사망 — 노력 부족, 영웅 안 됨, 모든 누적치 리셋
          await client.query(
            `UPDATE players SET combat_wins=0, karma=0, is_hero=FALSE, hero_until=NULL WHERE id=$1`,
            [b.defender_id]
          );
        }
        deathInfo = { playerId: b.defender_id, glory, prob, heroRolled };
      }
    }

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

    // (모듈 최상단의 MAC 사용 — local 재선언은 TDZ를 유발해 영웅 트리거가 깨졌었다)
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
    // 활동 피드용 이름 (전투 참가자)
    const names = (await client.query(
      `SELECT a.username AS attacker, d.username AS defender
       FROM battles bb LEFT JOIN players a ON a.id=bb.attacker_id
                       LEFT JOIN players d ON d.id=bb.defender_id
       WHERE bb.id=$1`, [battleId])).rows[0] || {};
    return { winner: result.winner, battleTime: result.t, restUntil, restSec, restReason,
             consec, daily, death: deathInfo, reward, names, cellValue: Number(cell.value) };
  });
}

// ============================================================
//  생태계 서버 틱 — 수입, 자연사/환생, 종족 상성 압박, 영웅
//  주기적으로 호출 (SERVER_TICK_MS).
// ============================================================
export async function ecosystemTick(io) {
  const tick = (await getTick()) + 1;
  await setTick(tick);

  // 1) 생산 — 각 타워가 *자기 위에* 에너지 누적 (수확 루프, GAME_SPEC 2.3)
  //    생산률 = PROD_COEF × value /초, 저장 상한 = CAP_FACTOR × value.
  //    가득 차면 생산 정지 → 수확해야 재개. 지갑은 수확으로만 늘어난다.
  const tickSec = MAC.SERVER_TICK_MS / 1000;
  await query(`
    UPDATE cells c SET stored_energy = LEAST(c.value * $2::real, c.stored_energy + c.value * $1::real)
    FROM players p
    WHERE p.id = c.owner_id AND p.alive AND NOT p.is_bot
      AND c.stored_energy < c.value * $2::real
  `, [MAC.PROD_COEF * tickSec, MAC.CAP_FACTOR]);

  // 1b) 봇 셀 청소 — TTL 지난 봇 셀 제거 (시간당 1회면 충분)
  if (tick % 720 === 0) {
    await query(`
      DELETE FROM cells c USING players p
      WHERE c.owner_id = p.id AND p.is_bot
        AND c.claimed_at < now() - ($1 || ' days')::interval
    `, [MAC.BOT_CELL_TTL_DAYS]);
  }

  // 2) 카르마 누적 (생존 + 영토) — 봇 제외
  await query(`
    UPDATE players p SET karma = karma + $1::real + COALESCE(sub.cnt,0) * $2::real
    FROM (SELECT owner_id, COUNT(*) cnt FROM cells WHERE owner_id IS NOT NULL GROUP BY owner_id) sub
    WHERE p.id = sub.owner_id AND p.alive AND NOT p.is_bot
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
