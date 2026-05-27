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

  setInterval(refreshCells, 8000);
  setInterval(refreshMe, 10000);
}

function updateWallet() {
  $('energy').textContent = Math.floor(me.energy);
  $('record').textContent = `${me.wins}승 ${me.losses}패`;
  const badge = $('tribeBadge');
  badge.textContent = CFG.TRIBE_NAMES[me.tribe];
  badge.style.background = CFG.TRIBE_COLORS[me.tribe];
  badge.style.color = '#04201e';
}
async function refreshMe() {
  try { me = await api('/player/' + me.id); updateWallet(); } catch {}
}

async function refreshCells() {
  if (!macro) return;
  const b = macroBounds();
  try {
    const cells = await api(`/cells?minLat=${b.minLat}&minLng=${b.minLng}&maxLat=${b.maxLat}&maxLng=${b.maxLng}`);
    macro.setCells(cells);
  } catch {}
}
function macroBounds() {
  const v = macro.view, d = 0.02;
  return { minLat: v.lat - d, minLng: v.lng - d, maxLat: v.lat + d, maxLng: v.lng + d };
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
function openClaim(lat, lng) {
  const M = CFG.MACRO;
  const minV = M.CLAIM_MIN_VALUE, maxV = M.CLAIM_MAX_VALUE;
  // 가진 에너지를 넘지 않게 상한 추가 클램프
  const cap = Math.max(minV, Math.min(maxV, Math.floor(me.energy)));
  const initV = Math.max(minV, Math.min(cap, M.CLAIM_DEFAULT_VALUE));
  // GPS 반경 사전 확인 (서버도 검증하지만 UX상 미리 알림)
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
    <div class="sub">크게 점유할수록 더 많은 에너지가 들고, 영역 가치가 높아진다.</div>
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
  };
  update();
  slider.addEventListener('input', update);
  $('cancelBtn').onclick = closeSheet;
  btn.onclick = async () => {
    try {
      const value = Number(slider.value);
      await api('/claim', { method: 'POST', body: {
        playerId: me.id, lat, lng, value,
        playerLat: myLoc?.lat, playerLng: myLoc?.lng,
      }});
      closeSheet(); await refreshMe(); await refreshCells();
    } catch (e) { alert(e.message); }
  };
}

