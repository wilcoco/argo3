// ============================================================
//  마이크로 전투 — 바둑·오델로식
//  · 균일 돌 (반경·HP·비용 고정), 겹침 금지
//  · 자동 공격: 인접 적에 매 초 DPS_PER_ATTACKER × 시간
//  · 변환: 사망 시 다수 공격자 진영으로 만렙 부활 (동수면 그냥 죽음)
//  · 각 돌이 일정 생산 → 탑 많을수록 새 돌 빨리
//  · 수동: 내 돌 탭/드래그 다중선택 → 적 탭 = 선택 돌들이 그 적 집중공격
//  · 승: 한쪽 전멸 OR 타임아웃 시 다수
// ============================================================

export class Battle {
  constructor(canvas, cfg, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    this.onEnd = opts.onEnd || (() => {});
    this.colors = { atk: { s:'#3ad1c8', f:'rgba(58,209,200,0.20)', rgb:'58,209,200' },
                    def: { s:'#ff5d73', f:'rgba(255,93,115,0.20)', rgb:'255,93,115' } };
    // 마우스+터치 입력
    canvas.addEventListener('mousedown', (e) => this._onDown(e));
    canvas.addEventListener('mousemove', (e) => this._onMove(e));
    canvas.addEventListener('mouseup',   (e) => this._onUp(e));
    canvas.addEventListener('touchstart',(e) => this._onTouchStart(e), { passive:false });
    canvas.addEventListener('touchmove', (e) => this._onTouchMove(e),  { passive:false });
    canvas.addEventListener('touchend',  (e) => this._onTouchEnd(e),   { passive:false });
    // 선택 해제 버튼
    const clr = document.getElementById('clearSel');
    if (clr) clr.addEventListener('click', () => this._clearSel());
  }

  // ====== 시작 ======
  start(atkBet, defBet, regionName, battleOpts = {}) {
    const M = this.cfg.MICRO;
    this._resize();
    this.M = M;
    this.STONE_R = M.STONE_R;
    this.MIN_SPACING = M.STONE_R * M.MIN_SPACING_FACTOR;
    this.ATTACK_RANGE = M.STONE_R * M.ATTACK_RANGE_FACTOR;
    this.stones = [];
    this.energy = { atk: atkBet, def: defBet };
    this.placeCD = { atk: 0, def: 0 };
    this.aiTimer = 0;
    this.nextId = 0;
    this.running = false;
    this.startT = 0;
    this.mySide = battleOpts.mySide || 'atk';
    this.foeSide = this.mySide === 'atk' ? 'def' : 'atk';
    this.pvp = !!battleOpts.pvp;
    this.socket = battleOpts.socket || null;
    this.battleId = battleOpts.battleId || null;
    this._netAccum = 0;
    this.arena = { cx: this.W/2, cy: this.H/2, r: Math.min(this.W, this.H) * M.ARENA_RATIO };
    this.hero = battleOpts.hero || { atk:false, def:false };

    // 시작 돌 — 양 끝 + 보급선 보너스
    const prox = battleOpts.proximity || { atk:0, def:0 };
    const extraAtk = Math.min(prox.atk, M.PROXIMITY_BONUS_MAX);
    const extraDef = Math.min(prox.def, M.PROXIMITY_BONUS_MAX);
    this._seedStones('atk', extraAtk);
    this._seedStones('def', extraDef);

    document.getElementById('stakeBar').textContent =
      `베팅 ⚡${atkBet} vs ⚡${defBet} · ${regionName}` + (this.pvp ? ' · ⚔실시간 대전' : '');
    this._colorOf = (side) => (side === this.mySide ? this.colors.atk : this.colors.def);
    document.querySelector('.side.me .lbl').textContent = this.mySide === 'atk' ? 'YOU' : 'YOU(방어)';
    document.querySelector('.side.en .lbl').textContent = 'ENEMY';

    // 선택/집중 상태
    this.selSet = new Set();           // 선택된 내 돌 id 모음
    this.focusTarget = null;            // 집중공격 적 stone
    this._drag = null;                  // {x0,y0,x1,y1,active}

    if (this.pvp && this.socket) this._setupNet();
    this._countdown();
  }

