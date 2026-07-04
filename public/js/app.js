// ============================================================
//  BACTERIA WAR 클라이언트 메인
// ============================================================
import { MacroMap } from './map.js';
import { Battle } from './battle.js';

const API = '/api';
let CFG = null;
let me = null;          // 내 플레이어
let macro = null;       // 지도 인스턴스
let battle = null;      // 전투 인스턴스
let socket = null;
let pending = null;     // 진행 중 도전 {battleId, cellX, cellY}

const $ = (id) => document.getElementById(id);

// 토스트 — alert() 대체 (흐름 안 끊는 알림)
function toast(msg, type = 'info', ms = 2600) {
  let box = $('toastBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toastBox';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// 두 위경도 좌표 간 미터 거리 (Haversine)
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
const show = (screenId) => {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(screenId).classList.add('active');
};

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '오류');
  return data;
}

// ---- 로그인 ----
$('loginBtn').addEventListener('click', login);
$('usernameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
async function login() {
  const username = $('usernameInput').value.trim();
  if (username.length < 2) { $('loginError').textContent = '닉네임 2자 이상'; return; }
  try {
    CFG = await api('/config');
    me = await api('/player', { method: 'POST', body: { username } });
    localStorage.setItem('bw_pid', me.id);
    initGame();
  } catch (e) { $('loginError').textContent = e.message; }
}

// 자동 로그인 — 저장된 플레이어 id가 살아있으면 닉네임 입력 생략
(async function autoLogin() {
  const pid = localStorage.getItem('bw_pid');
  if (!pid) return;
  try {
    CFG = await api('/config');
    me = await api('/player/' + pid);
    initGame();
  } catch { /* 저장된 id 무효 — 로그인 화면 유지 */ }
})();

let myLoc = null;  // 내 현재 GPS 위치 {lat, lng, acc}

function initGame() {
  show('macroScreen');
  updateWallet();
  // 지도
  macro = new MacroMap($('mapCanvas'), {
    zoom: CFG.MACRO.ZOOM,
    cellSizeM: CFG.MACRO.CELL_SIZE_M,
    tribeColors: CFG.TRIBE_COLORS,
    myId: me.id,
    claimRadiusM: CFG.MACRO.CLAIM_RADIUS_M,
    capFactor: CFG.MACRO.CAP_FACTOR,
    lootShowMin: CFG.MACRO.LOOT_SHOW_MIN,
    onTapEmpty: openClaim,
    onTapCell: openCell,
  });
  // 위치 권한: 한 번 가져온 뒤 지속 추적
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
        macro.setView(myLoc.lat, myLoc.lng);
        macro.setMyLoc(myLoc);
        refreshCells();
      },
      () => refreshCells(),
      { timeout: 5000, enableHighAccuracy: true }
    );
    navigator.geolocation.watchPosition(
      (pos) => {
        myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
        macro.setMyLoc(myLoc);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  } else refreshCells();

  // 소켓
  socket = io();
  socket.emit('subscribe:region', {});
  socket.emit('player:online', me.id);          // 온라인 등록 (도전 알림 수신용)
  socket.on('connect', () => socket.emit('player:online', me.id));
  socket.on('ecosystem:update', renderEcoBar);
  socket.on('activity', showActivity);            // 실시간 세계 활동 피드
  bindBattleSockets();                            // 도전/PvP 이벤트 바인딩

  // 전투 인스턴스
  battle = new Battle($('battleCanvas'), CFG, { onEnd: onBattleEnd });
  $('ovBack').addEventListener('click', () => { show('macroScreen'); refreshCells(); refreshMe(); });

  // 줌 버튼
  $('zoomIn').addEventListener('click', () => { macro.zoomBy(+1); refreshCells(); });
  $('zoomOut').addEventListener('click', () => { macro.zoomBy(-1); refreshCells(); });
  $('zoomMe').addEventListener('click', () => {
    if (myLoc) { macro.setView(myLoc.lat, myLoc.lng); refreshCells(); }
  });
  $('zoomMyCells').addEventListener('click', jumpToMyCell);
  $('lbBtn').addEventListener('click', openLeaderboard);
  $('harvestChip').addEventListener('click', harvestAllMine);
  // 전투 항복 버튼
  $('forfeitBtn').addEventListener('click', () => {
    if (battle && battle.running && confirm('항복하면 패배 처리됩니다. 항복할까요?')) battle.forfeit();
  });

  setInterval(refreshCells, 8000);
  setInterval(refreshMe, 5000);   // 서버 틱과 같은 5초 — 즉시 반영
  tutorial.init();
}

