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
