// ============================================================
//  PvP 아레나 — 서버 권위 실시간 전투
//  · 서버가 유일한 진실: 클라는 입력만 보내고 스냅샷을 렌더
//  · 좌표계: 중심 (0,0), 반경 ARENA_R=230 (클라가 화면 크기에 맞게 스케일)
//  · 돌은 이동하지 않으므로 예측/보간 불필요 — 10Hz 스냅샷으로 충분
//  · 종료 시 서버가 직접 resolveChallenge (pvpWinner 신뢰 경로) → 위조 원천 차단
// ============================================================
import { CONFIG } from './config.js';

const M = CONFIG.MICRO;
export const ARENA_R = 230;
const SIM_MS = 50;          // 20Hz 시뮬
const SNAP_EVERY = 2;       // 10Hz 스냅샷
const START_GRACE = 4;      // 시작 유예 (초) — 이 전엔 전멸 판정 없음

const STONE_R = M.STONE_R;
const MIN_SPACING = STONE_R * M.MIN_SPACING_FACTOR;
const ATTACK_RANGE = STONE_R * M.ATTACK_RANGE_FACTOR + STONE_R * 2;

export class PvpArena {
  // opts: { atkId, defId, atkBet, defBet, proximity, hero, tribeAdv }
  // hooks: { broadcast(event, payload), onEnd(winner) }
  constructor(battleId, opts, hooks) {
    this.battleId = battleId;
    this.atkId = Number(opts.atkId);
    this.defId = Number(opts.defId);
    this.hero = opts.hero || { atk: false, def: false };
    this.tribeAdv = opts.tribeAdv || null;
    this.broadcast = hooks.broadcast;
    this.onEnd = hooks.onEnd;

    this.stones = [];
    this.nextId = 1;
    this.energy = { atk: Number(opts.atkBet), def: Number(opts.defBet) };
    this.placeCD = { atk: 0, def: 0 };
    this.focus = { atk: null, def: null };   // {ids:Set, targetId}
    this.t = 0;
    this.ended = false;
    this._tickN = 0;

    const prox = opts.proximity || { atk: 0, def: 0 };
    this._seed('atk', -1, Math.min(prox.atk || 0, M.PROXIMITY_BONUS_MAX));
    this._seed('def', 1, Math.min(prox.def || 0, M.PROXIMITY_BONUS_MAX));

    this.timer = setInterval(() => this._tick(SIM_MS / 1000), SIM_MS);
  }

  sideOf(playerId) {
    if (Number(playerId) === this.atkId) return 'atk';
    if (Number(playerId) === this.defId) return 'def';
    return null;
  }

  _seed(side, sign, extra) {
    const baseX = sign * ARENA_R * 0.65;
    const total = 1 + extra;
    const spread = MIN_SPACING * 1.05;
    for (let i = 0; i < total; i++) {
      const off = (i - (total - 1) / 2) * spread;
      if (this._inArena(baseX, off) && !this._tooClose(baseX, off)) {
        this.stones.push({ id: this.nextId++, side, x: baseX, y: off, hp: M.STONE_HP_MAX });
      }
    }
  }

  _inArena(x, y) { return x * x + y * y <= ARENA_R * ARENA_R; }
  _tooClose(x, y) {
    for (const s of this.stones) if (Math.hypot(s.x - x, s.y - y) < MIN_SPACING) return true;
    return false;
  }
  _ringCost(x, y) {
    const d = Math.hypot(x, y) / ARENA_R;
    if (d <= M.RING_INNER_R) return M.RING_INNER_COST;
    if (d <= M.RING_MIDDLE_R) return M.RING_MIDDLE_COST;
    return M.RING_OUTER_COST;
  }
  _ringIncome(x, y) {
    const d = Math.hypot(x, y) / ARENA_R;
    if (d <= M.RING_INNER_R) return M.RING_INNER_INCOME;
    if (d <= M.RING_MIDDLE_R) return M.RING_MIDDLE_INCOME;
    return M.RING_OUTER_INCOME;
  }

  // ---- 입력 (서버가 전부 검증) ----
  input(playerId, action) {
    if (this.ended) return { ok: false, why: 'ended' };
    const side = this.sideOf(playerId);
    if (!side) return { ok: false, why: 'not-participant' };
    if (!action || typeof action !== 'object') return { ok: false, why: 'bad-action' };

    if (action.type === 'place') {
      const x = Number(action.x), y = Number(action.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, why: 'bad-xy' };
      if (!this._inArena(x, y)) return { ok: false, why: 'outside' };
      if (this._tooClose(x, y)) return { ok: false, why: 'tooclose' };
      if (this.placeCD[side] > 0) return { ok: false, why: 'cooldown' };
      const cost = this._ringCost(x, y);
      if (this.energy[side] < cost) return { ok: false, why: 'energy' };
      this.energy[side] -= cost;
      this.placeCD[side] = M.PLACE_COOLDOWN;
      this.stones.push({ id: this.nextId++, side, x, y, hp: M.STONE_HP_MAX });
      return { ok: true };
    }
    if (action.type === 'focus') {
      const targetId = action.targetId != null ? Number(action.targetId) : null;
      if (targetId == null || !Array.isArray(action.ids) || !action.ids.length) {
        this.focus[side] = null;   // 해제
        return { ok: true };
      }
      const target = this.stones.find((s) => s.id === targetId);
      if (!target || target.side === side) return { ok: false, why: 'bad-target' };
      // 내 돌만 집중 가능
      const ids = new Set(
        action.ids.map(Number).filter((id) =>
          this.stones.some((s) => s.id === id && s.side === side))
      );
      if (!ids.size) return { ok: false, why: 'no-stones' };
      this.focus[side] = { ids, targetId };
      return { ok: true };
    }
    return { ok: false, why: 'unknown-type' };
  }

