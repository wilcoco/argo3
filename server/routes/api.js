// ============================================================
//  REST API 라우트
// ============================================================
import express from 'express';
import {
  createPlayer, getPlayer, getCellsInBounds, claimCell,
  startChallenge, resolveChallenge, getTick, cancelQueueEntry, skipRest,
  harvestCell, harvestAll, supplyCell, touchPlayer, getPlayerCells, getLeaderboard,
} from '../game/macro.js';
import { query } from '../db/pool.js';
import { estimateWinProb } from '../game/battle.js';
import { CONFIG } from '../game/config.js';
import { getReports, clearReports } from '../game/reports.js';
import { listQuests, claimQuest } from '../game/quests.js';
import { emitActivity } from '../game/activity.js';

export const router = express.Router();

// 설정 노출 (클라이언트가 동일 상수 사용)
router.get('/config', (req, res) => res.json(CONFIG));

// 플레이어 생성/로그인 (간이: username만)
router.post('/player', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || username.length < 2) return res.status(400).json({ error: '닉네임 2자 이상' });
    const p = await createPlayer(username.slice(0, 24));
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/player/:id', async (req, res) => {
  try {
    const p = await getPlayer(Number(req.params.id));
    if (!p) return res.status(404).json({ error: '없음' });
    // 본인 폴링 = 활동 하트비트 (수면 보호 판정용)
    touchPlayer(Number(req.params.id)).catch(() => {});
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 내 셀 목록 — 지도에서 내 영토로 점프용
router.get('/player/:id/cells', async (req, res) => {
  try {
    res.json(await getPlayerCells(Number(req.params.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 지도 영역 내 영토 조회
router.get('/cells', async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;
    const cells = await getCellsInBounds(+minLat, +minLng, +maxLat, +maxLng);
    res.json(cells);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 빈 땅 점유
router.post('/claim', async (req, res) => {
  try {
    const { playerId, lat, lng, value, playerLat, playerLng } = req.body;
    const playerLoc = (Number.isFinite(+playerLat) && Number.isFinite(+playerLng))
      ? { lat: +playerLat, lng: +playerLng }
      : null;
    const result = await claimCell(
      Number(playerId), +lat, +lng,
      value != null ? +value : undefined,
      playerLoc
    );
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 도전 시작 (전투 레코드 생성) — cellId 우선, 없으면 cellX/cellY 호환
// playerLat/Lng 필수 — 도전도 점유처럼 GPS 반경 제한
router.post('/challenge', async (req, res) => {
  try {
    const { playerId, cellId, cellX, cellY, atkBet, playerLat, playerLng } = req.body;
    const target = cellId != null ? { cellId } : { cellX, cellY };
    const playerLoc = (Number.isFinite(+playerLat) && Number.isFinite(+playerLng))
      ? { lat: +playerLat, lng: +playerLng } : null;
    const result = await startChallenge(Number(playerId), target, Number(atkBet), playerLoc);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 도전 결과 판정 — 실시간 전투 종료 후 호출.
// PvP: 소켓으로 모인 양쪽 보고를 교차 검증 (클라 body의 pvpWinner는 받지 않음 — 위조 방지).
// vs AI: clientWinner를 원칙 신뢰하되 서버 승률 추정으로 sanity check.
router.post('/challenge/:id/resolve', async (req, res) => {
  try {
    const { playerSkill, pvpWinner, clientWinner } = req.body || {};
    const battleId = Number(req.params.id);
    const reports = getReports(battleId);
    const result = await resolveChallenge(battleId, {
      playerSkill,
      reports,
      clientWinner: clientWinner || pvpWinner,  // 구버전 클라 호환 (pvpWinner도 sanity check 경로로)
    });
    clearReports(battleId);
    // 활동 피드 — 살아있는 세계 감각 (전투 결과를 전체에 브로드캐스트)
    emitActivity(req.app.get('io'), result);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 순위표 — 영토 가치 상위
router.get('/leaderboard', async (req, res) => {
  try { res.json(await getLeaderboard(10)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 한번에 수확
router.post('/harvestall', async (req, res) => {
  try {
    const { playerId } = req.body;
    res.json(await harvestAll(Number(playerId)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 보급 — 지갑 에너지를 타워 저장고로 (전선 군량)
router.post('/supply', async (req, res) => {
  try {
    const { playerId, cellId, amount } = req.body;
    res.json(await supplyCell(Number(playerId), Number(cellId), amount));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 데일리 퀘스트 — 오늘 목록 + 진행
router.get('/quests/:playerId', async (req, res) => {
  try { res.json(await listQuests(Number(req.params.playerId))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 퀘스트 보상 수령
router.post('/quests/claim', async (req, res) => {
  try {
    const { playerId, key } = req.body;
    res.json(await claimQuest(Number(playerId), String(key)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 수확 — 타워에 쌓인 에너지를 지갑으로
router.post('/harvest', async (req, res) => {
  try {
    const { playerId, cellId, amount } = req.body;
    const result = await harvestCell(Number(playerId), Number(cellId), amount);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 승률 추정 (도전 전 표시용)
router.get('/winprob', (req, res) => {
  const { atkBet, defBet } = req.query;
  res.json({ prob: estimateWinProb(+atkBet, +defBet) });
});

router.get('/tick', async (req, res) => res.json({ tick: await getTick() }));

// 방어자: 짧은 휴식 스킵하고 다음 도전 받기
router.post('/defender/ready', async (req, res) => {
  try {
    const { playerId, cellId } = req.body;
    const result = await skipRest(Number(cellId), Number(playerId));
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 대기열 취소
router.post('/queue/cancel', async (req, res) => {
  try {
    const { playerId, cellId } = req.body;
    const ok = await cancelQueueEntry(Number(cellId), Number(playerId));
    res.json({ removed: ok });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 대기열 상태 — 특정 셀의 큐 길이와 내 위치
router.get('/queue/status', async (req, res) => {
  try {
    const cellId = Number(req.query.cellId);
    const playerId = req.query.playerId != null ? Number(req.query.playerId) : null;
    const rows = (await query(
      `SELECT challenger_id, queued_at FROM cell_queue WHERE cell_id=$1 ORDER BY queued_at ASC`,
      [cellId])).rows;
    let position = -1;
    rows.forEach((r, i) => { if (r.challenger_id === playerId) position = i + 1; });
    const cell = (await query(`SELECT rest_until FROM cells WHERE id=$1`, [cellId])).rows[0];
    const tick = await getTick();
    const tickSec = CONFIG.MACRO.SERVER_TICK_MS / 1000;
    const restRemainingSec = cell && cell.rest_until
      ? Math.max(0, (Number(cell.rest_until) - tick) * tickSec)
      : 0;
    res.json({ queueLen: rows.length, position, restRemainingSec });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
