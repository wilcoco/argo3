// ============================================================
//  마이크로 전투 (클라이언트 실시간) — 노른자 + 진화 AI
//  플레이가 끝나면 서버에 결과 검증 요청.
// ============================================================
export class Battle {
  constructor(canvas, cfg, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    this.onEnd = opts.onEnd || (() => {});
    this.colors = { atk: { s:'#3ad1c8', f:'rgba(58,209,200,0.14)', rgb:'58,209,200' },
                    def: { s:'#ff5d73', f:'rgba(255,93,115,0.14)', rgb:'255,93,115' } };
    this.sizeSlider = document.getElementById('sizeSlider');
    this.sizeSlider.oninput = () => { this.selSize = +this.sizeSlider.value; };
    canvas.addEventListener('click', (e) => this._onClick(e));
  }

  start(atkBet, defBet, regionName, battleOpts = {}) {
    const M = this.cfg.MICRO;
    this._resize();
    this.towers = []; this.proj = []; this.fx = []; this.nextId = 0; this.selTower = null;
    this.energy = { atk: atkBet, def: defBet };
    this.rate = { atk: 0, def: 0 };
    this.selSize = 25; this.sizeSlider.value = 25;
    this.running = false;
    this.aiTimer = 0;
    // 내가 조작하는 진영. 도전자=atk, 방어자=def. 기본 atk(기존 호환)
    this.mySide = battleOpts.mySide || 'atk';
    this.foeSide = this.mySide === 'atk' ? 'def' : 'atk';
    // 상대가 사람인가(PvP) — 아니면 상대 진영을 AI가 조작
    this.pvp = !!battleOpts.pvp;
    this.socket = battleOpts.socket || null;
    this.battleId = battleOpts.battleId || null;
    this._netAccum = 0;             // 네트워크 상태 전송 누적
    this.arena = { cx: this.W/2, cy: this.H/2, r: Math.min(this.W, this.H) * M.ARENA_RATIO };
    this.coreR = this.arena.r * M.CORE_RADIUS_FRAC;
    document.getElementById('stakeBar').textContent =
      `베팅 ⚡${atkBet} vs ⚡${defBet} · ${regionName}` + (this.pvp ? ' · ⚔실시간 대전' : '');
    // 색상: 내 진영을 항상 청록(아군 느낌)으로, 상대를 적색으로 보이게 매핑
    this._colorOf = (side) => (side === this.mySide ? this.colors.atk : this.colors.def);
    // HUD 라벨도 진영에 맞게
    document.querySelector('.side.me .lbl').textContent = this.mySide === 'atk' ? 'YOU(공격)' : 'YOU(방어)';
    document.querySelector('.side.en .lbl').textContent = 'ENEMY';
    // 양쪽 시작 거점 — 대칭 스폰. 노른자는 비워두고 양쪽이 경쟁해서 점유한다.
    // 도전자=좌측, 방어자=우측. 시작 탑 크기는 베팅 + "근처 내 영토 수"(보급선)에 비례.
    const prox = battleOpts.proximity || { atk: 0, def: 0 };
    const M2 = this.cfg.MICRO;
    const proxMult = (count) => 1 + Math.min((count || 0) * M2.PROXIMITY_BONUS_PER, M2.PROXIMITY_BONUS_MAX);
    const startRadius = (bet, side) => {
      const base = 18 + Math.sqrt(bet) * 1.4;
      const bonused = base * proxMult(prox[side]);
      return Math.max(20, Math.min(50, bonused));
    };
    const mkStart = (side, sign) => {
      const er = startRadius(this.energy[side], side);
      this.towers.push({ id: this.nextId++, side, x: this.arena.cx + sign * this.arena.r * 0.55,
        y: this.arena.cy, radius: er, maxHp: er, hp: er });
    };
    mkStart('atk', -1);
    mkStart('def', 1);
    // 보너스가 의미있을 때 안내
    if (prox.atk || prox.def) {
      this._proxNote = `보급선 보너스 — 도전자 +${prox.atk}, 방어자 +${prox.def}`;
    }
    // PvP 네트워크 수신 핸들러
    if (this.pvp && this.socket) this._setupNet();
    this._countdown();
  }

