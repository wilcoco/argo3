// ============================================================
//  BACTERIA WAR 서버 — Express + Socket.IO + 생태계 틱
// ============================================================
import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { router as apiRouter } from './routes/api.js';
import { ecosystemTick } from './game/macro.js';
import { CONFIG } from './game/config.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// 정적 클라이언트
app.use(express.static(path.join(__dirname, '..', 'public')));
// API
app.use('/api', apiRouter);
// 헬스체크 (Railway)
app.get('/healthz', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: '*' } });

// 온라인 플레이어 추적: playerId -> socketId
const onlinePlayers = new Map();
// 응답 대기 중인 도전: battleId -> { resolved, timer, attackerSocket }
const pendingChallenges = new Map();

// ---- Socket.IO: 실시간 매크로 동기화 + 전투 ----
io.on('connection', (socket) => {
  // 플레이어가 보고 있는 지도 영역 구독
  socket.on('subscribe:region', (bounds) => {
    socket.join('region'); // 간이: 전체 한 방. 확장 시 지오해시 방으로.
  });

  // ---- 온라인 추적: 플레이어ID ↔ 소켓 ----
  socket.on('player:online', (playerId) => {
    if (playerId == null) return;
    socket.data.playerId = Number(playerId);
    onlinePlayers.set(Number(playerId), socket.id);
  });

  // ---- 도전 흐름: 방어자에게 알림 → 응답 대기 → PvP / AI 폴백 ----
  // 도전자가 도전 시작을 알림 (battle 레코드는 이미 REST로 생성됨)
  socket.on('challenge:initiate', ({ battleId, defenderId, attackerName, regionName, atkBet, defBet }) => {
    const defSocketId = onlinePlayers.get(Number(defenderId));
    const room = `battle:${battleId}`;
    socket.join(room);
    if (defSocketId) {
      // 방어자 온라인 → 알림 보내고 응답 대기
      pendingChallenges.set(battleId, { resolved: false, attackerSocket: socket.id });
      io.to(defSocketId).emit('challenge:incoming', { battleId, attackerName, regionName, atkBet, defBet });
      // 응답 타이머 (CONFIG의 대기시간)
      const waitMs = (CONFIG.MICRO.DEFENSE_WAIT_SEC || 15) * 1000;
      const timer = setTimeout(() => {
        const pc = pendingChallenges.get(battleId);
        if (pc && !pc.resolved) {
          pc.resolved = true;
          pendingChallenges.delete(battleId);
          io.to(socket.id).emit('challenge:fallback_ai', { battleId }); // 도전자에게 "AI 방어로 진행"
        }
      }, waitMs);
      pendingChallenges.get(battleId).timer = timer;
      // 도전자에게 "방어자 응답 대기 중"
      io.to(socket.id).emit('challenge:waiting', { battleId, waitSec: CONFIG.MICRO.DEFENSE_WAIT_SEC || 15 });
    } else {
      // 방어자 오프라인 → 즉시 AI 방어
      io.to(socket.id).emit('challenge:fallback_ai', { battleId });
    }
  });

  // 방어자가 수락
  socket.on('challenge:accept', ({ battleId }) => {
    const pc = pendingChallenges.get(battleId);
    if (!pc || pc.resolved) {
      // 이미 AI로 폴백됨 — 너무 늦음
      io.to(socket.id).emit('challenge:too_late', { battleId });
      return;
    }
    pc.resolved = true;
    clearTimeout(pc.timer);
    pendingChallenges.delete(battleId);
    const room = `battle:${battleId}`;
    socket.join(room);
    // 양쪽에게 PvP 시작 통지
    io.to(room).emit('challenge:pvp_start', { battleId });
    io.to(pc.attackerSocket).emit('challenge:pvp_start', { battleId });
  });

  // 방어자가 거절
  socket.on('challenge:decline', ({ battleId }) => {
    const pc = pendingChallenges.get(battleId);
    if (pc && !pc.resolved) {
      pc.resolved = true;
      clearTimeout(pc.timer);
      pendingChallenges.delete(battleId);
      io.to(pc.attackerSocket).emit('challenge:fallback_ai', { battleId });
    }
  });

  // 실시간 전투 입력 중계
  socket.on('battle:join', (battleId) => socket.join(`battle:${battleId}`));
  socket.on('battle:action', ({ battleId, action }) => {
    socket.to(`battle:${battleId}`).emit('battle:action', action);
  });
  socket.on('battle:state', ({ battleId, state }) => {
    socket.to(`battle:${battleId}`).emit('battle:state', state);
  });
  // 전투 종료 보고 (양쪽이 보고 → 서버가 대조). 간이: 먼저 도착한 결과 채택 후 상대에 통지.
  socket.on('battle:report', ({ battleId, winner }) => {
    socket.to(`battle:${battleId}`).emit('battle:opponent_done', { winner });
  });

  socket.on('disconnect', () => {
    if (socket.data.playerId != null) onlinePlayers.delete(socket.data.playerId);
  });
});

// ---- 생태계 틱 루프 ----
let tickTimer = null;
async function startTickLoop() {
  if (tickTimer) return;
  const run = async () => {
    try {
      await ecosystemTick(io);
    } catch (e) {
      console.error('tick 오류:', e.message);
    }
  };
  tickTimer = setInterval(run, CONFIG.MACRO.SERVER_TICK_MS);
  console.log(`생태계 틱 시작 (${CONFIG.MACRO.SERVER_TICK_MS}ms 주기)`);
}

server.listen(PORT, () => {
  console.log(`🦠 BACTERIA WAR 서버 실행: 포트 ${PORT}`);
  // DB가 준비된 경우에만 틱 시작 (DATABASE_URL 있을 때)
  if (process.env.DATABASE_URL) {
    startTickLoop();
  } else {
    console.warn('⚠ DATABASE_URL 미설정 — 생태계 틱 비활성. DB 연결 후 재시작하세요.');
  }
});
