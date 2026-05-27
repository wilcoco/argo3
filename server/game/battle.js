// ============================================================
//  마이크로 전투 엔진 (서버 권위 판정)
//  06_full 엔진 + 중앙 노른자 + 진화 챔피언 AI.
//  클라이언트가 실시간 렌더링하되, 최종 승패는 서버가 이 엔진으로 검증.
//  베팅이 시작 에너지(전력)가 되고, 한쪽 전멸 시 결판.
// ============================================================
import { CONFIG } from './config.js';

const M = CONFIG.MICRO;
const ARENA_R = 230;            // 정규화 아레나 반경 (서버 판정용 고정)
const DT = 1 / 30;
const MAX_T = 90;

const tCost = (r) => r;
const tProd = (r) => r * M.PROD_COEF;
const tHp = (r) => r;

function overlapArea(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const a3 = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a1 + a2 - a3;
}

// 한 명의 봇 전략 (유전자 기반). 챔피언을 약화시켜 자동방어로 사용.
function makeBot(gene, strength = 1) {
  return {
    gene,
    strength,
    cd: 0,
  };
}

// 서버 권위 전투: 도전자(베팅 atkBet) vs 방어자(베팅 defBet, AI)
// 양쪽 다 AI로 시뮬해 승패를 정한다. (실시간 클라 입력은 별도 동기화)
// 도전자 측엔 약간의 인간 우위(플레이어가 직접 조작)를 부여할 수 있음.
export function simulateBattle(atkBet, defBet, opts = {}) {
  const playerSkill = opts.playerSkill ?? 0.5;     // 0~1, 도전자(인간) 실력
  const aiStrength = opts.aiStrength ?? M.AI_STRENGTH;

  let towers = [];
  let projectiles = [];
  let nextId = 0;
  const energy = { atk: atkBet, def: defBet };
  const champ = M.CHAMPION;

  // 시작 거점
  function addTower(side, x, y, r) {
    if (x * x + y * y > ARENA_R * ARENA_R) return false;
    const e = side === 'atk' ? 'atk' : 'def';
    if (energy[e] < tCost(r)) return false;
    energy[e] -= tCost(r);
    towers.push({ id: nextId++, side, x, y, radius: r, maxHp: tHp(r), hp: tHp(r) });
    return true;
  }
  addTower('atk', -ARENA_R * 0.45, 0, 25);
  addTower('def', ARENA_R * 0.45, 0, 25);

  const sideTowers = (s) => towers.filter((t) => t.side === s);

  function calcRate() {
    const res = new Array(towers.length).fill(0);
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      const same = towers.filter((o) => o.side === t.side);
      const N = 16; let c = 0;
      for (let s = 0; s < N; s++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * t.radius;
        const px = t.x + Math.cos(a) * d, py = t.y + Math.sin(a) * d;
        let cov = 0;
        for (const o of same) { const dx = px - o.x, dy = py - o.y; if (dx*dx+dy*dy <= o.radius*o.radius) cov++; }
        if (cov > 0) c += 1 / cov;
      }
      // 중앙 노른자 보너스
      const inCore = (t.x*t.x + t.y*t.y) <= (ARENA_R*M.CORE_RADIUS_FRAC)**2;
      res[i] = tProd(t.radius) * (c / N) * (inCore ? M.CORE_PROD_MULT : 1);
    }
    let ra = 0, rd = 0;
    for (let i = 0; i < towers.length; i++) (towers[i].side === 'atk' ? (ra += res[i]) : (rd += res[i]));
    return { atk: ra, def: rd };
  }

  function areaCombat(dt) {
    const C = M.COMBAT_C;
    for (let i = 0; i < towers.length; i++)
      for (let j = i + 1; j < towers.length; j++) {
        const a = towers[i], b = towers[j];
        if (a.side === b.side) continue;
        const dx = a.x - b.x, dy = a.y - b.y, d = Math.sqrt(dx*dx+dy*dy);
        if (d >= a.radius + b.radius) continue;
        const ov = overlapArea(a.radius, b.radius, d);
        const dmg = ov * 0.02 * C * dt * 60;
        a.hp -= dmg; b.hp -= dmg;
      }
  }

  // 영역 겹친 아군 = 같은 클러스터. from 본인 포함.
  function cluster(from) {
    return towers.filter((t) =>
      t.side === from.side &&
      Math.hypot(t.x - from.x, t.y - from.y) <= t.radius + from.radius
    );
  }

  // 단발 사격 (본인 HP 35% 소모, 거리 비례 감쇠)
  function fire(from, to) {
    if (!towers.includes(from) || !towers.includes(to)) return;
    const cost = Math.floor(from.hp * M.RANGED_COST_RATIO);
    if (cost < 3) return;
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const fall = Math.max(0.15, 1 - d / 700);
    from.hp -= cost;
    to.hp -= cost * fall;
  }
  // 클러스터 사격 (선택 탑 + 영역 겹친 아군이 동시 발사)
  function fireCluster(from, to) {
    for (const t of cluster(from)) fire(t, to);
  }

  // 봇 행동 (도전자/방어자 공통, 강도로 차등)
  function act(side, strength) {
    const mine = sideTowers(side);
    const foe = sideTowers(side === 'atk' ? 'def' : 'atk');
    const e = side;
    // 사격 분기 — 챔피언의 snipe 비율로 사격 시도
    if (mine.length && foe.length && Math.random() < strength * champ.snipe) {
      // 클러스터가 가장 큰 자기 탑 선택 (화력 최대화)
      let best = mine[0], bestSize = cluster(best).length;
      for (const t of mine) {
        const sz = cluster(t).length;
        if (sz > bestSize) { best = t; bestSize = sz; }
      }
      // 사격 임계: 본인 HP가 충분할 때만
      if (best.hp / best.maxHp >= champ.rangedThresh) {
        // 목표: 체력 낮은 적 (마무리)
        const target = foe.slice().sort((a, b) => a.hp - b.hp)[0];
        fireCluster(best, target);
        return;  // 한 행동 = 한 사격 또는 한 빌드
      }
    }
    // 빌드 분기
    if (mine.length >= champ.maxTowers) return;
    const r = strength > 0.5 ? champ.towerSize + Math.random()*8 : 30 + Math.random()*20;
    if (energy[e] < tCost(r)) return;
    const coreR = ARENA_R * M.CORE_RADIUS_FRAC;
    let best = null, bestScore = -1e9;
    const cand = 4 + Math.round(strength * 8);
    for (let k = 0; k < cand; k++) {
      let x, y;
      if (Math.random() < strength) {
        x = (Math.random()-0.5)*coreR*1.5; y = (Math.random()-0.5)*coreR*1.5;
      } else if (mine.length) {
        const base = mine[Math.random()*mine.length|0];
        x = base.x + (Math.random()-0.5)*120; y = base.y + (Math.random()-0.5)*120;
      } else {
        const sx = side === 'atk' ? -1 : 1;
        x = sx*ARENA_R*0.4 + (Math.random()-0.5)*60; y = (Math.random()-0.5)*60;
      }
      if (x*x + y*y > ARENA_R*ARENA_R) continue;
      let score = 0;
      const dc = Math.hypot(x, y);
      if (dc <= coreR) score += 100; else score += Math.max(0, ARENA_R - dc) * 0.1;
      // 아군 겹침 — allyAvoid가 페널티 강도. 새 규칙(클러스터 화력)에선 약하게.
      // 두 효과 동시: 약한 페널티(생산↓) + 약한 보너스(클러스터 잠재력↑)
      for (const o of mine) {
        const dx = x-o.x, dy = y-o.y, dist = Math.hypot(dx, dy);
        if (dist < r+o.radius) {
          score -= (champ.allyAvoid ?? strength) * (r+o.radius-dist) * 3;
          score += champ.clusterPref * 1.5; // 클러스터링 보너스 (새 챔피언 유전자)
        }
      }
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
    if (best) addTower(side, best.x, best.y, r);
  }

  let t = 0;
  const startGrace = 4;
  while (t < MAX_T) {
    t += DT;
    const rate = calcRate();
    energy.atk = Math.min(9999, energy.atk + rate.atk * DT);
    energy.def = Math.min(9999, energy.def + rate.def * DT);
    areaCombat(DT);
    // 사망
    for (let i = towers.length - 1; i >= 0; i--) if (towers[i].hp <= 0) towers.splice(i, 1);
    // 행동: 도전자는 playerSkill, 방어자는 aiStrength
    act('atk', playerSkill);
    act('def', aiStrength);
    // 승패
    if (t > startGrace) {
      const atkHas = sideTowers('atk').length, defHas = sideTowers('def').length;
      if (!atkHas && energy.atk < 15) return { winner: 'defender', t };
      if (!defHas && energy.def < 15) return { winner: 'attacker', t };
    }
  }
  // 타임아웃: 총 체력 비교
  const ha = sideTowers('atk').reduce((s, x) => s + x.hp, 0);
  const hd = sideTowers('def').reduce((s, x) => s + x.hp, 0);
  return { winner: ha >= hd ? 'attacker' : 'defender', t };
}

// 승률 추정 (여러 번 시뮬해 평균) — 매칭/표시용
export function estimateWinProb(atkBet, defBet, opts = {}, runs = 9) {
  let w = 0;
  for (let i = 0; i < runs; i++) if (simulateBattle(atkBet, defBet, opts).winner === 'attacker') w++;
  return w / runs;
}