  _seedStones(side, extra) {
    // 끝에서 약간 안쪽으로 시작 — 부채꼴 모양
    const sign = side === 'atk' ? -1 : 1;
    const baseX = this.arena.cx + sign * this.arena.r * 0.65;
    const total = 1 + extra;
    const spread = this.MIN_SPACING * 1.05;
    for (let i = 0; i < total; i++) {
      const off = (i - (total-1)/2) * spread;
      const x = baseX, y = this.arena.cy + off;
      if (this._inArena(x, y) && !this._tooClose(x, y)) {
        this.stones.push(this._mkStone(side, x, y));
      }
    }
  }

  _mkStone(side, x, y) {
    return { id: this.nextId++, side, x, y, hp: this.M.STONE_HP_MAX, born: performance.now() };
  }

  _inArena(x, y) {
    const dx = x - this.arena.cx, dy = y - this.arena.cy;
    return dx*dx + dy*dy <= this.arena.r * this.arena.r;
  }
  // 동심원 등고선: 위치 → 'inner'|'middle'|'outer'
  _ringOf(x, y) {
    const d = Math.hypot(x - this.arena.cx, y - this.arena.cy) / this.arena.r;
    if (d <= this.M.RING_INNER_R)  return 'inner';
    if (d <= this.M.RING_MIDDLE_R) return 'middle';
    return 'outer';
  }
  _ringCost(x, y) {
    const r = this._ringOf(x, y);
    if (r === 'inner')  return this.M.RING_INNER_COST;
    if (r === 'middle') return this.M.RING_MIDDLE_COST;
    return this.M.RING_OUTER_COST;
  }
  _ringIncome(x, y) {
    const r = this._ringOf(x, y);
    if (r === 'inner')  return this.M.RING_INNER_INCOME;
    if (r === 'middle') return this.M.RING_MIDDLE_INCOME;
    return this.M.RING_OUTER_INCOME;
  }
  _tooClose(x, y) {
    for (const s of this.stones) {
      if (Math.hypot(s.x - x, s.y - y) < this.MIN_SPACING) return true;
    }
    return false;
  }