  // ---- 시뮬 틱 ----
  _tick(dt) {
    if (this.ended) return;
    this.t += dt;

    // 생산 (링별 소득 + 영웅/상성 보너스)
    let rA = 0, rD = 0;
    for (const s of this.stones) {
      const r = this._ringIncome(s.x, s.y);
      if (s.side === 'atk') rA += r; else rD += r;
    }
    if (this.hero.atk) rA *= 1 + M.HERO_INCOME_BONUS;
    if (this.hero.def) rD *= 1 + M.HERO_INCOME_BONUS;
    if (this.tribeAdv === 'atk') rA *= 1 + M.TRIBE_ADV_INCOME_BONUS;
    if (this.tribeAdv === 'def') rD *= 1 + M.TRIBE_ADV_INCOME_BONUS;
    this.energy.atk = Math.min(9999, this.energy.atk + rA * dt);
    this.energy.def = Math.min(9999, this.energy.def + rD * dt);
    this.placeCD.atk = Math.max(0, this.placeCD.atk - dt);
    this.placeCD.def = Math.max(0, this.placeCD.def - dt);

    // 집중공격 유효성 (죽은 돌/변환된 돌 정리)
    for (const side of ['atk', 'def']) {
      const f = this.focus[side];
      if (!f) continue;
      const target = this.stones.find((s) => s.id === f.targetId);
      if (!target || target.side === side) { this.focus[side] = null; continue; }
      for (const id of f.ids) {
        const st = this.stones.find((s) => s.id === id);
        if (!st || st.side !== side) f.ids.delete(id);
      }
      if (!f.ids.size) this.focus[side] = null;
    }

    // 데미지 — 자동(사거리) + 집중(사거리 무관)
    const incoming = new Map();   // stoneId → {atk,def}
    const hit = (target, bySide, n = 1) => {
      target.hp -= M.DPS_PER_ATTACKER * dt * n;
      if (!incoming.has(target.id)) incoming.set(target.id, { atk: 0, def: 0 });
      incoming.get(target.id)[bySide] += n;
    };
    for (const a of this.stones) {
      const f = this.focus[a.side];
      if (f && f.ids.has(a.id)) {
        const target = this.stones.find((s) => s.id === f.targetId);
        if (target) { hit(target, a.side); continue; }
      }
      for (const b of this.stones) {
        if (a.side === b.side) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) <= ATTACK_RANGE) hit(b, a.side);
      }
    }

    // 사망/변환 (오델로)
    for (let i = this.stones.length - 1; i >= 0; i--) {
      const s = this.stones[i];
      if (s.hp > 0) continue;
      const inc = incoming.get(s.id);
      if (!inc || inc.atk === inc.def) { this.stones.splice(i, 1); continue; }
      const winner = inc.atk > inc.def ? 'atk' : 'def';
      if (winner === s.side) this.stones.splice(i, 1);
      else { s.side = winner; s.hp = M.FLIP_HP; s.flipped = this._tickN; }
    }

    // 승패 판정 — 서버가 유일 심판
    const an = this.stones.filter((s) => s.side === 'atk').length;
    const dn = this.stones.filter((s) => s.side === 'def').length;
    if (this.t > START_GRACE) {
      if (!an && this.energy.atk < M.RING_OUTER_COST) return this._finish('defender');
      if (!dn && this.energy.def < M.RING_OUTER_COST) return this._finish('attacker');
    }
    if (this.t >= M.MAX_T) return this._finish(an >= dn ? 'attacker' : 'defender');

    // 스냅샷 브로드캐스트 (10Hz)
    this._tickN++;
    if (this._tickN % SNAP_EVERY === 0) this.broadcast('pvp:state', this.snapshot());
  }

  snapshot() {
    return {
      battleId: this.battleId,
      t: Math.round(this.t * 10) / 10,
      remain: Math.max(0, Math.round((M.MAX_T - this.t) * 10) / 10),
      energy: { atk: Math.round(this.energy.atk * 10) / 10, def: Math.round(this.energy.def * 10) / 10 },
      stones: this.stones.map((s) => ({
        id: s.id, side: s.side, x: Math.round(s.x), y: Math.round(s.y),
        hp: Math.round(s.hp * 10) / 10,
      })),
      focus: {
        atk: this.focus.atk ? { targetId: this.focus.atk.targetId, count: this.focus.atk.ids.size } : null,
        def: this.focus.def ? { targetId: this.focus.def.targetId, count: this.focus.def.ids.size } : null,
      },
    };
  }

  _finish(winner) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.onEnd(winner);
  }

  // 외부 강제 종료 (항복 등) — side가 항복하면 상대 승리
  forfeit(playerId) {
    const side = this.sideOf(playerId);
    if (!side || this.ended) return false;
    this._finish(side === 'atk' ? 'defender' : 'attacker');
    return true;
  }

  destroy() { clearInterval(this.timer); this.ended = true; }
}
