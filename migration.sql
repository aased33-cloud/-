-- 기존 운영 DB용: 삭제/초기화 없이 신규 기능만 추가 (재실행 가능)
BEGIN;
CREATE TABLE IF NOT EXISTS monthly_deadlines (
 kind text NOT NULL CHECK (kind IN ('attendance','holiday')),
 month date NOT NULL CHECK (EXTRACT(DAY FROM month)=1),
 start_date date,
 deadline_date date NOT NULL,
 PRIMARY KEY(kind,month)
);
ALTER TABLE monthly_deadlines ADD COLUMN IF NOT EXISTS start_date date;
-- 기존 마감일은 시작일이 미지정 상태이므로 직원 입력을 잠급니다.
ALTER TABLE monthly_deadlines DROP CONSTRAINT IF EXISTS monthly_deadlines_period_check;
ALTER TABLE monthly_deadlines ADD CONSTRAINT monthly_deadlines_period_check CHECK (start_date IS NULL OR start_date <= deadline_date);
CREATE TABLE IF NOT EXISTS holiday_dates (
 id bigserial PRIMARY KEY,
 holiday_date date NOT NULL UNIQUE,
 label text NOT NULL DEFAULT '' CHECK(length(label)<=80)
);
CREATE TABLE IF NOT EXISTS holiday_preferences (
 holiday_id bigint NOT NULL REFERENCES holiday_dates(id) ON DELETE RESTRICT,
 employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 status text NOT NULL CHECK(status IN ('available','unavailable')),
 night_status text NOT NULL CHECK(night_status IN ('allowed','unavailable')),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=300),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(holiday_id,employee_id)
);
CREATE INDEX IF NOT EXISTS audit_log_created_id_idx ON audit_log(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_created_idx ON audit_log(actor_id,created_at DESC);
CREATE INDEX IF NOT EXISTS holiday_dates_date_idx ON holiday_dates(holiday_date);
ALTER TABLE monthly_deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE holiday_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE holiday_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE monthly_deadlines,holiday_dates,holiday_preferences FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE holiday_dates_id_seq FROM PUBLIC,anon,authenticated;
COMMIT;

-- 토요일 자동 생성 및 휴일 제외: 기존 직원·휴일근무 기록은 그대로 보존합니다.
ALTER TABLE holiday_dates ADD COLUMN IF NOT EXISTS auto_saturday boolean NOT NULL DEFAULT false;
ALTER TABLE holiday_dates ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false;

-- 월별 기본 작업장 배치: 기존 직원·근태 데이터는 변경하지 않습니다.
BEGIN;
CREATE TABLE IF NOT EXISTS monthly_workplace_assignments (
 month date NOT NULL CHECK (EXTRACT(DAY FROM month)=1),
 employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 workplace text NOT NULL CHECK (workplace IN ('하림','싱그린','정다운','동우','앤에프','중앙축산')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(month,employee_id)
);
ALTER TABLE monthly_workplace_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE monthly_workplace_assignments FROM PUBLIC,anon,authenticated;
COMMIT;

-- 직원의 근태 일정 없음 확인을 월별로 보관합니다.
BEGIN;
CREATE TABLE IF NOT EXISTS attendance_registration_progress (
 month date NOT NULL CHECK (EXTRACT(DAY FROM month)=1),
 employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 no_attendance boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(month,employee_id)
);
ALTER TABLE attendance_registration_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE attendance_registration_progress FROM PUBLIC,anon,authenticated;
COMMIT;

-- 야간 배제 설정과 작업장별 주간 선택. 월 경계를 넘는 주는 시작일로 공유합니다.
BEGIN;
CREATE TABLE IF NOT EXISTS employee_night_exclusions (
 employee_id bigint PRIMARY KEY REFERENCES employees(id) ON DELETE RESTRICT,
 blocked boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS night_unavailable_weeks (
 employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 workplace text NOT NULL CHECK(workplace IN ('하림','동우')),
 week_start date NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(employee_id,workplace,week_start)
);
ALTER TABLE attendance_registration_progress ADD COLUMN IF NOT EXISTS night_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE employee_night_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE night_unavailable_weeks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE employee_night_exclusions,night_unavailable_weeks FROM PUBLIC,anon,authenticated;
COMMIT;

-- 주별 조출·후출·야간의 기본 담당자와 관리자 제한
BEGIN;
CREATE TABLE IF NOT EXISTS employee_shift_restrictions (
 employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 restriction text NOT NULL CHECK(restriction IN ('하림조출','동우후출')),
 PRIMARY KEY(employee_id,restriction)
);
CREATE TABLE IF NOT EXISTS weekly_shift_assignments (
 workplace text NOT NULL CHECK(workplace IN ('하림','동우','싱그린')),
 shift text NOT NULL CHECK(shift IN ('조출','후출','야간')),
 week_start date NOT NULL,
 slot smallint NOT NULL CHECK(slot IN (1,2)),
 employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workplace,shift,week_start,slot),
 UNIQUE(workplace,shift,week_start,employee_id)
);
ALTER TABLE employee_shift_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_shift_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE employee_shift_restrictions,weekly_shift_assignments FROM PUBLIC,anon,authenticated;
COMMIT;

-- 주별 담당을 유지하면서 특정 날짜만 대체합니다.
BEGIN;
CREATE TABLE IF NOT EXISTS weekly_shift_overrides (
 workplace text NOT NULL,
 shift text NOT NULL,
 week_start date NOT NULL,
 slot smallint NOT NULL,
 work_date date NOT NULL,
 employee_id bigint REFERENCES employees(id) ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workplace,shift,week_start,slot,work_date),
 FOREIGN KEY(workplace,shift,week_start,slot) REFERENCES weekly_shift_assignments(workplace,shift,week_start,slot) ON DELETE RESTRICT
);
ALTER TABLE weekly_shift_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE weekly_shift_overrides FROM PUBLIC,anon,authenticated;
COMMIT;

-- 월별 타 사무소 지원자와 휴일 배치 (기존 근태·직원 데이터는 유지)
BEGIN;
CREATE TABLE IF NOT EXISTS holiday_external_people (
 id bigserial PRIMARY KEY, month date NOT NULL CHECK(EXTRACT(DAY FROM month)=1),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS holiday_external_availability (
 external_id bigint NOT NULL REFERENCES holiday_external_people(id) ON DELETE RESTRICT,
 work_date date NOT NULL, available boolean NOT NULL,
 PRIMARY KEY(external_id,work_date)
);
CREATE TABLE IF NOT EXISTS holiday_plan_settings (
 month date PRIMARY KEY CHECK(EXTRACT(DAY FROM month)=1), external_target integer NOT NULL DEFAULT 0 CHECK(external_target BETWEEN 0 AND 100)
);
CREATE TABLE IF NOT EXISTS holiday_plan_requirements (
 work_date date NOT NULL, workplace text NOT NULL CHECK(workplace IN ('하림','싱그린','정다운','동우','앤에프','중앙축산')),
 shift text NOT NULL CHECK(shift IN ('조출','주간','후출','야간')), required integer NOT NULL CHECK(required BETWEEN 0 AND 30),
 PRIMARY KEY(work_date,workplace,shift)
);
CREATE TABLE IF NOT EXISTS holiday_plan_assignments (
 work_date date NOT NULL, workplace text NOT NULL CHECK(workplace IN ('하림','싱그린','정다운','동우','앤에프','중앙축산')), shift text NOT NULL CHECK(shift IN ('조출','주간','후출','야간')), slot integer NOT NULL CHECK(slot BETWEEN 1 AND 30),
 employee_id bigint REFERENCES employees(id) ON DELETE RESTRICT,
 external_id bigint REFERENCES holiday_external_people(id) ON DELETE RESTRICT,
 locked boolean NOT NULL DEFAULT false,
 CHECK((employee_id IS NOT NULL)::int+(external_id IS NOT NULL)::int=1), CHECK(external_id IS NULL OR (workplace='하림' AND shift='주간' AND slot>1)),
 PRIMARY KEY(work_date,workplace,shift,slot), UNIQUE(work_date,employee_id), UNIQUE(work_date,external_id)
);
ALTER TABLE holiday_external_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE holiday_external_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE holiday_plan_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE holiday_plan_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE holiday_plan_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE holiday_external_people,holiday_external_availability,holiday_plan_settings,holiday_plan_requirements,holiday_plan_assignments FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE holiday_external_people_id_seq FROM PUBLIC,anon,authenticated;
COMMIT;

-- 동우 금요일 야간 특별 시간: 주별 담당 칸에 연결한다.
BEGIN;
CREATE TABLE IF NOT EXISTS dongwoo_friday_time (
 week_start date PRIMARY KEY, slot smallint NOT NULL CHECK(slot IN (1,2)), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dongwoo_friday_time ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dongwoo_friday_time FROM PUBLIC,anon,authenticated;
COMMIT;

-- 날짜별 타 작업장 지원 (기본 배치를 변경하지 않음)
BEGIN;
CREATE TABLE IF NOT EXISTS daily_workplace_support (
 work_date date NOT NULL, employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 workplace text NOT NULL CHECK(workplace IN ('하림','싱그린','정다운','동우','앤에프','중앙축산')),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(work_date,employee_id)
);
ALTER TABLE daily_workplace_support ADD COLUMN IF NOT EXISTS shift text;
ALTER TABLE daily_workplace_support ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE daily_workplace_support FROM PUBLIC,anon,authenticated;
COMMIT;