  // ====== 카운트다운 ======
  _countdown() {
    const el = document.getElementById('countdown');
    if (!el) { this._begin(); return; }
    let n = this.M.COUNTDOWN_SEC;
    el.style.display = 'flex'; el.textContent = n;
    const tick = () => {
      n--;
      if (n <= 0) { el.style.display = 'none'; this._begin(); return; }
      el.textContent = n;
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
    requestAnimationFrame(() => this._renderOnly());
  }
  _begin() {
    this.running = true;
    this.startT = performance.now();
    this.lastT = this.startT;
    requestAnimationFrame((ts) => this._loop(ts));
  }

  // ====== 입력 처리 ======
  _evToXY(e) {
    const r = this.canvas.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: cx - r.left, y: cy - r.top };
  }
  _evChangedXY(e) {
    const r = this.canvas.getBoundingClientRect();
    const t = e.changedTouches ? e.changedTouches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  _onDown(e)  { this._dragStart(this._evToXY(e)); }
  _onMove(e)  { this._dragMove(this._evToXY(e)); }
  _onUp(e)    { this._dragEnd(this._evChangedXY(e)); }
  _onTouchStart(e){ if (e.touches.length===1){ e.preventDefault(); this._dragStart(this._evToXY(e)); } }
  _onTouchMove(e){ if (this._drag){ e.preventDefault(); this._dragMove(this._evToXY(e)); } }
  _onTouchEnd(e){ if (this._drag){ e.preventDefault(); this._dragEnd(this._evChangedXY(e)); } }

  _dragStart({x, y}) {
    this._drag = { x0:x, y0:y, x1:x, y1:y, t0:performance.now(), dragged:false };
  }
  _dragMove({x, y}) {
    if (!this._drag) return;
    this._drag.x1 = x; this._drag.y1 = y;
    const dx = x - this._drag.x0, dy = y - this._drag.y0;
    if (dx*dx + dy*dy > 64) this._drag.dragged = true;   // 드래그로 판단
  }
  _dragEnd({x, y}) {
    if (!this.running) { this._drag = null; return; }
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    const dt = performance.now() - d.t0;

    if (d.dragged) {
      // 드래그 라쏘: 사각형 안의 내 돌 다중 선택 (Set에 추가)
      this._lassoSelect(d.x0, d.y0, d.x1, d.y1);
      return;
    }
    // 짧은 탭
    if (dt > 500) return;   // 너무 길게 누름 — 무시
    this._tap(x, y);
  }

  _tap(x, y) {
    const hit = this._stoneAt(x, y);
    if (hit) {
      if (hit.side === this.mySide) {
        // 내 돌 → 선택 토글
        if (this.selSet.has(hit.id)) this.selSet.delete(hit.id);
        else this.selSet.add(hit.id);
        return;
      }
      // 적 돌
      if (this.selSet.size > 0) {
        // 집중 공격: 선택된 돌들이 이 적만 공격
        this.focusTarget = hit;
        return;
      }
      return;   // 선택 없이 적 탭은 무시
    }
    // 빈 곳 — 돌 두기 (링별 비용)
    if (!this._inArena(x, y)) { this._outsideFlash = performance.now(); return; }
    const cost = this._ringCost(x, y);
    if (this.energy[this.mySide] < cost) {
      this._notEnoughFlash = performance.now();
      this._notEnoughCost = cost;
      return;
    }
    if (this.placeCD[this.mySide] > 0) return;
    if (this._tooClose(x, y)) { this._tooCloseFlash = performance.now(); return; }
    this._place(this.mySide, x, y, cost);
  }

  _stoneAt(x, y) {
    const r2 = this.STONE_R * this.STONE_R;
    for (const s of this.stones) {
      const dx = x - s.x, dy = y - s.y;
      if (dx*dx + dy*dy <= r2) return s;
    }
    return null;
  }

  _lassoSelect(x0, y0, x1, y1) {
    const xa = Math.min(x0,x1), xb = Math.max(x0,x1);
    const ya = Math.min(y0,y1), yb = Math.max(y0,y1);
    for (const s of this.stones) {
      if (s.side !== this.mySide) continue;
      if (s.x >= xa && s.x <= xb && s.y >= ya && s.y <= yb) this.selSet.add(s.id);
    }
  }
  _clearSel() { this.selSet.clear(); this.focusTarget = null; }

  _place(side, x, y, cost) {
    const c = cost != null ? cost : this._ringCost(x, y);
    this.energy[side] -= c;
    this.placeCD[side] = this.M.PLACE_COOLDOWN;
    const st = this._mkStone(side, x, y);
    this.stones.push(st);
    this._spawnFx(x, y, side);
    if (side === this.mySide && this.pvp && this.socket) {
      this.socket.emit('battle:action', { battleId:this.battleId, action:{ type:'place', id:st.id, x, y } });
    }
  }

  _spawnFx(x, y, side) {
    this._fx = this._fx || [];
    this._fx.push({ x, y, life: 0.45, max: 0.45, side });
  }
  // 시각용 포탄 — 데미지는 별도(연속), 이건 *보이게* 만들기 위함
  _spawnProj(from, to, focused) {
    this._proj = this._proj || [];
    // 출발 방향 약간 분산
    const ang = Math.atan2(to.y - from.y, to.x - from.x) + (Math.random() - 0.5) * 0.15;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const speed = focused ? 720 : 480;     // px/sec — 집중사격이 더 빠르게
    const dur = Math.max(0.08, dist / speed);
    // 출발은 from 가장자리에서
    const sx = from.x + Math.cos(ang) * this.STONE_R;
    const sy = from.y + Math.sin(ang) * this.STONE_R;
    this._proj.push({
      sx, sy, tid: to.id, target: to,
      x: sx, y: sy, t: 0, dur, side: from.side, focused,
    });
  }
  _updateProj(dt) {
    if (!this._proj) return;
    for (let i = this._proj.length - 1; i >= 0; i--) {
      const p = this._proj[i];
      p.t += dt;
      if (p.t >= p.dur || !this.stones.includes(p.target)) {
        // 도착 — 임팩트 페인트
        this._fx = this._fx || [];
        this._fx.push({ x: p.x, y: p.y, life: 0.18, max: 0.18, side: p.side, hit: true });
        this._proj.splice(i, 1);
        continue;
      }
      const k = p.t / p.dur;
      // 살짝 휘는 곡선 (제어점 = 중간 + 수직 오프셋)
      const ex = p.target.x, ey = p.target.y;
      const mx = (p.sx + ex) / 2, my = (p.sy + ey) / 2;
      const nx = -(ey - p.sy), ny = (ex - p.sx);
      const nlen = Math.hypot(nx, ny) || 1;
      const arc = Math.min(18, Math.hypot(ex - p.sx, ey - p.sy) * 0.12);
      const cx = mx + (nx / nlen) * arc, cy = my + (ny / nlen) * arc;
      const omk = 1 - k;
      p.x = omk*omk*p.sx + 2*omk*k*cx + k*k*ex;
      p.y = omk*omk*p.sy + 2*omk*k*cy + k*k*ey;
    }
  }

  // ====== AI ======
  _ai(dt) {
    if (this.pvp) return;
    this.aiTimer -= dt;
    if (this.aiTimer > 0) return;
    const S = this.M.AI_STRENGTH;
    this.aiTimer = 0.35 + (1 - S) * 0.6 + Math.random() * 0.4;
    const side = this.foeSide;
    // 어떤 링이든 outer는 살 수 있어야 시도 가치 있음
    if (this.energy[side] < this.M.RING_OUTER_COST) return;
    if (this.placeCD[side] > 0) return;
    const pick = this._aiPickPlacement(side, S);
    if (pick && this.energy[side] >= pick.cost) this._place(side, pick.x, pick.y, pick.cost);
  }
  _aiPickPlacement(side, strength) {
    const mine = this.stones.filter(s => s.side === side);
    const foe = this.stones.filter(s => s.side !== side);
    const myEnergy = this.energy[side];
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      let x, y;
      if (foe.length && Math.random() < strength * 0.7) {
        const t = foe[Math.random() * foe.length | 0];
        const a = Math.random() * Math.PI * 2;
        const r = this.MIN_SPACING + Math.random() * 30;
        x = t.x + Math.cos(a) * r; y = t.y + Math.sin(a) * r;
      } else if (mine.length && Math.random() < 0.5) {
        const t = mine[Math.random() * mine.length | 0];
        const a = Math.random() * Math.PI * 2;
        const r = this.MIN_SPACING + Math.random() * 20;
        x = t.x + Math.cos(a) * r; y = t.y + Math.sin(a) * r;
      } else {
        const sx = side === 'atk' ? -1 : 1;
        x = this.arena.cx + sx * this.arena.r * 0.5 + (Math.random() - 0.5) * this.arena.r;
        y = this.arena.cy + (Math.random() - 0.5) * this.arena.r * 0.9;
      }
      if (!this._inArena(x, y)) continue;
      if (this._tooClose(x, y)) continue;
      const cost = this._ringCost(x, y);
      if (myEnergy < cost) continue;  // 살 수 없는 링은 후보 제외
      let score = 0;
      // 링 ROI 매력 — 안쪽일수록 + (단, 비용 부담 큼)
      const income = this._ringIncome(x, y);
      score += (income / cost) * 200;   // ROI 점수
      for (const f of foe) {
        const d = Math.hypot(f.x - x, f.y - y);
        if (d <= this.ATTACK_RANGE * 1.5) score += (this.ATTACK_RANGE * 1.5 - d) * 0.5;
      }
      let near = 0;
      for (const m of mine) if (Math.hypot(m.x - x, m.y - y) <= this.ATTACK_RANGE * 2) near++;
      score += Math.min(near, 2) * 8;
      score -= Math.max(0, near - 3) * 4;
      if (score > bestScore) { bestScore = score; best = { x, y, cost }; }
    }
    return best;
  }

