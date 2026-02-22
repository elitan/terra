CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL
  CREATE INDEX idx_users_email ON users (email);
);