// ---- 셀 탭 (내 영역 / 적 영역) ----
function openCell(c) {
  if (c.owner_id === me.id) {
    $('sheetBody').innerHTML = `
      <h3>${c.username || '내 거점'} <span class="tag me">내 영역</span></h3>
      <div class="sub">가치 ${c.value} · 자동방어 베팅 ⚡${c.def_bet}</div>
      <div class="btnrow"><button class="btn ghost" id="cancelBtn">닫기</button></div>`;
    openSheet(); $('cancelBtn').onclick = closeSheet;
    return;
  }
  // 적 영역 → 도전
  const minBet = Math.ceil(c.def_bet * CFG.BETTING.CHALLENGE_MIN_RATIO);
  const assets = me.energy + 30;
  const cap = assets >= CFG.BETTING.CAP_THRESHOLD ? Math.floor(me.energy * CFG.BETTING.CAP_RATIO) : Math.floor(me.energy);
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
  $('sheetBody').innerHTML = `
    <h3>${c.username || '적 거점'} <span class="tag enemy">적 영역</span></h3>
    <div class="sub">가치 ${c.value} · 방어 베팅 ⚡${c.def_bet}<br>이기면 점유권+베팅 획득, 지면 베팅 손실</div>
    <div id="queueInfo" class="sub"></div>
    <div class="betrow"><label>내 베팅</label>
      <input type="range" id="betSlider" min="${minBet}" max="${Math.max(minBet,cap)}" value="${minBet}">
      <span class="betval" id="betVal">⚡${minBet}</span></div>
    <div class="sub" id="betInfo"></div>
    <div class="btnrow">
      <button class="btn ghost" id="cancelBtn">취소</button>
      <button class="btn danger" id="chalBtn" ${me.energy<minBet?'disabled':''}>도전 (실시간 전투)</button>
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
      body: { playerId: me.id, cellX: c.cell_x, cellY: c.cell_y, atkBet } });

    // (A) 즉시 전투 시작 (셀이 한가)
    if (result.battle) {
      pending = { battleId: result.battle.id, cell: c, atkBet, defBet: c.def_bet, mySide: 'atk',
                  proximity: result.proximity };
      closeSheet();
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
    alert('알 수 없는 응답');
  } catch (e) { alert(e.message); }
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
    } catch (e) { alert(e.message); }
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
    { mySide: 'atk', pvp: false, proximity: pending.proximity });
}

// 양쪽: PvP 실시간 대전 시작
function beginPvP() {
  const ov = $('overlay'); ov.classList.remove('show'); $('ovBack').style.display = '';
  show('battleScreen');
  battle.start(pending.atkBet, pending.defBet, pending.regionName || pending.cell?.username || '전장',
    { mySide: pending.mySide, pvp: true, socket, battleId: pending.battleId,
      proximity: pending.proximity });
}

// ---- 소켓 이벤트 바인딩 (initGame에서 호출) ----
function bindBattleSockets() {
  // 도전자: 큐에서 차례가 왔음 — 응답 모달
  socket.on('challenge:turn', (data) => {
    if (!pending || !pending.queued || pending.cellId !== data.cellId) {
      // 다른 세션이거나 이미 취소됨 — 그래도 차례가 왔으니 표시 시도
      pending = { queued: false, battleId: data.battleId, cell: pending?.cell || { username: data.regionName, owner_id: data.defenderId },
                  atkBet: data.atkBet, defBet: data.defBet, mySide: 'atk', proximity: data.proximity };
    } else {
      pending.battleId = data.battleId;
      pending.atkBet = data.atkBet;
      pending.defBet = data.defBet;
      pending.proximity = data.proximity;
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
    alert('응답 시간 초과 — 베팅을 잃었습니다.');
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
  // 양쪽: PvP 시작
  socket.on('challenge:pvp_start', () => { if (pending) beginPvP(); });

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
  $('cmText').innerHTML = `<b>${attackerName}</b> 님이<br><b>${regionName}</b>에 도전했습니다!<br>` +
    `<span class="dim">베팅 ⚡${atkBet} vs 내 방어 ⚡${defBet}</span>`;
  modal.classList.add('show');
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
    socket.emit('challenge:accept', { battleId });
    // pvp_start 이벤트에서 전투 시작됨
  };
  $('cmDecline').onclick = () => {
    clearInterval(window._cmTimer); modal.classList.remove('show');
    socket.emit('challenge:decline', { battleId });
  };
}

// 전투 종료 → 서버 검증 (도전자만 resolve 호출, 방어자는 결과 수신)
async function onBattleEnd(clientWinner) {
  // PvP: 상대에게 내 결과 보고
  if (battle.pvp) {
    socket.emit('battle:report', { battleId: pending.battleId, winner: clientWinner });
  }
  let serverResult = { winner: clientWinner };
  // 도전자(atk)가 서버 권위 판정을 트리거. 방어자는 같은 battleId 결과를 신뢰.
  if (pending.mySide === 'atk') {
    try {
      const body = { playerSkill: 0.55 };
      if (battle.pvp) body.pvpWinner = clientWinner;   // PvP면 실제 승자 전달
      serverResult = await api(`/challenge/${pending.battleId}/resolve`, { method: 'POST', body });
    } catch (e) { serverResult = { winner: clientWinner }; }
  }
  const iWon = (pending.mySide === 'atk' && serverResult.winner === 'attacker') ||
               (pending.mySide === 'def' && serverResult.winner === 'defender');
  const ov = $('overlay');
  $('ovBack').style.display = '';
  $('ovTitle').textContent = iWon ? '승리' : '패배';
  $('ovTitle').className = iWon ? 'win' : 'lose';
  if (pending.mySide === 'atk') {
    $('ovDesc').innerHTML = iWon ? `${pending.cell?.username || '거점'} 점유권 획득!` : `도전 실패. 베팅을 잃었다.`;
  } else {
    $('ovDesc').innerHTML = iWon ? `방어 성공! 영역을 지켰다.` : `방어 실패. 영역을 빼앗겼다.`;
  }
  ov.classList.add('show');
  await refreshMe();
}

// ---- 시트 ----
function openSheet() { $('sheet').classList.add('open'); }
function closeSheet() { $('sheet').classList.remove('open'); }
