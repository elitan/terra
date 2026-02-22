CREATE TABLE bad_table (
  id SERIAL PRIMARY KEY,
  name TEXT DEFAULT 'unterminated
);
