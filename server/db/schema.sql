-- ============================================================
--  BACTERIA WAR — PostgreSQL 스키마
--  매크로 영토 생태계 + 마이크로 전투 기록
-- ============================================================

-- 플레이어
CREATE TABLE IF NOT EXISTS players (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  tribe         SMALLINT NOT NULL,              -- 0~2 종족 (가위바위보)
  energy        REAL NOT NULL DEFAULT 120,
  karma         REAL NOT NULL DEFAULT 0,
  combat_wins   INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  is_hero       BOOLEAN NOT NULL DEFAULT FALSE,
  hero_until    BIGINT,                          -- 영웅 만료 (서버 tick)
  hero_power    REAL DEFAULT 10,
  born_tick     BIGINT NOT NULL DEFAULT 0,
  lifespan      BIGINT,                          -- 자연사 수명 (tick)
  alive         BOOLEAN NOT NULL DEFAULT TRUE,
  -- 활동 시간대 보호 (무적 시간대)
  shield_start  SMALLINT DEFAULT 0,              -- 0~23시
  shield_hours  SMALLINT DEFAULT 8,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 영토 셀 (매크로 지도 영역)
-- 위도/경도를 그리드 셀로 양자화: cell_x, cell_y
CREATE TABLE IF NOT EXISTS cells (
  id            BIGSERIAL PRIMARY KEY,
  cell_x        INTEGER NOT NULL,                -- 공간 인덱스 hint (자유 배치 이후엔 위치 근사)
  cell_y        INTEGER NOT NULL,
  owner_id      INTEGER REFERENCES players(id) ON DELETE SET NULL,
  tribe         SMALLINT,                        -- 소유자 종족 (캐시)
  value         REAL NOT NULL DEFAULT 40,        -- 영역 가치 (= 점유 비용 = 물리 반경 기준)
  def_bet       REAL NOT NULL DEFAULT 20,        -- 자동방어 베팅
  def_wins      INTEGER NOT NULL DEFAULT 0,      -- 누적 방어승 (면제용)
  exempt_until  BIGINT,                          -- 면제 만료 (tick)
  lat           DOUBLE PRECISION,                -- 셀 중심 위도 (자유 배치 — 그리드 스냅 아님)
  lng           DOUBLE PRECISION,                -- 셀 중심 경도
  claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  -- (UNIQUE cell_x,cell_y 제거됨: 자유 배치 + 자기 겹침 허용)
);
CREATE INDEX IF NOT EXISTS idx_cells_owner ON cells(owner_id);
CREATE INDEX IF NOT EXISTS idx_cells_xy ON cells(cell_x, cell_y);
CREATE INDEX IF NOT EXISTS idx_cells_tribe ON cells(tribe);

-- 기존 DB에서 UNIQUE 제약 제거 (자유 배치 전환). 멱등.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cells_cell_x_cell_y_key') THEN
    ALTER TABLE cells DROP CONSTRAINT cells_cell_x_cell_y_key;
  END IF;
END $$;

-- 플레이어에 봇 플래그 추가 (NPC 시드 봇 식별)
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_players_bot ON players(is_bot);

-- 셀에 cooldown(휴식) + 피로 카운터 추가
ALTER TABLE cells ADD COLUMN IF NOT EXISTS rest_until BIGINT;
-- 타워별 에너지 저장 (수확 루프) — 생산은 틱에서 누적, 수확으로 지갑 이전
ALTER TABLE cells ADD COLUMN IF NOT EXISTS stored_energy REAL NOT NULL DEFAULT 0;
ALTER TABLE cells ADD COLUMN IF NOT EXISTS consec_defenses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cells ADD COLUMN IF NOT EXISTS defenses_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cells ADD COLUMN IF NOT EXISTS defenses_day_start TIMESTAMPTZ;

-- 도전(전투) 기록
CREATE TABLE IF NOT EXISTS battles (
  id            BIGSERIAL PRIMARY KEY,
  cell_id       BIGINT REFERENCES cells(id) ON DELETE CASCADE,
  attacker_id   INTEGER REFERENCES players(id) ON DELETE SET NULL,
  defender_id   INTEGER REFERENCES players(id) ON DELETE SET NULL,
  atk_bet       REAL NOT NULL,
  def_bet       REAL NOT NULL,
  winner        TEXT,                            -- 'attacker' | 'defender'
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | active | done
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_battles_cell ON battles(cell_id);
CREATE INDEX IF NOT EXISTS idx_battles_status ON battles(status);

-- 도전 대기 큐 (FIFO). 한 셀에 같은 도전자는 하나만.
CREATE TABLE IF NOT EXISTS cell_queue (
  id            BIGSERIAL PRIMARY KEY,
  cell_id       BIGINT NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  challenger_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  atk_bet       REAL NOT NULL,
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cell_id, challenger_id)
);
CREATE INDEX IF NOT EXISTS idx_queue_cell ON cell_queue(cell_id, queued_at);

-- 종족 영혼 풀 (환생 영웅 연료) + 종족 통계
CREATE TABLE IF NOT EXISTS tribes (
  id            SMALLINT PRIMARY KEY,            -- 0~2
  name          TEXT NOT NULL,
  soul_pool     REAL NOT NULL DEFAULT 0,         -- 죽은 자의 카르마 누적
  total_cells   INTEGER NOT NULL DEFAULT 0,      -- 캐시
  strong_since  BIGINT                            -- 최소세력 된 시점 (약자보정)
);

-- 전역 게임 상태 (서버 tick 등)
CREATE TABLE IF NOT EXISTS game_state (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL
);

-- 데일리 퀘스트 진행 (KST 기준 일일 리셋 — 날짜 행 분리)
CREATE TABLE IF NOT EXISTS player_quests (
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  quest_key     TEXT NOT NULL,
  progress      REAL NOT NULL DEFAULT 0,
  claimed       BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (player_id, day, quest_key)
);
