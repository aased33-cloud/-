CREATE TABLE IF NOT EXISTS employees (
 id bigserial PRIMARY KEY, employee_no text UNIQUE NOT NULL, name text NOT NULL,
 role text NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
 active boolean NOT NULL DEFAULT true, password_hash text,
 reset_allowed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS attendance (
 id bigserial PRIMARY KEY, employee_id bigint NOT NULL REFERENCES employees(id),
 type text NOT NULL CHECK (type IN ('연차','조퇴','외출','병가','출장','공가')),
 start_date date NOT NULL, end_date date NOT NULL, start_time time, end_time time,
 note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS attendance_dates_idx ON attendance(start_date,end_date);
CREATE TABLE IF NOT EXISTS audit_log (
 id bigserial PRIMARY KEY, actor_id bigint NOT NULL REFERENCES employees(id), action text NOT NULL,
 record_id bigint, before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS session (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
CREATE INDEX IF NOT EXISTS session_expire_idx ON session(expire);
-- 앱 서버에서만 접근: Supabase Data API 역할에 기본 권한이 부여되더라도 차단한다.
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE employees, attendance, audit_log, session FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE employees_id_seq, attendance_id_seq, audit_log_id_seq FROM PUBLIC, anon, authenticated;

-- Additive migration: never drops or resets existing employees/attendance/audit data.
CREATE TABLE IF NOT EXISTS monthly_deadlines (
 kind text NOT NULL CHECK(kind IN ('attendance','holiday')),
 month date NOT NULL CHECK(EXTRACT(DAY FROM month)=1),
 start_date date,
 deadline_date date NOT NULL,
 PRIMARY KEY(kind,month)
);
ALTER TABLE monthly_deadlines ADD COLUMN IF NOT EXISTS start_date date;
CREATE TABLE IF NOT EXISTS holiday_dates (
 id bigserial PRIMARY KEY, holiday_date date UNIQUE NOT NULL,
 label text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS holiday_preferences (
 holiday_id bigint NOT NULL REFERENCES holiday_dates(id) ON DELETE CASCADE,
 employee_id bigint NOT NULL REFERENCES employees(id),
 status text NOT NULL CHECK(status IN ('available','unavailable')),
 night_status text NOT NULL CHECK(night_status IN ('allowed','unavailable')),
 note text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(holiday_id,employee_id)
);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS holiday_dates_date_idx ON holiday_dates(holiday_date);
ALTER TABLE monthly_deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE holiday_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE holiday_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE monthly_deadlines,holiday_dates,holiday_preferences FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE holiday_dates_id_seq FROM PUBLIC,anon,authenticated;

-- 신규 기능 스키마는 migration.sql을 참고하세요.

-- 기존 운영 DB용: 삭제/초기화 없이 신규 기능만 추가 (재실행 가능)

CREATE TABLE IF NOT EXISTS monthly_deadlines (
 kind text NOT NULL CHECK (kind IN ('attendance','holiday')),
 month date NOT NULL CHECK (EXTRACT(DAY FROM month)=1),
 start_date date,
 deadline_date date NOT NULL,
 PRIMARY KEY(kind,month)
);
ALTER TABLE monthly_deadlines ADD COLUMN IF NOT EXISTS start_date date;
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


ALTER TABLE holiday_dates ADD COLUMN IF NOT EXISTS auto_saturday boolean NOT NULL DEFAULT false;
ALTER TABLE holiday_dates ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false;

-- 월별 기본 작업장 배치 (서버 전용)
CREATE TABLE IF NOT EXISTS monthly_workplace_assignments (
 month date NOT NULL CHECK (EXTRACT(DAY FROM month)=1),
 employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 workplace text NOT NULL CHECK (workplace IN ('하림','싱그린','정다운','동우','앤에프','중앙축산')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(month,employee_id)
);
ALTER TABLE monthly_workplace_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE monthly_workplace_assignments FROM PUBLIC,anon,authenticated;
CREATE TABLE IF NOT EXISTS attendance_registration_progress (
 month date NOT NULL CHECK (EXTRACT(DAY FROM month)=1),
 employee_id bigint NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 no_attendance boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(month,employee_id)
);
ALTER TABLE attendance_registration_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE attendance_registration_progress FROM PUBLIC,anon,authenticated;
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
