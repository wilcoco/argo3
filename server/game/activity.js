// ============================================================
//  활동 피드 텍스트 빌더 — resolve 결과 → 브로드캐스트 문구
//  REST resolve 경로와 PvP 아레나(서버 판정) 경로가 공유
// ============================================================

export function buildActivityTexts(result) {
  const out = [];
  if (!result || !result.names) return out;
  const { attacker, defender } = result.names;
  if (result.winner === 'attacker') {
    const lootTxt = result.reward?.loot >= 1 ? ` (+⚡${Math.round(result.reward.loot)} 약탈)` : '';
    out.push(`⚔ ${attacker}님이 ${defender}님의 거점(가치 ${result.cellValue})을 점령!${lootTxt}`);
  } else {
    out.push(`🛡 ${defender}님이 ${attacker}님의 도전을 격퇴!`);
  }
  if (result.death) {
    out.push(result.death.heroRolled
      ? `👑 ${defender}님이 모든 영토를 잃었지만 영웅으로 환생!`
      : `💀 ${defender}님의 영토가 전멸했습니다`);
  }
  return out;
}

export function emitActivity(io, result) {
  if (!io) return;
  for (const text of buildActivityTexts(result)) {
    io.emit('activity', { text, t: Date.now() });
  }
}
