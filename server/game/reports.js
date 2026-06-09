// ============================================================
//  PvP 전투 결과 보고 저장소 (메모리)
//  양쪽 클라이언트가 socket으로 보고한 승자를 모아 두고,
//  REST resolve가 교차 검증에 사용한다.
//  일치 → 채택 / 불일치 → 서버 시뮬 / 단독 보고 → 채택 (상대 이탈)
// ============================================================

const reports = new Map();   // battleId → { atk?: 'attacker'|'defender', def?: ..., at: ms }
const TTL_MS = 10 * 60 * 1000;

export function recordReport(battleId, side, winner) {
  if (side !== 'atk' && side !== 'def') return;
  if (winner !== 'attacker' && winner !== 'defender') return;
  const id = Number(battleId);
  if (!reports.has(id)) reports.set(id, { at: Date.now() });
  reports.get(id)[side] = winner;
}

export function getReports(battleId) {
  const r = reports.get(Number(battleId));
  return r ? { atk: r.atk, def: r.def } : null;
}

export function clearReports(battleId) {
  reports.delete(Number(battleId));
}

// 오래된 항목 정리 (메모리 누수 방지) — 서버 틱에서 주기 호출
export function sweepReports() {
  const now = Date.now();
  for (const [id, r] of reports) {
    if (now - r.at > TTL_MS) reports.delete(id);
  }
}