// ---- 튜토리얼 (신규 유저 첫 5분 안내) ----
const tutorial = {
  steps: [
    { id: 'welcome', html: '👋 환영! 지도에서 <b>빈 곳을 탭</b>해 첫 영토를 점유하자.' },
    { id: 'find_enemy', html: '✓ 점유 완료! <b>금색으로 빛나는 적 셀</b>은 미수확 에너지 — 이기면 통째로 약탈! 탭해서 도전.' },
    { id: 'battle_hint', html: '⚔ 전투: <b>빈 곳 탭=돌 두기</b> (가운데일수록 비싸지만 생산↑). 내 돌 드래그로 묶고 <b>적 탭=집중공격</b>!' },
    { id: 'done', html: '' },
  ],
  init() {
    const saved = Number(localStorage.getItem('bw_tut') || 0);
    this.step = isNaN(saved) ? 0 : saved;
    $('tutClose').addEventListener('click', () => this.dismiss());
    this.render();
  },
  render() {
    const s = this.steps[this.step];
    const banner = $('tutBanner');
    if (!s || !s.html) { banner.classList.add('hidden'); return; }
    $('tutText').innerHTML = s.html;
    banner.classList.remove('hidden');
  },
  advance(event) {
    // 이벤트로 단계 자동 진행
    const map = { welcome: 'claimed', find_enemy: 'challenged', battle_hint: 'battled' };
    const expected = map[this.steps[this.step]?.id];
    if (expected === event) {
      this.step += 1;
      localStorage.setItem('bw_tut', String(this.step));
      this.render();
    }
  },
  dismiss() {
    this.step = this.steps.length - 1;
    localStorage.setItem('bw_tut', String(this.step));
    this.render();
  },
};

// 내 타워들의 총 생산률 (per hour) — 타워별 저장 룰: PROD_COEF × value /초
function myProductionPerHour() {
  const v = Number(me.cells_value) || 0;
  return v * (CFG.MACRO.PROD_COEF || 0) * 3600;
}

function updateWallet() {
  // 지갑 + 상한 표시 — 캡에 닿으면 수확이 막히므로 보이게
  $('energy').textContent = `${Math.floor(me.energy)}/${CFG.MACRO.MAX_ENERGY}`;
  const rate = myProductionPerHour();
  const rateEl = $('incomeRate');
  if (rateEl) rateEl.textContent = rate > 0 ? ` 생산 +${rate.toFixed(0)}/h` : '';
  // 수확 가능 총량 칩 — 쌓여 있으면 한번에 수확 유도
  const chip = $('harvestChip');
  if (chip) {
    const stored = Number(me.stored_total) || 0;
    if (stored >= 1) {
      chip.classList.remove('hidden');
      chip.innerHTML = `🧺<b>${Math.floor(stored)}</b>`;
      chip.title = '탭: 모든 타워에서 한번에 수확';
    } else chip.classList.add('hidden');
  }
  $('record').textContent = `${me.wins}승 ${me.losses}패`;
  const badge = $('tribeBadge');
  badge.textContent = CFG.TRIBE_NAMES[me.tribe];
  badge.style.background = CFG.TRIBE_COLORS[me.tribe];
  badge.style.color = '#04201e';

  // 글로리 + 영웅 확률 (현재 인생 누적치 기준)
  const M = CFG.MACRO;
  const cw = Number(me.combat_wins) || 0;
  const km = Number(me.karma) || 0;
  const glory = cw * M.HERO_GLORY_PER_WIN + km * M.HERO_GLORY_PER_KARMA;
  const prob = Math.min(M.HERO_PROB_CAP, glory / M.HERO_PROB_DIVISOR);
  $('glory').textContent = glory.toFixed(0);
  $('heroProb').textContent = `(${Math.round(prob*100)}%)`;
  $('gloryChip').title =
    `사망 시 ${Math.round(prob*100)}% 확률로 영웅 환생\n` +
    `전투 승 ${cw} × ${M.HERO_GLORY_PER_WIN} + 카르마 ${km.toFixed(1)} × ${M.HERO_GLORY_PER_KARMA} = 글로리 ${glory.toFixed(1)}\n` +
    `확률 = min(${(M.HERO_PROB_CAP*100).toFixed(0)}%, 글로리 / ${M.HERO_PROB_DIVISOR})`;

  // 영웅 상태 뱃지
  const heroChip = $('heroChip');
  const gloryChip = $('gloryChip');
  if (me.is_hero) {
    heroChip.classList.remove('hidden');
    gloryChip.classList.add('hidden');
  } else {
    heroChip.classList.add('hidden');
    gloryChip.classList.remove('hidden');
  }
}
async function refreshMe() {
  try {
    const prev = me ? Number(me.energy) : 0;
    me = await api('/player/' + me.id);
    const delta = Number(me.energy) - prev;
    updateWallet();
    // 수입이 들어왔으면 내 셀들 위로 +N 부유 텍스트 (눈에 보이는 생산 피드백)
    if (delta > 0.5 && macro && macro.cells) {
      macro.flashIncome(me.id, delta);
    }
  } catch {}
}
async function refreshCells() {
  if (!macro) return;
  const b = macroBounds();
  try {
    const cells = await api(`/cells?minLat=${b.minLat}&minLng=${b.minLng}&maxLat=${b.maxLat}&maxLng=${b.maxLng}`);
    macro.setCells(cells);
    // 셀 갱신 후 HUD 수입률도 다시 계산 (cells 의존)
    if (me) updateWallet();
  } catch {}
}
function macroBounds() {
  // 실제 화면 모서리 기준 (줌 무관 고정 delta는 줌아웃 시 가장자리 셀 누락)
  const a = macro.screen2geo(0, 0);
  const b = macro.screen2geo(macro.W, macro.H);
  const pad = 0.002;
  return {
    minLat: Math.min(a.lat, b.lat) - pad, maxLat: Math.max(a.lat, b.lat) + pad,
    minLng: Math.min(a.lng, b.lng) - pad, maxLng: Math.max(a.lng, b.lng) + pad,
  };
}

