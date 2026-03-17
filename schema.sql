-- ตารางเก็บข้อมูลผู้ใช้
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  password TEXT,
  role TEXT DEFAULT 'user',
  avatar_url TEXT,
  stripe_customer_id TEXT,
  plan TEXT DEFAULT 'free', -- 'free', 'starter', 'pro', 'enterprise', 'system'
  subscription_id TEXT,
  subscription_status TEXT,
  credits_total INTEGER DEFAULT 10, -- Base credits for the plan
  credits_remaining INTEGER DEFAULT 10,
  extra_credits INTEGER DEFAULT 0, -- Purchased top-ups
  last_reset_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ประวัติการทำรายการเงิน
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  stripe_session_id TEXT,
  amount REAL,
  currency TEXT,
  status TEXT, -- 'pending', 'completed', 'failed'
  type TEXT, -- 'subscription', 'topup'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ตารางเก็บข้อมูลการจัดการสิทธิ์เครดิตปรับแต่งได้
CREATE TABLE IF NOT EXISTS user_limits (
  user_id TEXT PRIMARY KEY,
  custom_limit INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ตารางเก็บข้อมูลเอกสาร (เพิ่ม user_id)
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  file_name TEXT,
  storage_path TEXT, 
  status TEXT DEFAULT 'pending', 
  raw_json TEXT, 
  processing_time_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ตารางเก็บข้อมูลที่ AI ดึงออกมาได้
CREATE TABLE IF NOT EXISTS extracted_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT REFERENCES documents(id),
  company_name TEXT,
  tax_id TEXT,
  total_amount REAL,
  invoice_date TEXT
);

-- ตารางเก็บ Template ของผู้ใช้
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT,
  fields_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