  // PvP: 상대의 행동/상태 수신
  _setupNet() {
    if (this._netBound) return; this._netBound = true;
    this.socket.on('battle:action', (a) => {
      // 상대 진영의 행동을 내 시뮬에 반영
      if (a.type === 'build') this._applyRemoteBuild(a);
      else if (a.type === 'fire') this._applyRemoteFire(a);
    });
    // 권위 동기화: 양쪽이 자기 진영 탑을 주기적으로 보고, 상대 것은 수신으로 갱신
    this.socket.on('battle:state', (s) => { this._applyRemoteState(s); });
  }
  _applyRemoteBuild(a) {
    // 상대가 만든 탑 (상대 진영)
    this.towers.push({ id: 'r' + a.id, side: this.foeSide, x: a.x, y: a.y, radius: a.r, maxHp: a.r, hp: a.r, remote: true });
  }
  _applyRemoteFire(a) {
    const from = this.towers.find((t) => t.x != null && Math.abs(t.x - a.fx) < 2 && Math.abs(t.y - a.fy) < 2);
    const tg = this.towers.find((t) => String(t.id) === String(a.tid));
    if (tg) this.proj.push({ fx: a.fx, fy: a.fy, tx: tg.x, ty: tg.y, tid: tg.id, dmg: a.dmg, p: 0, dur: 0.6, side: this.foeSide });
  }
  _applyRemoteState(s) {
    // 상대 진영 탑들의 위치/체력을 권위적으로 동기화 (상대가 보낸 것이 진실)
    const mine = this.towers.filter((t) => t.side === this.mySide);
    const remote = (s.towers || []).map((t) => ({ ...t, side: this.foeSide, remote: true }));
    this.towers = mine.concat(remote);
    if (typeof s.energy === 'number') this.energy[this.foeSide] = s.energy;
  }


  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.W = r.width; this.H = r.height;
    this.canvas.width = r.width*dpr; this.canvas.height = r.height*dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _countdown() {
    const el = document.getElementById('countdown');
    el.classList.add('show');
    let n = this.cfg.MICRO.COUNTDOWN_SEC;
    el.textContent = n;
    const iv = setInterval(() => {
      n--;
      if (n > 0) el.textContent = n;
      else { clearInterval(iv); el.classList.remove('show'); this._begin(); }
    }, 700);
  }
  _begin() {
    this.running = true; this.startT = performance.now(); this.lastT = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  // ---- 엔진 ----
  _tProd(r){ return r * this.cfg.MICRO.PROD_COEF; }
  _inArena(x,y){ const dx=x-this.arena.cx, dy=y-this.arena.cy; return dx*dx+dy*dy <= this.arena.r*this.arena.r; }
  _inCore(x,y){ const dx=x-this.arena.cx, dy=y-this.arena.cy; return dx*dx+dy*dy <= this.coreR*this.coreR; }

  _calcRate() {
    const res = new Array(this.towers.length).fill(0);
    for (let i=0;i<this.towers.length;i++){
      const t=this.towers[i], same=this.towers.filter(o=>o.side===t.side);
      if(!same.length){res[i]=0;continue;}
      const N=30; let c=0;
      for(let s=0;s<N;s++){
        const a=Math.random()*Math.PI*2, d=Math.sqrt(Math.random())*t.radius;
        const px=t.x+Math.cos(a)*d, py=t.y+Math.sin(a)*d; let cov=0;
        for(const o of same){const dx=px-o.x,dy=py-o.y;if(dx*dx+dy*dy<=o.radius*o.radius)cov++;}
        if(cov>0)c+=1/cov;
      }
      const mult = this._inCore(t.x,t.y) ? this.cfg.MICRO.CORE_PROD_MULT : 1;
      res[i]=this._tProd(t.radius)*(c/N)*mult;
    }
    this.rate={atk:0,def:0};
    for(let i=0;i<this.towers.length;i++) this.rate[this.towers[i].side]+=res[i];
  }
  _overlapArea(r1,r2,d){
    if(d>=r1+r2)return 0;
    if(d<=Math.abs(r1-r2))return Math.PI*Math.min(r1,r2)**2;
    const a1=r1*r1*Math.acos((d*d+r1*r1-r2*r2)/(2*d*r1));
    const a2=r2*r2*Math.acos((d*d+r2*r2-r1*r1)/(2*d*r2));
    const a3=0.5*Math.sqrt((-d+r1+r2)*(d+r1-r2)*(d-r1+r2)*(d+r1+r2));
    return a1+a2-a3;
  }
  _areaCombat(dt){
    const C=this.cfg.MICRO.COMBAT_C;
    for(let i=0;i<this.towers.length;i++)for(let j=i+1;j<this.towers.length;j++){
      const a=this.towers[i],b=this.towers[j];if(a.side===b.side)continue;
      const dx=a.x-b.x,dy=a.y-b.y,d=Math.sqrt(dx*dx+dy*dy);if(d>=a.radius+b.radius)continue;
      const ov=this._overlapArea(a.radius,b.radius,d),dmg=ov*0.02*C*dt*60;
      a.hp-=dmg;b.hp-=dmg;
      if(Math.random()<dt*8)this.fx.push({x:(a.x+b.x)/2,y:(a.y+b.y)/2,life:.3,max:.3});
    }
  }
  _build(x,y,side){
    if(!this._inArena(x,y)){ if(side===this.mySide)this.outsideFlash=performance.now(); return false; }
    const r = side===this.mySide ? this.selSize : (18+Math.random()*8);
    if(this.energy[side]<r)return false;
    this.energy[side]-=r;
    const id=this.nextId++;
    this.towers.push({id,side,x,y,radius:r,maxHp:r,hp:r});
    // PvP: 내 행동을 상대에게 전송
    if(side===this.mySide && this.pvp && this.socket)
      this.socket.emit('battle:action',{battleId:this.battleId,action:{type:'build',id,x,y,r}});
    return true;
  }
  _fire(from,to){
    const dx=to.x-from.x,dy=to.y-from.y,d=Math.sqrt(dx*dx+dy*dy);
    const cost=Math.floor(from.hp*this.cfg.MICRO.RANGED_COST_RATIO);if(cost<3)return;
    const fall=Math.max(0.15,1-d/700);from.hp-=cost;
    const dmg=cost*fall;
    this.proj.push({fx:from.x,fy:from.y,tx:to.x,ty:to.y,tid:to.id,dmg,p:0,dur:0.6+d/500,side:from.side});
    if(from.side===this.mySide && this.pvp && this.socket)
      this.socket.emit('battle:action',{battleId:this.battleId,action:{type:'fire',fx:from.x,fy:from.y,tid:to.id,dmg}});
  }
  _towerAt(x,y){ for(const t of this.towers){const dx=x-t.x,dy=y-t.y;if(dx*dx+dy*dy<=t.radius*t.radius)return t;} return null; }

  _ai(dt){
    // PvP면 AI 동작 안 함 (상대가 사람)
    if(this.pvp)return;
    this.aiTimer-=dt; if(this.aiTimer>0)return;
    const S=this.cfg.MICRO.AI_STRENGTH, champ=this.cfg.MICRO.CHAMPION;
    this.aiTimer = 0.4+(1-S)*1.6 + Math.random()*1.0;
    const ai=this.foeSide;  // AI가 조작하는 진영 = 상대
    const mine=this.towers.filter(t=>t.side===ai), foe=this.towers.filter(t=>t.side===this.mySide);
    if(mine.length && foe.length && Math.random()<S*0.5){
      const sh=mine.slice().sort((a,b)=>b.hp-a.hp)[0];
      if(sh.hp/sh.maxHp>=champ.rangedThresh){ this._fire(sh, foe.slice().sort((a,b)=>a.hp-b.hp)[0]); return; }
    }
    if(mine.length>=champ.maxTowers)return;
    const r = S>0.5 ? champ.towerSize+Math.random()*8 : 30+Math.random()*20;
    if(this.energy[ai]<r)return;
    let best=null,bs=-1e9; const cand=4+Math.round(S*8);
    for(let k=0;k<cand;k++){
      let bx,by;
      if(Math.random()<S){ bx=this.arena.cx+(Math.random()-0.5)*this.coreR*1.5; by=this.arena.cy+(Math.random()-0.5)*this.coreR*1.5; }
      else if(mine.length){ const b=mine[Math.random()*mine.length|0]; bx=b.x+(Math.random()-0.5)*120; by=b.y+(Math.random()-0.5)*120; }
      else { bx=this.arena.cx; by=this.arena.cy; }
      if(!this._inArena(bx,by))continue;
      let score=0; const dc=Math.hypot(bx-this.arena.cx,by-this.arena.cy);
      if(dc<=this.coreR)score+=100;else score+=Math.max(0,this.arena.r-dc)*0.1;
      for(const o of mine){const dx=bx-o.x,dy=by-o.y,dist=Math.hypot(dx,dy);if(dist<r+o.radius)score-=S*(r+o.radius-dist)*3;}
      if(score>bs){bs=score;best={bx,by};}
    }
    if(best)this._build(best.bx,best.by,ai);
  }

  _update(dt){
    this._calcRate();
    this.energy.atk=Math.min(9999,this.energy.atk+this.rate.atk*dt);
    this.energy.def=Math.min(9999,this.energy.def+this.rate.def*dt);
    this._areaCombat(dt);
    for(let i=this.proj.length-1;i>=0;i--){
      const p=this.proj[i],tg=this.towers.find(t=>t.id===p.tid);
      if(!tg){this.proj.splice(i,1);continue;}
      p.p+=dt/p.dur;
      if(p.p>=1){tg.hp-=p.dmg;this.fx.push({x:tg.x,y:tg.y,life:.5,max:.5,big:true});this.proj.splice(i,1);continue;}
      p.cx=p.fx+(tg.x-p.fx)*p.p; p.cy=p.fy+(tg.y-p.fy)*p.p;
    }
    for(let i=this.towers.length-1;i>=0;i--) if(this.towers[i].hp<=0){
      if(this.towers[i]===this.selTower)this.selTower=null;
      this.fx.push({x:this.towers[i].x,y:this.towers[i].y,life:.8,max:.8,big:true});
      this.towers.splice(i,1);
    }
    for(let i=this.fx.length-1;i>=0;i--){this.fx[i].life-=dt;if(this.fx[i].life<=0)this.fx.splice(i,1);}
    this._ai(dt);
    // PvP: 내 진영 상태를 주기적으로 상대에게 전송 (권위 동기화)
    if(this.pvp && this.socket){
      this._netAccum += dt;
      if(this._netAccum >= 0.15){ this._netAccum = 0;
        const myTowers = this.towers.filter(t=>t.side===this.mySide)
          .map(t=>({id:t.id,x:t.x,y:t.y,radius:t.radius,maxHp:t.maxHp,hp:t.hp}));
        this.socket.emit('battle:state',{battleId:this.battleId,state:{towers:myTowers,energy:this.energy[this.mySide]}});
      }
    }
    // HUD — 내 진영/상대 진영 기준
    document.getElementById('meE').textContent=Math.floor(this.energy[this.mySide]);
    document.getElementById('enE').textContent=Math.floor(this.energy[this.foeSide]);
    const c=this.selSize, el=document.getElementById('sizeCost');
    el.textContent='비용 '+c;
    // 승패 (attacker/defender 절대 기준 유지 — 서버와 일치)
    if(performance.now()-this.startT>4000){
      const a=this.towers.some(t=>t.side==='atk'), d=this.towers.some(t=>t.side==='def');
      if(!a&&this.energy.atk<15)return this._end('defender');
      if(!d&&this.energy.def<15)return this._end('attacker');
    }
    if(performance.now()-this.startT>90000){
      const ha=this.towers.filter(t=>t.side==='atk').reduce((s,t)=>s+t.hp,0);
      const hd=this.towers.filter(t=>t.side==='def').reduce((s,t)=>s+t.hp,0);
      this._end(ha>=hd?'attacker':'defender');
    }
  }

  _render(){
    const ctx=this.ctx, M=this.cfg.MICRO;
    ctx.fillStyle='#0d1420';ctx.fillRect(0,0,this.W,this.H);
    // 아레나 밖 어둡게
    ctx.save();
    ctx.beginPath();ctx.rect(0,0,this.W,this.H);
    ctx.arc(this.arena.cx,this.arena.cy,this.arena.r,0,Math.PI*2,true);
    ctx.fillStyle='rgba(6,9,13,0.55)';ctx.fill('evenodd');
    const flash=performance.now()-(this.outsideFlash||0)<400;
    ctx.beginPath();ctx.arc(this.arena.cx,this.arena.cy,this.arena.r,0,Math.PI*2);
    ctx.lineWidth=flash?4:2;ctx.setLineDash([8,6]);
    ctx.strokeStyle=flash?'rgba(255,93,115,0.95)':'rgba(255,194,77,0.5)';ctx.stroke();ctx.setLineDash([]);
    // 노른자
    const pulse=0.5+0.5*Math.sin(performance.now()/500);
    ctx.beginPath();ctx.arc(this.arena.cx,this.arena.cy,this.coreR,0,Math.PI*2);
    ctx.fillStyle=`rgba(255,194,77,${0.08+pulse*0.06})`;ctx.fill();
    ctx.beginPath();ctx.arc(this.arena.cx,this.arena.cy,this.coreR,0,Math.PI*2);
    ctx.lineWidth=1.5;ctx.setLineDash([4,4]);ctx.strokeStyle=`rgba(255,194,77,${0.4+pulse*0.3})`;ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='rgba(255,210,120,0.9)';ctx.font='bold 10px monospace';ctx.textAlign='center';
    ctx.fillText('⭐생산'+M.CORE_PROD_MULT+'배',this.arena.cx,this.arena.cy+3);
    ctx.restore();
    // 탑
    for(const t of this.towers){
      const col=this._colorOf(t.side);
      ctx.beginPath();ctx.arc(t.x,t.y,t.radius,0,Math.PI*2);ctx.fillStyle=col.f;ctx.fill();
      ctx.lineWidth=t===this.selTower?3:1.5;ctx.strokeStyle=t===this.selTower?'#fff':col.s;ctx.stroke();
      const hpf=Math.max(0,t.hp/t.maxHp);
      ctx.beginPath();ctx.arc(t.x,t.y,t.radius+4,-Math.PI/2,-Math.PI/2+Math.PI*2*hpf);
      ctx.lineWidth=2.5;ctx.strokeStyle=col.s;ctx.stroke();
      ctx.beginPath();ctx.arc(t.x,t.y,4,0,Math.PI*2);ctx.fillStyle=col.s;ctx.fill();
    }
    for(const p of this.proj){
      ctx.beginPath();ctx.arc(p.cx||p.fx,p.cy||p.fy,4,0,Math.PI*2);ctx.fillStyle='#ffeeaa';ctx.fill();
    }
    for(const f of this.fx){const a=f.life/f.max;
      ctx.beginPath();ctx.arc(f.x,f.y,(f.big?14:6)*(1.4-a),0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,255,${a*0.5})`;ctx.fill();}
  }

  _loop(ts){
    if(!this.running)return;
    const dt=Math.min(0.05,(ts-this.lastT)/1000||0);this.lastT=ts;
    this._update(dt);this._render();
    if(this.running)requestAnimationFrame((t)=>this._loop(t));
  }

  _onClick(e){
    if(!this.running)return;
    const r=this.canvas.getBoundingClientRect();
    const x=e.clientX-r.left,y=e.clientY-r.top;
    const hit=this._towerAt(x,y);
    const hint=document.getElementById('modeHint');
    const ME=this.mySide, FOE=this.foeSide;
    if(this.selTower){
      if(hit&&hit.side===FOE){this._fire(this.selTower,hit);this.selTower=null;hint.textContent='중앙 노른자를 차지하라';return;}
      if(hit&&hit.side===ME){this.selTower=hit;return;}
      this.selTower=null;this._build(x,y,ME);hint.textContent='중앙 노른자를 차지하라';return;
    }
    if(hit&&hit.side===ME){this.selTower=hit;hint.textContent='적 탑 탭=장거리 공격';return;}
    this._build(x,y,ME);
  }

  _end(winner){
    if(!this.running)return;
    this.running=false;
    this.onEnd(winner);
  }
}
