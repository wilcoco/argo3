// ============================================================
//  마이크로 전투 엔진 (서버 권위 판정) — 바둑·오델로식
//  · 균일 돌, 자동 공격, 만렙 변환, 탑별 생산
//  · AI 폴백 결과 판정에 사용 (도전자 미응답 → 서버가 양쪽 AI로 시뮬)
//  · 시그니처는 기존 그대로: simulateBattle(atkBet, defBet, opts)
// ============================================================
import { CONFIG } from './config.js';

const M = CONFIG.MICRO;
const ARENA_R = 230;
const DT = 1 / 30;
const MAX_T = M.MAX_T;
const STONE_R = M.STONE_R;
const MIN_SPACING = M.STONE_R * M.MIN_SPACING_FACTOR;
const ATTACK_RANGE = M.STONE_R * M.ATTACK_RANGE_FACTOR;

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

export function simulateBattle(atkBet, defBet, opts = {}) {
  const playerSkill = opts.playerSkill ?? 0.85;
  const aiStrength = opts.aiStrength ?? M.AI_STRENGTH;
  const proximity = opts.proximity || { atk: 0, def: 0 };
  const hero = opts.hero || { atk: false, def: false };
  const tribeAdv = opts.tribeAdv || null;   // 'atk'|'def'|null — 종족 상성 우세 진영 생산 보너스

  const stones = [];
  let nextId = 0;
  const energy = { atk: atkBet, def: defBet };
  const placeCD = { atk: 0, def: 0 };

  function tooClose(x, y) {
    for (const s of stones) if (Math.hypot(s.x - x, s.y - y) < MIN_SPACING) return true;
    return false;
  }
  function inArena(x, y) { return x*x + y*y <= ARENA_R * ARENA_R; }
  function ringOf(x, y) {
    const d = Math.hypot(x, y) / ARENA_R;
    if (d <= M.RING_INNER_R)  return 'inner';
    if (d <= M.RING_MIDDLE_R) return 'middle';
    return 'outer';
  }
  function ringCost(x, y) {
    const r = ringOf(x, y);
    return r === 'inner' ? M.RING_INNER_COST : r === 'middle' ? M.RING_MIDDLE_COST : M.RING_OUTER_COST;
  }
  function ringIncome(x, y) {
    const r = ringOf(x, y);
    return r === 'inner' ? M.RING_INNER_INCOME : r === 'middle' ? M.RING_MIDDLE_INCOME : M.RING_OUTER_INCOME;
  }
  function place(side, x, y, free = false) {
    if (!inArena(x, y) || tooClose(x, y)) return false;
    const cost = ringCost(x, y);
    if (!free) {
      if (energy[side] < cost) return false;
      if (placeCD[side] > 0) return false;
      energy[side] -= cost;
      placeCD[side] = M.PLACE_COOLDOWN;
    }
    stones.push({ id: nextId++, side, x, y, hp: M.STONE_HP_MAX });
    return true;
  }

  // 시작 돌 — 양 끝 + 보급선
  function seed(side, sign, extra) {
    const baseX = sign * ARENA_R * 0.65;
    const total = 1 + Math.min(extra || 0, M.PROXIMITY_BONUS_MAX);
    const spread = MIN_SPACING * 1.05;
    for (let i = 0; i < total; i++) {
      const off = (i - (total - 1) / 2) * spread;
      place(side, baseX, off, true);
    }
  }
  seed('atk', -1, proximity.atk);
  seed('def',  1, proximity.def);

  function pickPlacement(side, strength) {
    const mine = stones.filter(s => s.side === side);
    const foe = stones.filter(s => s.side !== side);
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      let x, y;
      if (foe.length && Math.random() < strength * 0.7) {
        const t = foe[Math.random() * foe.length | 0];
        const a = Math.random() * Math.PI * 2;
        const r = MIN_SPACING + Math.random() * 30;
        x = t.x + Math.cos(a) * r; y = t.y + Math.sin(a) * r;
      } else if (mine.length && Math.random() < 0.5) {
        const t = mine[Math.random() * mine.length | 0];
        const a = Math.random() * Math.PI * 2;
        const r = MIN_SPACING + Math.random() * 20;
        x = t.x + Math.cos(a) * r; y = t.y + Math.sin(a) * r;
      } else {
        const sx = side === 'atk' ? -1 : 1;
        x = sx * ARENA_R * 0.5 + (Math.random() - 0.5) * ARENA_R * 0.8;
        y = (Math.random() - 0.5) * ARENA_R * 0.9;
      }
      if (!inArena(x, y) || tooClose(x, y)) continue;
      let score = 0;
      for (const f of foe) {
        const d = Math.hypot(f.x - x, f.y - y);
        if (d <= ATTACK_RANGE * 1.5) score += (ATTACK_RANGE * 1.5 - d) * 0.5;
      }
      let near = 0;
      for (const m of mine) if (Math.hypot(m.x - x, m.y - y) <= ATTACK_RANGE * 2) near++;
      score += Math.min(near, 2) * 8;
      score -= Math.max(0, near - 3) * 4;
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
    return best;
  }

  let t = 0;
  const startGrace = 4;
  while (t < MAX_T) {
    t += DT;
    // 생산 (링별 소득)
    let rateAtk = 0, rateDef = 0;
    for (const s of stones) {
      const r = ringIncome(s.x, s.y);
      if (s.side === 'atk') rateAtk += r; else rateDef += r;
    }
    if (hero.atk) rateAtk *= 1 + M.HERO_INCOME_BONUS;
    if (hero.def) rateDef *= 1 + M.HERO_INCOME_BONUS;
    if (tribeAdv === 'atk') rateAtk *= 1 + M.TRIBE_ADV_INCOME_BONUS;
    if (tribeAdv === 'def') rateDef *= 1 + M.TRIBE_ADV_INCOME_BONUS;
    energy.atk = Math.min(9999, energy.atk + rateAtk * DT);
    energy.def = Math.min(9999, energy.def + rateDef * DT);
    placeCD.atk = Math.max(0, placeCD.atk - DT);
    placeCD.def = Math.max(0, placeCD.def - DT);

    // 자동 공격
    const incoming = new Map();
    const range = ATTACK_RANGE + STONE_R * 2;
    for (let i = 0; i < stones.length; i++) {
      for (let j = 0; j < stones.length; j++) {
        if (i === j) continue;
        const a = stones[i], b = stones[j];
        if (a.side === b.side) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) <= range) {
          b.hp -= M.DPS_PER_ATTACKER * DT;
          if (!incoming.has(j)) incoming.set(j, { atk:0, def:0 });
          incoming.get(j)[a.side]++;
        }
      }
    }
    // 사망/변환
    for (let i = stones.length - 1; i >= 0; i--) {
      const s = stones[i];
      if (s.hp > 0) continue;
      const inc = incoming.get(i);
      if (!inc || inc.atk === inc.def) { stones.splice(i, 1); continue; }
      const winnerSide = inc.atk > inc.def ? 'atk' : 'def';
      if (winnerSide === s.side) {
        stones.splice(i, 1);
      } else {
        s.side = winnerSide;
        s.hp = M.FLIP_HP;
      }
    }

    // 양쪽 봇 행동
    for (const side of ['atk', 'def']) {
      const strength = side === 'atk' ? playerSkill : aiStrength;
      if (energy[side] >= M.RING_OUTER_COST && placeCD[side] <= 0 && Math.random() < 0.85) {
        const pick = pickPlacement(side, strength);
        if (pick) place(side, pick.x, pick.y);
      }
    }

    // 승패
    if (t > startGrace) {
      const an = stones.filter(s => s.side === 'atk').length;
      const dn = stones.filter(s => s.side === 'def').length;
      if (!an && energy.atk < M.RING_OUTER_COST) return { winner: 'defender', t };
      if (!dn && energy.def < M.RING_OUTER_COST) return { winner: 'attacker', t };
    }
  }
  // 타임아웃 — 다수 승
  const an = stones.filter(s => s.side === 'atk').length;
  const dn = stones.filter(s => s.side === 'def').length;
  return { winner: an >= dn ? 'attacker' : 'defender', t };
}

export function estimateWinProb(atkBet, defBet, opts = {}, runs = 5) {
  let w = 0;
  for (let i = 0; i < runs; i++) {
    if (simulateBattle(atkBet, defBet, opts).winner === 'attacker') w++;
  }
  return w / runs;
}
