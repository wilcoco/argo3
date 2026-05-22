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

function initGame() {
  show('macroScreen');
  updateWallet();
  // 지도
  macro = new MacroMap($('mapCanvas'), {
    zoom: CFG.MACRO.ZOOM,
    cellSizeM: CFG.MACRO.CELL_SIZE_M,
    tribeColors: CFG.TRIBE_COLORS,
    myId: me.id,
    onTapEmpty: openClaim,
    onTapCell: openCell,
  });
  // 위치 권한 시도 → 실패 시 서울
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => { macro.setView(pos.coords.latitude, pos.coords.longitude); refreshCells(); },
      () => refreshCells(),
      { timeout: 5000 }
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
  $('sheetBody').innerHTML = `
    <h3>빈 땅 점유 <span class="tag free">미점유</span></h3>
    <div class="sub">크게 점유할수록 더 많은 에너지가 들고, 영역 가치가 높아진다.</div>
    <div class="slider-row">
      <label>영역 가치 / 비용</label>
      <input type="range" id="claimSize" min="${minV}" max="${cap}" value="${initV}" step="1">
      <span id="claimSizeVal">⚡${initV}</span>
    </div>
    <div class="btnrow">
      <button class="btn ghost" id="cancelBtn">취소</button>
      <button class="btn primary" id="claimBtn" ${me.energy<minV?'disabled':''}>점유</button>
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
      await api('/claim', { method: 'POST', body: { playerId: me.id, lat, lng, value } });
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
  $('sheetBody').innerHTML = `
    <h3>${c.username || '적 거점'} <span class="tag enemy">적 영역</span></h3>
    <div class="sub">가치 ${c.value} · 방어 베팅 ⚡${c.def_bet}<br>이기면 점유권+베팅 획득, 지면 베팅 손실</div>
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
    pending = { battleId: result.battle.id, cell: c, atkBet, defBet: c.def_bet, mySide: 'atk' };
    closeSheet();
    socket.emit('battle:join', result.battle.id);
    // 방어자에게 도전 알림 → 응답 대기
    socket.emit('challenge:initiate', {
      battleId: result.battle.id,
      defenderId: c.owner_id,
      attackerName: me.username,
      regionName: c.username || '적 거점',
      atkBet, defBet: c.def_bet,
    });
    // 대기 화면 표시 (응답은 소켓 이벤트로)
    showWaiting(c);
  } catch (e) { alert(e.message); }
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
    { mySide: 'atk', pvp: false });
}

// 양쪽: PvP 실시간 대전 시작
function beginPvP() {
  const ov = $('overlay'); ov.classList.remove('show'); $('ovBack').style.display = '';
  show('battleScreen');
  battle.start(pending.atkBet, pending.defBet, pending.regionName || pending.cell?.username || '전장',
    { mySide: pending.mySide, pvp: true, socket, battleId: pending.battleId });
}

// ---- 소켓 이벤트 바인딩 (initGame에서 호출) ----
function bindBattleSockets() {
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
