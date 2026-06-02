// ============================================================
//  BACTERIA WAR — 게임 설정 (서버/클라이언트 공유)
//  시뮬레이션으로 검증된 변수들을 한 곳에 모음.
//  ESM과 브라우저 양쪽에서 쓸 수 있게 구성.
// ============================================================

export const CONFIG = {
  // ---- 종족 (가위바위보 상성) ----
  TRIBE_COUNT: 3,
  TRIBE_NAMES: ['Cyan', 'Crimson', 'Gold'],
  TRIBE_COLORS: ['#3ad1c8', '#ff5d73', '#ffc24d'],
  // 상성: tribe[i]가 tribe[(i+1)%N]을 이김

  // ---- 매크로 (지도 영토) ----
  MACRO: {
    ZOOM: 14,                  // 매크로 지도 줌
    CELL_SIZE_M: 200,          // 한 영역 셀의 실제 크기 (미터, 대략)
    CLAIM_MIN_VALUE: 15,       // 최소 영역 가치(=점유 비용 최저)
    CLAIM_MAX_VALUE: 90,       // 최대 영역 가치(=점유 비용 최고)
    CLAIM_DEFAULT_VALUE: 25,   // 슬라이더 초기값
    CLAIM_RADIUS_M: 1000,      // 현재 GPS 위치에서 점유 가능한 반경 (m)
    CELL_PHYSICAL_BASE_M: 100, // 셀 물리 반경 기본값 (m). 실제 = sqrt(value/40) × base
    ENEMY_CHALLENGE_DIST_M: 50,// 적 셀과 이 거리 이내에 점유 시도 → 자동 도전 흐름으로 전환
    INCOME_PER_VALUE: 0.15,    // 셀 가치당 시간당 수입 — 0.08 → 0.15로 ~2배 ↑ (체감 속도 개선)
    BOT_TARGET_PER_VIEW: 5,    // 지도 시야 내 최소 적 셀 수 (밑돌면 봇 셀 자동 생성)
    BOT_VALUE_MIN: 20,
    BOT_VALUE_MAX: 50,
    BOT_DEF_BET_RATIO: 0.4,    // 봇 셀의 방어 베팅 = 가치 × 이값 (낮게 → 도전 쉽게)
    MAX_ENERGY: 500,           // 에너지 저장 상한 — 쌓아두기만 하면 손해, 사용 압박
    // 영웅 — 사망(마지막 셀 상실) 시 누적 노력에 비례한 확률로 발동
    HERO_GLORY_PER_WIN: 3,     // 사망 시 글로리 = combat_wins × 이값 + karma × ...
    HERO_GLORY_PER_KARMA: 0.5,
    HERO_PROB_DIVISOR: 50,     // 확률 = min(CAP, glory / 이값)
    HERO_PROB_CAP: 0.8,        // 최대 영웅 확률
    HERO_DURATION_TICKS: 80,   // 영웅 지속 (틱)
    HERO_TOWER_BONUS: 0.5,     // 영웅이 마이크로 전투 진입 시 시작 탑 크기 +50%
    CORE_BONUS: 2.0,           // 노른자(밀집지) 셀 수입 배율
    DENSITY_RADIUS: 3,         // 밀도 측정 반경 (셀)
    DENSITY_OPT: 8,            // 최적 밀도
    DENSITY_PEAK: 3.0,         // 최적 밀도 생산 배율
    DENSITY_WIDTH: 5,          // 봉우리 폭
    DENSITY_MIN: 0.3,          // 외로운 셀 최소 배율
    SERVER_TICK_MS: 5000,      // 매크로 서버 틱 주기 (5초 = 게임상 1시간 가정)
    COUNTER_EROSION: 0.04,     // 상성 경계 잠식 확률(틱당) — 압박만, 점유이전은 마이크로
    DEFENDER_REST_TICKS: 12,   // 매 전투 후 짧은 휴식 (12틱 = 60초). 그동안 큐 누적, 방어자가 곧장 다음 수락 가능.
    REST_FATIGUE_CONSEC: 5,    // 연속 N방어하면 강제 장기 휴식
    REST_FATIGUE_CONSEC_TICKS: 720, // 강제 휴식 길이 (720틱 = 1시간)
    REST_FATIGUE_DAILY: 10,    // 하루 N방어하면 강제 초장기 휴식
    REST_FATIGUE_DAILY_TICKS: 5760, // 초장기 휴식 (5760틱 = 8시간)
    QUEUE_SELECTION: 'random', // 'fifo' | 'random' (담합 방지 위해 랜덤 권장)
    CHALLENGER_RESPONSE_SEC: 30, // 큐에서 차례 됐을 때 응답 대기. 미응답 시 다음으로.
  },

  // ---- 마이크로 (실시간 전투) — 바둑·오델로식 ----
  MICRO: {
    BATTLE_ZOOM: 17,
    ARENA_RATIO: 0.42,         // 아레나 반경 = min(W,H) * 이 값
    COUNTDOWN_SEC: 3,
    DEFENSE_WAIT_SEC: 15,      // 방어자 응답 대기 시간 (초). 미응답 시 AI 폴백.
    AI_STRENGTH: 0.85,         // 자동방어 AI 강도

    // 돌(탑) 균일 — 크기·HP·비용 고정
    STONE_R: 18,               // 돌 반경 (px)
    STONE_HP_MAX: 30,
    STONE_COST: 15,
    FLIP_HP: 30,               // 변환 시 부활 HP (= 만렙)
    MIN_SPACING_FACTOR: 2.2,   // 돌 사이 최소 거리 = STONE_R × 이값 (겹침 금지)
    ATTACK_RANGE_FACTOR: 2.0,  // 자동 공격 사거리 = STONE_R × 이값 (≈ 인접)
    DPS_PER_ATTACKER: 1.5,     // 공격자 1명당 초당 데미지
    INCOME_PER_TOWER: 0.4,     // 탑 1개당 초당 에너지 생산 (탑 많을수록 지수 성장)
    PLACE_COOLDOWN: 0.4,       // 돌 두기 행동 쿨다운 (초) — 봇/연속 탭 제한
    MAX_T: 120,                // 전투 시간 상한 (초). 타임아웃 시 다수 승.

    // 시작 보너스
    PROXIMITY_RADIUS_M: 800,
    PROXIMITY_BONUS_PER: 1,    // 보급선 1셀당 시작 돌 +1개
    PROXIMITY_BONUS_MAX: 4,    // 최대 +4개
    HERO_INCOME_BONUS: 0.5,    // 영웅 진영 INCOME +50%
  },

  // ---- 베팅 경제 (명세서 6장) ----
  BETTING: {
    CAP_THRESHOLD: 200,        // 자산 임계 (이상이면 베팅 상한)
    CAP_RATIO: 0.5,            // 임계 초과 시 베팅 상한 = 보유 * 이값
    CHALLENGE_MIN_RATIO: 1.0,  // 도전 최소 베팅 = 방어 베팅 * 이값
  },

  // ---- 면제 (명세서 3장) ----
  EXEMPT: {
    WINS: 3,                   // 면제 발동 방어 승수
    HOURS: 8,                  // 면제 지속 (게임시간)
    VALUE_SCALING: true,       // 고가치 영역일수록 면제 짧게
  },

  // ---- 시간 보호 (명세서 4장) ----
  SHIELD: {
    BASE_HOURS: 8,             // 기본 무적 (수면)
    PAID_MAX_HOURS: 4,         // 유료 연장 상한
    EXPOSURE_MIN_HOURS: 12,    // 노출 최소 (불변)
  },

  // ---- 환생 생태계 (시뮬 검증) ----
  ECOSYSTEM: {
    LIFE_MIN: 120, LIFE_MAX: 400,   // 자연사 수명 범위 (틱)
    KARMA_COMBAT_WIN: 5,            // 전투 승리 카르마 (핵심)
    KARMA_SURVIVAL: 0.3,
    KARMA_TERRITORY: 0.5,
    COMBAT_DEATH_HERO_BONUS: 4,     // 전사 시 영웅확률 보너스
    KARMA_TO_HERO: 0.0008,
    HERO_BASE_CHANCE: 0.008,
    HERO_POWER: 10,
    HERO_DURATION: 80,
    GAP_BOOST: 2,                   // 격차비례 약자보정
    WEAK_BOOST_POWER: 2,
  },

  // ---- 시작 자원 ----
  START_ENERGY: 100,
};

// 상성 판정: ta가 tb를 이기는가
export function tribeBeats(ta, tb, n = CONFIG.TRIBE_COUNT) {
  if (ta === tb) return false;
  return (ta + 1) % n === tb;
}

// 밀도 → 생산 배율 (봉우리 곡선)
export function densityMult(n, M = CONFIG.MACRO) {
  const d = n - M.DENSITY_OPT;
  let g = M.DENSITY_PEAK * Math.exp(-Math.pow(d / M.DENSITY_WIDTH, 2));
  return Math.max(M.DENSITY_MIN, g);
}

// 베팅 상한
export function maxBet(energy, assets, B = CONFIG.BETTING) {
  if (assets >= B.CAP_THRESHOLD) return Math.floor(energy * B.CAP_RATIO);
  return Math.floor(energy);
}

// 브라우저 전역 노출 (모듈 미지원 환경 폴백)
if (typeof window !== 'undefined') {
  window.BW_CONFIG = CONFIG;
  window.BW_tribeBeats = tribeBeats;
  window.BW_densityMult = densityMult;
  window.BW_maxBet = maxBet;
}