// ---- 활동 피드 티커 — 세계가 살아있다는 감각 ----
function showActivity({ text }) {
  const el = $('activityTicker');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(window._actTimer);
  window._actTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

// ---- 순위표 ----
async function openLeaderboard() {
  try {
    const rows = await api('/leaderboard');
    const list = rows.map((r, i) => {
      const color = CFG.TRIBE_COLORS[r.tribe] || '#888';
      const isMe = r.id === me.id;
      return `<div class="lb-row${isMe ? ' me' : ''}">
        <span class="lb-rank">${['🥇','🥈','🥉'][i] || (i+1)}</span>
        <span class="lb-name" style="color:${color}">${r.is_hero ? '👑' : ''}${r.username}</span>
        <span class="lb-stat">영토 ${Math.round(r.territory)} · ${r.cells}칸 · ${r.wins}승</span>
      </div>`;
    }).join('');
    $('sheetBody').innerHTML = `
      <h3>🏆 영토 순위</h3>
      <div class="lb-list">${list || '<div class="dim">아직 순위가 없습니다</div>'}</div>
      <div class="btnrow"><button class="btn ghost" id="cancelBtn">닫기</button></div>`;
    openSheet();
    $('cancelBtn').onclick = closeSheet;
  } catch (e) { toast(e.message, 'err'); }
}

// ---- 한번에 수확 ----
async function harvestAllMine() {
  try {
    const r = await api('/harvestall', { method: 'POST', body: { playerId: me.id } });
    toast(`🧺 타워 ${r.towers}개에서 ⚡${r.harvested.toFixed(0)} 수확!`);
    await refreshMe(); await refreshCells();
  } catch (e) { toast(e.message, 'err'); }
}

// 내 영토로 점프 — 누를 때마다 내 셀 순환
let _myCellIdx = 0;
async function jumpToMyCell() {
  try {
    const cells = await api(`/player/${me.id}/cells`);
    if (!cells.length) { toast('아직 내 영토가 없습니다 — 빈 땅을 탭해 점유하세요'); return; }
    const c = cells[_myCellIdx % cells.length];
    _myCellIdx++;
    macro.setView(Number(c.lat), Number(c.lng));
    refreshCells();
  } catch (e) { toast(e.message, 'err'); }
}

function renderEcoBar(data) {
  const bar = $('ecoBar');
  bar.innerHTML = '';
  const total = data.tribes.reduce((s, t) => s + t.cells, 0) || 1;
  data.tribes.forEach((t) => {
    const seg = document.createElement('div');
    seg.className = 'eco-seg';
    seg.style.borderColor = CFG.TRIBE_COLORS[t.id];
    seg.innerHTML = `<span style="color:${CFG.TRIBE_COLORS[t.id]}">${t.name}</span> ${(t.cells/total*100).toFixed(0)}%`;
    bar.appendChild(seg);
  });
}

// ---- 빈 땅 점유 ----
// 자유 배치: 탭 지점에 그대로 셀 배치. 자기 셀 겹침 OK (클러스터).
// 적 셀과 너무 가까우면 서버가 challengeSuggested 응답 → 자동으로 도전 시트로 전환.
function openClaim(lat, lng) {
  const M = CFG.MACRO;
  const minV = M.CLAIM_MIN_VALUE, maxV = M.CLAIM_MAX_VALUE;
  const cap = Math.max(minV, Math.min(maxV, Math.floor(me.energy)));
  const initV = Math.max(minV, Math.min(cap, M.CLAIM_DEFAULT_VALUE));
  // 탭 지점에 미리보기 (스냅 없음)
  macro.setPreviewCell({ lat, lng, value: initV });
  let warn = '';
  if (myLoc) {
    const dist = haversineM(myLoc.lat, myLoc.lng, lat, lng);
    if (dist > M.CLAIM_RADIUS_M) {
      const km = (M.CLAIM_RADIUS_M / 1000).toFixed(1);
      const cur = (dist / 1000).toFixed(2);
      warn = `<div class="warn">⚠ 현재 위치에서 ${cur}km — ${km}km 이내만 점유 가능</div>`;
    }
  } else {
    warn = `<div class="warn">⚠ GPS 미허용 — 위치 권한이 있어야 점유할 수 있습니다</div>`;
  }
  const blocked = !!warn;
  $('sheetBody').innerHTML = `
    <h3>빈 땅 점유 <span class="tag free">미점유</span></h3>
    <div class="sub">크게 점유할수록 더 많은 에너지가 들고, 영역 가치·생산력이 높아진다.<br>
      <span class="dim">자기 셀끼리는 겹쳐 클러스터를 만들 수 있다. 적 셀에 너무 가까우면 자동으로 도전이 시도된다.</span>
    </div>
    ${warn}
    <div class="slider-row">
      <label>영역 가치 / 비용</label>
      <input type="range" id="claimSize" min="${minV}" max="${cap}" value="${initV}" step="1">
      <span id="claimSizeVal">⚡${initV}</span>
    </div>
    <div class="btnrow">
      <button class="btn ghost" id="cancelBtn">취소</button>
      <button class="btn primary" id="claimBtn" ${(blocked || me.energy<minV)?'disabled':''}>점유</button>
    </div>`;
  openSheet();
  const slider = $('claimSize'), label = $('claimSizeVal'), btn = $('claimBtn');
  const update = () => {
    const v = Number(slider.value);
    label.textContent = `⚡${v}`;
    btn.textContent = `점유 (⚡${v})`;
    btn.disabled = me.energy < v;
    macro.setPreviewCell({ lat, lng, value: v });
  };
  update();
  slider.addEventListener('input', update);
  const cleanup = () => { macro.setPreviewCell(null); };
  $('cancelBtn').onclick = () => { cleanup(); closeSheet(); };
  btn.onclick = async () => {
    try {
      const value = Number(slider.value);
      const res = await api('/claim', { method: 'POST', body: {
        playerId: me.id, lat, lng, value,
        playerLat: myLoc?.lat, playerLng: myLoc?.lng,
      }});
      cleanup();
      // 서버가 적 셀 근처임을 알리면 → 도전 흐름으로 전환
      if (res && res.challengeSuggested) {
        await refreshCells();
        const cs = res.challengeSuggested;
        // 셀 목록에서 cellId 찾기 — 전체 정보(def_bet, username, ...)
        const fullCell = (macro.cells || []).find((c) => Number(c.id) === Number(cs.cellId));
        closeSheet();
        if (fullCell) openCell(fullCell);
        else toast('적 영역과 인접 — 직접 셀을 탭해 도전');
        return;
      }
      closeSheet(); await refreshMe(); await refreshCells();
      tutorial.advance('claimed');
    } catch (e) {
      toast(e.message, 'err');
      if (/이미 점유|에너지|위치/.test(e.message || '')) { cleanup(); closeSheet(); refreshCells(); }
    }
  };
}

// ---- 셀 탭 (내 영역 / 적 영역) ----
function openCell(c) {
  if (c.owner_id === me.id) {
    const M = CFG.MACRO;
    const stored = Number(c.stored_energy) || 0;
    const cap = Number(c.value) * M.CAP_FACTOR;
    const perHour = Number(c.value) * M.PROD_COEF * 3600;
    const full = stored >= cap - 0.01;
    const pct = Math.min(100, (stored / cap) * 100);
    $('sheetBody').innerHTML = `
      <h3>${c.username || '내 거점'} <span class="tag me">내 영역</span></h3>
      <div class="sub">가치 ${c.value} · 자동방어 베팅 ⚡${c.def_bet}</div>
      <div class="prod-line">
        <span class="prod-num">⚡${stored.toFixed(1)}<span class="dim">/${cap.toFixed(0)} 저장</span></span>
        <span class="dim">${full ? '⚠ 가득 — 생산 정지!' : `생산 +${perHour.toFixed(1)}/h`}</span>
      </div>
      <div class="storebar"><div class="storebar-fill${full ? ' full' : ''}" style="width:${pct}%"></div></div>
      ${stored >= 1 ? `
      <div class="slider-row">
        <label>수확량</label>
        <input type="range" id="harvestAmt" min="1" max="${Math.floor(stored)}" value="${Math.floor(stored)}" step="1">
        <span id="harvestVal">⚡${Math.floor(stored)}</span>
      </div>` : `<div class="sub dim">아직 수확할 에너지가 없습니다 (방치하면 적이 약탈할 수 있어요)</div>`}
      <div class="btnrow">
        <button class="btn ghost" id="cancelBtn">닫기</button>
        ${stored >= 1 ? `<button class="btn primary" id="harvestBtn">수확</button>` : ''}
      </div>`;
    openSheet(); $('cancelBtn').onclick = closeSheet;
    const slider = $('harvestAmt');
    if (slider) {
      slider.addEventListener('input', () => { $('harvestVal').textContent = '⚡' + slider.value; });
      $('harvestBtn').onclick = async () => {
        try {
          const r = await api('/harvest', { method: 'POST',
            body: { playerId: me.id, cellId: c.id, amount: Number(slider.value) } });
          toast(`⚡${r.harvested.toFixed(0)} 수확! (타워 잔여 ${r.stored.toFixed(0)})`);
          closeSheet(); await refreshMe(); await refreshCells();   // refreshMe가 +N 부유 텍스트 처리
        } catch (e) { toast(e.message, 'err'); }
      };
    }
    return;
  }
  // 적 영역 → 도전
  const minBet = Math.ceil(c.def_bet * CFG.BETTING.CHALLENGE_MIN_RATIO);
  const assets = Number(me.energy) + (Number(me.cells_value) || 0);
  const cap = assets >= CFG.BETTING.CAP_THRESHOLD ? Math.floor(me.energy * CFG.BETTING.CAP_RATIO) : Math.floor(me.energy);
  // GPS 거리 사전 차단 — 도전도 점유처럼 반경 제한
  let distWarn = '';
  let tooFar = false;
  if (myLoc) {
    const dist = haversineM(myLoc.lat, myLoc.lng, Number(c.lat), Number(c.lng));
    if (dist > CFG.MACRO.CHALLENGE_RADIUS_M) {
      tooFar = true;
      distWarn = `<div class="warn">⚠ ${(dist/1000).toFixed(2)}km — ${(CFG.MACRO.CHALLENGE_RADIUS_M/1000).toFixed(1)}km 이내만 도전 가능. 가까이 가세요!</div>`;
    }
  } else {
    tooFar = true;
    distWarn = `<div class="warn">⚠ GPS 미허용 — 위치 권한이 있어야 도전할 수 있습니다</div>`;
  }
  // 큐 길이 미리 조회 (실패해도 무시)
  api(`/queue/status?cellId=${c.id}&playerId=${me.id}`).then((q) => {
    const info = document.getElementById('queueInfo');
    if (!info) return;
    if (q.queueLen > 0 || q.restRemainingSec > 0) {
      const parts = [];
      if (q.queueLen > 0) parts.push(`대기 ${q.queueLen}명`);
      if (q.restRemainingSec > 0) parts.push(`방어자 휴식 ${Math.ceil(q.restRemainingSec)}초`);
      info.innerHTML = `<span class="warn-inline">⏳ ${parts.join(' · ')} — 도전 시 줄을 섭니다</span>`;
    }
  }).catch(() => {});
  const loot = Number(c.stored_energy) || 0;
  $('sheetBody').innerHTML = `
    <h3>${c.username || '적 거점'} <span class="tag enemy">적 영역</span></h3>
    <div class="sub">가치 ${c.value} · 방어 베팅 ⚡${c.def_bet}${loot >= 1 ? ` · <b>미수확 ⚡${loot.toFixed(0)} 약탈 가능!</b>` : ''}<br>이기면 점유권+베팅${loot >= 1 ? '+저장 에너지' : ''} 획득, 지면 베팅 손실</div>
    ${distWarn}
    <div id="queueInfo" class="sub"></div>
    <div class="betrow"><label>내 베팅</label>
      <input type="range" id="betSlider" min="${minBet}" max="${Math.max(minBet,cap)}" value="${minBet}">
      <span class="betval" id="betVal">⚡${minBet}</span></div>
    <div class="sub" id="betInfo"></div>
    <div class="btnrow">
      <button class="btn ghost" id="cancelBtn">취소</button>
      <button class="btn danger" id="chalBtn" ${(tooFar || me.energy<minBet)?'disabled':''}>도전 (실시간 전투)</button>
    </div>`;
  openSheet();
  const bs = $('betSlider');
  const upd = () => { $('betVal').textContent = '⚡' + bs.value;
    $('betInfo').textContent = `보유 ⚡${Math.floor(me.energy)} · 상한 ⚡${cap}`; };
  bs.oninput = upd; upd();
  $('cancelBtn').onclick = closeSheet;
  $('chalBtn').onclick = () => startChallenge(c, +bs.value);
}

async function startChallenge(c, atkBet) {
  try {
    const result = await api('/challenge', { method: 'POST',
      body: { playerId: me.id, cellId: c.id, cellX: c.cell_x, cellY: c.cell_y, atkBet,
              playerLat: myLoc?.lat, playerLng: myLoc?.lng } });

    // (A) 즉시 전투 시작 (셀이 한가)
    if (result.battle) {
      pending = { battleId: result.battle.id, cell: c, atkBet, defBet: c.def_bet, mySide: 'atk',
                  proximity: result.proximity, hero: result.hero, tribeAdv: result.tribeAdv };
      closeSheet();
      tutorial.advance('challenged');
      socket.emit('battle:join', result.battle.id);
      socket.emit('challenge:initiate', {
        battleId: result.battle.id,
        defenderId: c.owner_id,
        attackerName: me.username,
        regionName: c.username || '적 거점',
        atkBet, defBet: c.def_bet,
      });
      showWaiting(c);
      return;
    }
    // (B) 큐 등록됨 — 셀이 다른 전투 중이거나 휴식 중
    if (result.queued) {
      pending = { queued: true, cellId: result.queued.cellId, cell: c, atkBet, defBet: c.def_bet };
      closeSheet();
      showQueueOverlay(c, result.queued);
      return;
    }
    toast('알 수 없는 응답', 'err');
  } catch (e) {
    toast(e.message, 'err');
    // 점유 상태가 어긋났을 가능성 — 셀 새로고침으로 화면 동기화
    if (/점유되지 않은|이미 점유|면제|에너지|보호/.test(e.message || '')) {
      closeSheet();
      refreshCells();
    }
  }
}

// 큐 대기 오버레이
function showQueueOverlay(c, q) {
  show('battleScreen');
  const ov = $('overlay');
  $('ovTitle').textContent = '대기열';
  $('ovTitle').className = '';
  const rest = q.restRemainingSec > 0
    ? `방어자 휴식 중 — ${Math.ceil(q.restRemainingSec)}초 남음`
    : '진행 중 전투 끝나는 대로';
  const sel = q.oddsText || `대기 ${q.queueLen}명`;
  $('ovDesc').innerHTML =
    `${c.username || '거점'} · ${sel}<br>` +
    `<span class="dim">${rest}<br>` +
    `차례가 오면 자동 알림. 다른 일 해도 됩니다.<br>` +
    `(친구 담합 방지 위해 줄선 사람 중 무작위로 뽑힙니다)</span><br>` +
    `<button class="btn ghost" id="qCancelBtn" style="margin-top:14px">대기 취소</button>`;
  $('ovBack').style.display = '';
  ov.classList.add('show');
  $('qCancelBtn').onclick = async () => {
    try {
      await api('/queue/cancel', { method: 'POST', body: { playerId: me.id, cellId: pending.cellId } });
      pending = null;
      show('macroScreen');
      ov.classList.remove('show');
    } catch (e) { toast(e.message, 'err'); }
  };
}

// 도전자: 방어자 응답 대기 화면
function showWaiting(c) {
  show('battleScreen');
  const ov = $('overlay');
  $('ovTitle').textContent = '도전 전송됨';
  $('ovTitle').className = '';
  $('ovDesc').innerHTML = `${c.username || '상대'}의 응답을 기다리는 중...<br><span id="waitCount" class="dim"></span>`;
  $('ovBack').style.display = 'none';
  ov.classList.add('show');
}

// 도전자: AI 방어로 진행 (방어자 미응답/오프라인)
function beginVsAI() {
  const ov = $('overlay'); ov.classList.remove('show'); $('ovBack').style.display = '';
  battle.start(pending.atkBet, pending.defBet, pending.cell.username || '적 거점',
    { mySide: 'atk', pvp: false, proximity: pending.proximity, hero: pending.hero,
      tribeAdv: pending.tribeAdv });
}

// 양쪽: PvP 실시간 대전 시작
function beginPvP() {
  const ov = $('overlay'); ov.classList.remove('show'); $('ovBack').style.display = '';
  show('battleScreen');
  battle.start(pending.atkBet, pending.defBet, pending.regionName || pending.cell?.username || '전장',
    { mySide: pending.mySide, pvp: true, socket, battleId: pending.battleId,
      proximity: pending.proximity, hero: pending.hero, tribeAdv: pending.tribeAdv });
}

// ---- 소켓 이벤트 바인딩 (initGame에서 호출) ----
function bindBattleSockets() {
  // 도전자: 큐에서 차례가 왔음 — 응답 모달
  socket.on('challenge:turn', (data) => {
    if (!pending || !pending.queued || pending.cellId !== data.cellId) {
      // 다른 세션이거나 이미 취소됨 — 그래도 차례가 왔으니 표시 시도
      pending = { queued: false, battleId: data.battleId, cell: pending?.cell || { username: data.regionName, owner_id: data.defenderId },
                  atkBet: data.atkBet, defBet: data.defBet, mySide: 'atk', proximity: data.proximity, hero: data.hero, tribeAdv: data.tribeAdv };
    } else {
      pending.battleId = data.battleId;
      pending.atkBet = data.atkBet;
      pending.defBet = data.defBet;
      pending.proximity = data.proximity;
      pending.hero = data.hero;
      pending.tribeAdv = data.tribeAdv;
      pending.queued = false;
      pending.mySide = 'atk';
    }
    const ov = $('overlay');
    $('ovTitle').textContent = '⚔️ 차례가 왔습니다!';
    $('ovTitle').className = '';
    $('ovDesc').innerHTML =
      `${pending.cell?.username || '거점'} · 베팅 ⚡${data.atkBet} vs ⚡${data.defBet}<br>` +
      `<span class="dim" id="turnCountdown">${data.waitSec}초 안에 시작</span><br>` +
      `<div class="btnrow" style="margin-top:14px">` +
        `<button class="btn ghost" id="turnSkipBtn">포기</button>` +
        `<button class="btn primary" id="turnAcceptBtn">전투 시작</button>` +
      `</div>`;
    $('ovBack').style.display = 'none';
    ov.classList.add('show');
    let n = data.waitSec;
    const t = setInterval(() => {
      n--;
      const el = document.getElementById('turnCountdown');
      if (!el) { clearInterval(t); return; }
      if (n <= 0) { clearInterval(t); return; }
      el.textContent = `${n}초 안에 시작`;
    }, 1000);
    $('turnAcceptBtn').onclick = () => {
      clearInterval(t);
      socket.emit('challenge:turn_accept', {
        battleId: pending.battleId,
        defenderId: pending.cell?.owner_id,
        atkBet: pending.atkBet, defBet: pending.defBet,
        regionName: pending.cell?.username || '거점',
      });
      socket.emit('battle:join', pending.battleId);
      ov.classList.remove('show');
      showWaiting(pending.cell);
    };
    $('turnSkipBtn').onclick = async () => {
      clearInterval(t);
      try { await api('/queue/cancel', { method: 'POST', body: { playerId: me.id, cellId: data.cellId } }); } catch (e) {}
      pending = null;
      show('macroScreen'); ov.classList.remove('show'); $('ovBack').style.display = '';
      refreshCells(); refreshMe();
    };
  });
  socket.on('challenge:turn_timeout', () => {
    if (!pending) return;
    pending = null;
    toast('응답 시간 초과 — 베팅을 잃었습니다.', 'err', 4000);
    show('macroScreen'); $('overlay').classList.remove('show'); $('ovBack').style.display = '';
    refreshCells(); refreshMe();
  });

  // 도전자: 대기 안내
  socket.on('challenge:waiting', ({ waitSec }) => {
    let n = waitSec;
    const el = () => document.getElementById('waitCount');
    if (el()) el().textContent = `(${n}초 내 무응답 시 자동방어 AI와 대전)`;
  });
  // 도전자: AI 폴백
  socket.on('challenge:fallback_ai', () => { if (pending) beginVsAI(); });
  // 도전자: 너무 늦음(이미 폴백) — 무시하고 AI로
  socket.on('challenge:too_late', () => {});
  // 양쪽: PvP 시작 — 방어자가 베팅을 올렸으면 갱신된 defBet 수신
  socket.on('challenge:pvp_start', ({ defBet } = {}) => {
    if (!pending) return;
    if (Number.isFinite(Number(defBet)) && defBet != null) pending.defBet = Number(defBet);
    beginPvP();
  });

  // 방어자: 도전 받음
  socket.on('challenge:incoming', (data) => onIncomingChallenge(data));

  // PvP: 상대가 먼저 종료 보고
  socket.on('battle:opponent_done', ({ winner }) => {
    // 내 쪽이 아직 안 끝났으면, 서버 판정으로 종료시킴
    if (battle && battle.running) battle._end(winner);
  });
}

// 방어자: 도전 알림 수신 → 수락/거절 UI
function onIncomingChallenge({ battleId, attackerName, regionName, atkBet, defBet }) {
  pending = { battleId, regionName, atkBet, defBet, mySide: 'def' };
  socket.emit('battle:join', battleId);
  const modal = $('challengeModal');
  const maxDef = Math.max(defBet, Math.floor(Number(me.energy)));
  $('cmText').innerHTML = `<b>${attackerName}</b> 님이<br><b>${regionName}</b>에 도전했습니다!<br>` +
    `<span class="dim">베팅 ⚡${atkBet} vs 내 방어 ⚡${defBet}</span>` +
    (maxDef > defBet ? `
    <div class="betrow cm-bet"><label>방어 베팅</label>
      <input type="range" id="cmBetSlider" min="${defBet}" max="${maxDef}" value="${defBet}">
      <span class="betval" id="cmBetVal">⚡${defBet}</span></div>
    <span class="dim">올리면 이길 때 더 강하게 시작 (마이크로 시작 에너지)</span>` : '');
  modal.classList.add('show');
  const cmSlider = $('cmBetSlider');
  if (cmSlider) cmSlider.addEventListener('input', () => { $('cmBetVal').textContent = '⚡' + cmSlider.value; });
  // 카운트다운
  let n = (CFG.MICRO.DEFENSE_WAIT_SEC || 15);
  $('cmCount').textContent = n + '초';
  clearInterval(window._cmTimer);
  window._cmTimer = setInterval(() => {
    n--; $('cmCount').textContent = n + '초';
    if (n <= 0) { clearInterval(window._cmTimer); modal.classList.remove('show'); }
  }, 1000);
  $('cmAccept').onclick = () => {
    clearInterval(window._cmTimer); modal.classList.remove('show');
    const newDefBet = cmSlider ? Number(cmSlider.value) : null;
    if (newDefBet && newDefBet > defBet) pending.defBet = newDefBet;
    socket.emit('challenge:accept', { battleId, newDefBet });
    // pvp_start 이벤트에서 전투 시작됨
  };
  $('cmDecline').onclick = () => {
    clearInterval(window._cmTimer); modal.classList.remove('show');
    socket.emit('challenge:decline', { battleId });
  };
}

// 전투 종료 → 서버 검증 (도전자만 resolve 호출, 방어자는 결과 수신)
async function onBattleEnd(clientWinner) {
  tutorial.advance('battled');
  // 내 결과 보고 — 서버가 양쪽 보고를 교차 검증 (PvP), 상대에게도 통지
  if (battle.pvp) {
    socket.emit('battle:report', { battleId: pending.battleId, winner: clientWinner, side: pending.mySide });
  }
  let serverResult = { winner: clientWinner };
  // 도전자(atk)가 서버 판정을 트리거. 방어자는 같은 battleId 결과를 신뢰.
  if (pending.mySide === 'atk') {
    try {
      // PvP: 방어자 보고가 서버에 도착할 시간을 잠깐 준다 (교차 검증용)
      if (battle.pvp) await new Promise((r) => setTimeout(r, 800));
      const body = { playerSkill: 0.55, clientWinner };
      serverResult = await api(`/challenge/${pending.battleId}/resolve`, { method: 'POST', body });
    } catch (e) { serverResult = { winner: clientWinner }; }
  }
  const iWon = (pending.mySide === 'atk' && serverResult.winner === 'attacker') ||
               (pending.mySide === 'def' && serverResult.winner === 'defender');
  const ov = $('overlay');
  $('ovBack').style.display = '';
  $('ovTitle').textContent = iWon ? '승리' : '패배';
  $('ovTitle').className = iWon ? 'win' : 'lose';
  // 사망/영웅 환생 안내 — 방어자의 마지막 셀이 빼앗겨 사망한 경우
  const death = serverResult.death;
  const myDeath = death && pending.mySide === 'def';
  const oppDeath = death && pending.mySide === 'atk';
  let deathNote = '';
  if (myDeath) {
    deathNote = death.heroRolled
      ? `<br><span class="dim">💫 모든 영토를 잃었지만 ${(death.prob*100).toFixed(0)}% 영웅 환생 성공 — 다음 점유에 영웅 상태로 시작!</span>`
      : `<br><span class="dim">💀 모든 영토를 잃고 사망. 누적 노력 부족(글로리 ${death.glory.toFixed(1)}) — 다시 시작.</span>`;
  } else if (oppDeath) {
    deathNote = death.heroRolled
      ? `<br><span class="dim">상대 영토 전멸 → 영웅 환생 (${(death.prob*100).toFixed(0)}% 성공)</span>`
      : `<br><span class="dim">상대 영토 전멸 → 평범하게 사망</span>`;
  }
  // 보상 상세 — 무엇을 얼마나 얻었는지 명확하게 (쾌감은 명세에서 나온다)
  const rw = serverResult.reward;
  if (pending.mySide === 'atk') {
    if (iWon) {
      let gains = `🏰 거점 점유 (가치 ${rw?.cellValue ?? pending.cell?.value ?? '?'})`;
      if (rw) {
        gains += `<br>⚡ 베팅 획득 +${Math.round(rw.defBet)}`;
        if (rw.loot >= 1) gains += `<br>💰 저장 에너지 약탈 <b>+${Math.round(rw.loot)}</b>`;
      }
      $('ovDesc').innerHTML = `${pending.cell?.username || '거점'} 정복!<br><span class="reward-list">${gains}</span>` + deathNote;
    } else {
      $('ovDesc').innerHTML = `도전 실패. 베팅 ⚡${pending.atkBet}을 잃었다.` + deathNote;
    }
  } else {
    $('ovDesc').innerHTML = (iWon
      ? `방어 성공! 영역을 지키고 상대 베팅 ⚡${pending.atkBet}을 가져왔다.`
      : `방어 실패. 영역을 빼앗겼다.`) + deathNote;
  }
  ov.classList.add('show');
  await refreshMe();
}

// ---- 시트 ----
function openSheet() { $('sheet').classList.add('open'); }
function closeSheet() {
  $('sheet').classList.remove('open');
  // 시트 닫힐 때 점유 미리보기도 항상 제거 (다른 경로로 닫히는 경우 대비)
  if (macro && macro.setPreviewCell) macro.setPreviewCell(null);
}
