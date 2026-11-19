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
