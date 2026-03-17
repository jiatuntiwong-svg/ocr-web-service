-- Migration: add missing columns and seed initial admin user
ALTER TABLE users ADD COLUMN password TEXT;
ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';
INSERT OR IGNORE INTO users (id, name, email, password, role, plan) VALUES ('admin-prod-1', 'Admin', 'admin@ocrpro.com', 'admin1234', 'admin', 'system');
INSERT OR IGNORE INTO users (id, name, email, password, role, plan) VALUES ('user-free-1', 'Free User', 'free@ocrpro.com', 'free1234', 'user', 'free');