  // ====== 시뮬레이션 한 틱 ======
  _update(dt) {
    // 생산 (각 돌의 *링별* 소득 합산 + 영웅 보너스)
    let rateAtk = 0, rateDef = 0;
    for (const s of this.stones) {
      const r = this._ringIncome(s.x, s.y);
      if (s.side === 'atk') rateAtk += r; else rateDef += r;
    }
    if (this.hero.atk) rateAtk *= 1 + this.M.HERO_INCOME_BONUS;
    if (this.hero.def) rateDef *= 1 + this.M.HERO_INCOME_BONUS;
    this.energy.atk = Math.min(9999, this.energy.atk + rateAtk * dt);
    this.energy.def = Math.min(9999, this.energy.def + rateDef * dt);
    this.placeCD.atk = Math.max(0, this.placeCD.atk - dt);
    this.placeCD.def = Math.max(0, this.placeCD.def - dt);

    // 자동 공격: 인접 적에 데미지 (연속)
    // + 시각용 포탄을 주기적으로 발사 (각 공격자가 fireCD 만료마다)
    const incoming = new Map();    // stone idx → {atk:N, def:N}
    const focusSet = this.selSet;
    const focusTgt = this.focusTarget;
    const focusTgtAlive = focusTgt && this.stones.includes(focusTgt);
    const range = this.ATTACK_RANGE + this.STONE_R * 2;
    for (let i = 0; i < this.stones.length; i++) {
      const a = this.stones[i];
      a._fireCD = (a._fireCD || 0) - dt;     // 시각 포탄 발사 쿨다운
      const focused = (a.side === this.mySide) && focusSet.has(a.id) && focusTgtAlive;
      if (focused) {
        // 사거리 무관: 집중공격은 어디서든 가능 (드래그한 모든 내 돌 → 적)
        const j = this.stones.indexOf(focusTgt);
        focusTgt.hp -= this.M.DPS_PER_ATTACKER * dt;
        if (!incoming.has(j)) incoming.set(j, { atk:0, def:0 });
        incoming.get(j)[a.side]++;
        if (a._fireCD <= 0) { this._spawnProj(a, focusTgt, true); a._fireCD = 0.18; }
        continue;
      }
      // 평소: 사거리 내 모든 적
      let firedThisTick = false;
      for (let j = 0; j < this.stones.length; j++) {
        if (i === j) continue;
        const b = this.stones[j];
        if (a.side === b.side) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) <= range) {
          b.hp -= this.M.DPS_PER_ATTACKER * dt;
          if (!incoming.has(j)) incoming.set(j, { atk:0, def:0 });
          incoming.get(j)[a.side]++;
          // 시각 포탄 — 첫 사거리 적에게만 (한 틱에 한 발) 쿨다운 만료 시
          if (!firedThisTick && a._fireCD <= 0) {
            this._spawnProj(a, b, false); a._fireCD = 0.28; firedThisTick = true;
          }
        }
      }
    }

    // 사망/변환 처리
    for (let i = this.stones.length - 1; i >= 0; i--) {
      const s = this.stones[i];
      if (s.hp > 0) continue;
      const inc = incoming.get(i);
      if (!inc) { this.stones.splice(i, 1); continue; }
      // 다수 공격자 진영으로 변환 (동수면 그냥 죽음)
      if (inc.atk === inc.def) { this.stones.splice(i, 1); continue; }
      const winnerSide = inc.atk > inc.def ? 'atk' : 'def';
      if (winnerSide === s.side) {
        this.stones.splice(i, 1);
      } else {
        s.side = winnerSide;
        s.hp = this.M.FLIP_HP;
        s.flippedAt = performance.now();
        // 선택/집중에서도 정리
        this.selSet.delete(s.id);
        if (this.focusTarget === s) this.focusTarget = null;
      }
    }
    // 집중 타겟이 죽어 사라졌으면 클리어
    if (this.focusTarget && !this.stones.includes(this.focusTarget)) this.focusTarget = null;

    // 이펙트
    if (this._fx) {
      for (let i = this._fx.length - 1; i >= 0; i--) {
        this._fx[i].life -= dt;
        if (this._fx[i].life <= 0) this._fx.splice(i, 1);
      }
    }
    // 포탄 진행
    this._updateProj(dt);

    this._ai(dt);

    // PvP 권위 동기화 — 내 돌들 상태를 주기적으로 상대에게
    if (this.pvp && this.socket) {
      this._netAccum += dt;
      if (this._netAccum >= 0.2) {
        this._netAccum = 0;
        const mine = this.stones.filter(s => s.side === this.mySide).map(s => ({
          id:s.id, x:s.x, y:s.y, hp:s.hp,
        }));
        this.socket.emit('battle:state', { battleId:this.battleId, state:{ stones: mine, energy: this.energy[this.mySide] } });
      }
    }

    // HUD
    document.getElementById('meE').textContent = Math.floor(this.energy[this.mySide]);
    document.getElementById('enE').textContent = Math.floor(this.energy[this.foeSide]);

    // 승패
    if (performance.now() - this.startT > 4000) {
      const myN = this.stones.filter(s => s.side === this.mySide).length;
      const foeN = this.stones.filter(s => s.side === this.foeSide).length;
      if (!myN && this.energy[this.mySide] < this.M.STONE_COST) return this._end(this.foeSide);
      if (!foeN && this.energy[this.foeSide] < this.M.STONE_COST) return this._end(this.mySide);
    }
    if (performance.now() - this.startT > this.M.MAX_T * 1000) {
      const myN = this.stones.filter(s => s.side === this.mySide).length;
      const foeN = this.stones.filter(s => s.side === this.foeSide).length;
      return this._end(myN >= foeN ? this.mySide : this.foeSide);
    }
  }

  // ====== 렌더 ======
  _render() {
    const ctx = this.ctx;
    ctx.fillStyle = '#0c1218';
    ctx.fillRect(0, 0, this.W, this.H);
    // 아레나 경계
    const flash = performance.now() - (this._outsideFlash || 0) < 250;
    ctx.beginPath(); ctx.arc(this.arena.cx, this.arena.cy, this.arena.r, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(20,30,40,0.4)'; ctx.fill();
    ctx.lineWidth = flash ? 4 : 2; ctx.setLineDash([6, 6]);
    ctx.strokeStyle = flash ? 'rgba(255,93,115,0.95)' : 'rgba(255,194,77,0.45)';
    ctx.stroke(); ctx.setLineDash([]);

    // 동심원 등고선 — 안쪽 = 고비용·고생산
    const midR = this.arena.r * this.M.RING_MIDDLE_R;
    const innR = this.arena.r * this.M.RING_INNER_R;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 700);
    // middle 영역 옅게
    ctx.beginPath(); ctx.arc(this.arena.cx, this.arena.cy, midR, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,160,90,0.05)'; ctx.fill();
    ctx.lineWidth = 1; ctx.setLineDash([3, 6]);
    ctx.strokeStyle = 'rgba(255,160,90,0.35)'; ctx.stroke(); ctx.setLineDash([]);
    // inner 영역 더 강하게
    ctx.beginPath(); ctx.arc(this.arena.cx, this.arena.cy, innR, 0, Math.PI*2);
    ctx.fillStyle = `rgba(255,80,80,${0.07 + pulse * 0.05})`; ctx.fill();
    ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
    ctx.strokeStyle = `rgba(255,120,80,${0.45 + pulse * 0.25})`; ctx.stroke(); ctx.setLineDash([]);
    // 라벨 — 안쪽·중간 비용 작게
    ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,140,100,0.85)';
    ctx.fillText('⚡' + this.M.RING_INNER_COST, this.arena.cx, this.arena.cy + 3);
    ctx.fillStyle = 'rgba(255,180,120,0.55)';
    ctx.fillText('⚡' + this.M.RING_MIDDLE_COST, this.arena.cx, this.arena.cy - innR - 5);
    ctx.fillStyle = 'rgba(180,180,180,0.45)';
    ctx.fillText('⚡' + this.M.RING_OUTER_COST, this.arena.cx, this.arena.cy - midR - 5);

    // 돌 연결선 (같은 진영, ATTACK_RANGE 안)
    ctx.lineWidth = 1;
    for (let i = 0; i < this.stones.length; i++) {
      for (let j = i + 1; j < this.stones.length; j++) {
        const a = this.stones[i], b = this.stones[j];
        if (a.side !== b.side) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d <= this.ATTACK_RANGE + this.STONE_R * 2) {
          const col = this._colorOf(a.side);
          ctx.strokeStyle = `rgba(${col.rgb},0.25)`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }

    // 돌
    for (const s of this.stones) {
      const col = this._colorOf(s.side);
      const sel = (s.side === this.mySide) && this.selSet.has(s.id);
      const fade = Math.max(0, 1 - (performance.now() - (s.flippedAt || 0)) / 400);
      // 본체
      ctx.beginPath(); ctx.arc(s.x, s.y, this.STONE_R, 0, Math.PI*2);
      ctx.fillStyle = col.f; ctx.fill();
      ctx.lineWidth = sel ? 3 : 1.5;
      ctx.strokeStyle = sel ? '#ffffff' : col.s;
      ctx.stroke();
      // 변환 직후 펄스
      if (fade > 0) {
        ctx.beginPath(); ctx.arc(s.x, s.y, this.STONE_R + 6 * fade, 0, Math.PI*2);
        ctx.strokeStyle = `rgba(255,255,255,${fade})`;
        ctx.lineWidth = 2; ctx.stroke();
      }
      // HP 호
      const hpf = Math.max(0, s.hp / this.M.STONE_HP_MAX);
      ctx.beginPath();
      ctx.arc(s.x, s.y, this.STONE_R + 3, -Math.PI/2, -Math.PI/2 + Math.PI*2*hpf);
      ctx.lineWidth = 2.2; ctx.strokeStyle = col.s; ctx.stroke();
      // 중심점
      ctx.beginPath(); ctx.arc(s.x, s.y, 2.5, 0, Math.PI*2);
      ctx.fillStyle = col.s; ctx.fill();
    }

    // 집중 타겟 표시
    if (this.focusTarget) {
      const t = this.focusTarget;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
      ctx.beginPath(); ctx.arc(t.x, t.y, this.STONE_R + 8 + pulse * 4, 0, Math.PI*2);
      ctx.strokeStyle = `rgba(255,80,80,${0.6 + pulse * 0.4})`;
      ctx.lineWidth = 3; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }

    // 드래그 라쏘
    if (this._drag && this._drag.dragged) {
      const d = this._drag;
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    }

    // 포탄 (날아가는 탄알 — 시각만, 데미지는 별도 연속 처리)
    if (this._proj) {
      for (const p of this._proj) {
        const col = this._colorOf(p.side);
        // 꼬리 (이전 위치 살짝 흐리게)
        const tx = p.target.x, ty = p.target.y;
        const back = 0.2;     // 꼬리 길이 비율
        const bx = p.x - (tx - p.x) * back;
        const by = p.y - (ty - p.y) * back;
        ctx.strokeStyle = `rgba(${col.rgb}, ${p.focused ? 0.85 : 0.55})`;
        ctx.lineWidth = p.focused ? 2.5 : 1.6;
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(p.x, p.y); ctx.stroke();
        // 머리 — 작은 원
        ctx.beginPath(); ctx.arc(p.x, p.y, p.focused ? 3 : 2.2, 0, Math.PI*2);
        ctx.fillStyle = p.focused ? '#fff5b0' : `rgba(${col.rgb}, 0.95)`;
        ctx.fill();
      }
    }

    // 배치 / 임팩트 이펙트
    if (this._fx) {
      for (const f of this._fx) {
        const a = f.life / f.max;
        const col = this._colorOf(f.side);
        if (f.hit) {
          // 작은 폭발
          const r = 4 + (1 - a) * 8;
          ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, Math.PI*2);
          ctx.fillStyle = `rgba(${col.rgb}, ${a * 0.4})`;
          ctx.fill();
        } else {
          // 배치 링 확산
          const r = this.STONE_R * (1 + (1 - a) * 1.5);
          ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, Math.PI*2);
          ctx.strokeStyle = `rgba(${col.rgb}, ${a})`;
          ctx.lineWidth = 2; ctx.stroke();
        }
      }
    }

    // 선택 카운트 / 집중 안내
    if (this.selSet.size > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'left';
      const hint = this.focusTarget
        ? `▶ ${this.selSet.size}개 집중공격 중`
        : `● ${this.selSet.size}개 선택됨 — 적을 탭해 집중공격`;
      ctx.fillText(hint, 12, this.H - 12);
    }
  }
  _renderOnly() { this._render(); }

  // ====== 메인 루프 ======
  _loop(ts) {
    if (!this.running) return;
    const dt = Math.min(0.05, (ts - this.lastT) / 1000);
    this.lastT = ts;
    if (this._update(dt) !== undefined) return;     // _end 호출됨
    this._render();
    requestAnimationFrame((t) => this._loop(t));
  }

  // ====== 종료 ======
  _end(winnerSide) {
    if (!this.running) return true;
    this.running = false;
    const iWon = (winnerSide === this.mySide);
    this.onEnd(iWon ? (this.mySide === 'atk' ? 'attacker' : 'defender')
                    : (this.mySide === 'atk' ? 'defender' : 'attacker'));
    return true;
  }

  // ====== PvP 네트워크 ======
  _setupNet() {
    if (this._netBound) return; this._netBound = true;
    this.socket.on('battle:action', (a) => {
      if (a.type === 'place') {
        // 상대(foe) 진영의 새 돌
        this.stones.push({ id: 'r' + a.id, side: this.foeSide, x: a.x, y: a.y, hp: this.M.STONE_HP_MAX, remote:true });
      }
    });
    this.socket.on('battle:state', (s) => {
      const mine = this.stones.filter(t => t.side === this.mySide);
      const remote = (s.stones || []).map(t => ({ ...t, side: this.foeSide, remote: true }));
      this.stones = mine.concat(remote);
      if (typeof s.energy === 'number') this.energy[this.foeSide] = s.energy;
    });
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.W = r.width; this.H = r.height;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
