CREATE SCHEMA IF NOT EXISTS audit;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  state TEXT NOT NULL,
  closed_at TIMESTAMPTZ,
  phone TEXT,
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  embedding vector(3),
  location GEOGRAPHY(Point, 4326),
  display_name_key TEXT GENERATED ALWAYS AS (pg_catalog.upper(display_name)) STORED,
  normalized_phone TEXT GENERATED ALWAYS AS (
    regexp_replace(COALESCE(phone, ''::text), E'^\\+46', '+46')
  ) STORED,
  CONSTRAINT accounts_state_requires_closed_at
    CHECK (closed_at IS NOT NULL OR state NOT IN ('ready-to-close', 'closed'))
);

CREATE TABLE public.workouts (
  id SERIAL PRIMARY KEY,
  difficulty TEXT CHECK (difficulty IN ('beginner', 'intermediate', 'advanced'))
);

CREATE TABLE audit.account_events (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL,
  action TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION audit.capture_account_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit.account_events (account_id, action)
  VALUES (COALESCE(NEW.id, OLD.id), TG_OP);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER accounts_change_trigger
AFTER INSERT OR DELETE OR UPDATE ON public.accounts
FOR EACH ROW
EXECUTE FUNCTION audit.capture_account_change();

CREATE VIEW public.active_accounts AS
SELECT accounts.*
FROM public.accounts
WHERE accounts.closed_at IS NULL;

CREATE VIEW audit.account_change_entries AS
SELECT
  accounts.id AS account_id,
  change.value AS entry
FROM public.accounts
CROSS JOIN LATERAL jsonb_array_elements(accounts.changes) AS change(value);

CREATE INDEX accounts_display_name_trgm_idx
ON public.accounts
USING gin (display_name gin_trgm_ops);
