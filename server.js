const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'notary_secret_key';

const upload = multer({ dest: 'uploads/' });

if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const db = new Database('./data/notary.db');

// --- 数据库结构初始化 ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_code TEXT UNIQUE,
    register_date TEXT,
    name TEXT,
    phone TEXT,
    contact_status TEXT DEFAULT '未联系',
    process_status TEXT DEFAULT '待办',
    appointment_date TEXT,
    appointment_time TEXT,
    item_type TEXT,
    family_info TEXT,
    reminder_dismissed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS registry_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registry_id INTEGER,
    creator_name TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS dictionaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT DEFAULT 'item_type',
    name TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS push_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    sender_name TEXT,
    receiver_id INTEGER,
    registry_id INTEGER,
    message TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 自动平滑迁移：检测并为旧 registry 表补全 user_id 列（若不存在）
try {
  db.prepare('ALTER TABLE registry ADD COLUMN user_id INTEGER').run();
} catch (e) {
  // 字段已存在时会触发异常，直接忽略即可
}

// 初始化管理员账号 (admin / admin123)
const adminExists = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
let adminId = adminExists ? adminExists.id : null;
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  const info = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hash, 'super_admin');
  adminId = info.lastInsertRowid;
}

// 给旧数据补充 user_id (若为 null 则归属给管理员)
db.prepare('UPDATE registry SET user_id = ? WHERE user_id IS NULL').run(adminId);

// 初始化默认事项
const defaultItems = ['继承公证', '遗嘱公证', '房产委托', '亲属关系', '声明书'];
defaultItems.forEach(item => {
  db.prepare('INSERT OR IGNORE INTO dictionaries (type, name) VALUES (\'item_type\', ?)').run(item);
});

app.use(express.json());
app.use(express.static('public'));

// Token 校验中间件
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  if (!token && req.query.token) token = req.query.token;

  if (!token) return res.status(401).json({ error: '未登录' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '登录失效' });
    req.user = user;
    next();
  });
};

// --- 1. 用户 & 超级管理员权限扩展 ---

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// 获取所有用户列表
app.get('/api/users', authenticateToken, (req, res) => {
  if (req.query.for_push === 'true') {
    return res.json(db.prepare('SELECT id, username FROM users WHERE id != ?').all(req.user.id));
  }
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '无权限' });
  res.json(db.prepare('SELECT id, username, role, created_at FROM users').all());
});

// 创建用户
app.post('/api/users', authenticateToken, (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '无权限' });
  const { username, password, role } = req.body;
  try {
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, bcrypt.hashSync(password, 10), role || 'user');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '用户名已存在' });
  }
});

// 修改指定用户的用户名和密码（超级管理员专属）
app.put('/api/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '无权限' });
  const { username, password } = req.body;
  const targetId = req.params.id;

  try {
    if (username) {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, targetId);
    }
    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, targetId);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '修改失败，用户名可能已重复' });
  }
});

// 删除账号并自动将该账户下所有数据流转至超级管理员账户
app.delete('/api/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '无权限' });
  const deleteUserId = parseInt(req.params.id);

  if (deleteUserId === req.user.id) {
    return res.status(400).json({ error: '不能删除当前的超级管理员账号' });
  }

  const transferAndDelete = db.transaction(() => {
    db.prepare('UPDATE registry SET user_id = ? WHERE user_id = ?').run(req.user.id, deleteUserId);
    db.prepare('DELETE FROM users WHERE id = ?').run(deleteUserId);
  });

  try {
    transferAndDelete();
    res.json({ success: true, message: '账号已删除，原账号数据已全量转移至您的名下' });
  } catch (e) {
    res.status(500).json({ error: '操作失败' });
  }
});

// --- 2. 事项字典管理 (增/删/改) ---

app.get('/api/dictionaries', authenticateToken, (req, res) => {
  res.json(db.prepare('SELECT * FROM dictionaries WHERE type = \'item_type\'').all());
});

app.post('/api/dictionaries', authenticateToken, (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '无权限' });
  try {
    db.prepare('INSERT INTO dictionaries (type, name) VALUES (\'item_type\', ?)').run(req.body.name);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '事项名称已存在' });
  }
});

app.put('/api/dictionaries/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '无权限' });
  const { name } = req.body;
  try {
    db.prepare('UPDATE dictionaries SET name = ? WHERE id = ? AND type = \'item_type\'').run(name, req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '修改失败，名称重复' });
  }
});

app.delete('/api/dictionaries/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '无权限' });
  db.prepare('DELETE FROM dictionaries WHERE id = ? AND type = \'item_type\'').run(req.params.id);
  res.json({ success: true });
});

// --- 3. 登记簿数据完整 CRUD 与权限管理 ---

app.get('/api/registry', authenticateToken, (req, res) => {
  const { search, contact_status, process_status } = req.query;
  
  let query = req.user.role === 'super_admin' 
    ? 'SELECT * FROM registry WHERE 1=1' 
    : 'SELECT * FROM registry WHERE user_id = ?';
  let params = req.user.role === 'super_admin' ? [] : [req.user.id];

  if (search) {
    query += ' AND (name LIKE ? OR phone LIKE ? OR item_type LIKE ? OR family_info LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (contact_status) { query += ' AND contact_status = ?'; params.push(contact_status); }
  if (process_status) { query += ' AND process_status = ?'; params.push(process_status); }

  query += ' ORDER BY id DESC';
  const rows = db.prepare(query).all(...params);

  const result = rows.map(row => ({
    ...row,
    notes_list: db.prepare('SELECT * FROM registry_notes WHERE registry_id = ? ORDER BY id ASC').all(row.id)
  }));

  res.json(result);
});

app.post('/api/registry', authenticateToken, (req, res) => {
  const { register_date, name, phone, contact_status, appointment_date, appointment_time, item_type, family_info, remark } = req.body;
  const datePrefix = (register_date || new Date().toISOString().split('T')[0]).replace(/-/g, '');
  const count = db.prepare('SELECT COUNT(*) as total FROM registry').get().total + 1;
  const entry_code = `NO${datePrefix}${String(count).padStart(4, '0')}`;

  const info = db.prepare(`
    INSERT INTO registry (user_id, entry_code, register_date, name, phone, contact_status, appointment_date, appointment_time, item_type, family_info)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, entry_code, register_date, name, phone, contact_status || '未联系', appointment_date, appointment_time, item_type, family_info);

  if (remark) {
    db.prepare('INSERT INTO registry_notes (registry_id, creator_name, content) VALUES (?, ?, ?)').run(info.lastInsertRowid, req.user.username, remark);
  }

  res.json({ success: true, entry_code });
});

app.put('/api/registry/:id', authenticateToken, (req, res) => {
  const id = req.params.id;
  const record = db.prepare('SELECT * FROM registry WHERE id = ?').get(id);

  if (!record) return res.status(404).json({ error: '数据不存在' });
  if (req.user.role !== 'super_admin' && record.user_id !== req.user.id) {
    return res.status(403).json({ error: '无权修改此数据' });
  }

  const { register_date, name, phone, contact_status, process_status, appointment_date, appointment_time, item_type, family_info } = req.body;

  db.prepare(`
    UPDATE registry SET 
      register_date = ?, name = ?, phone = ?, contact_status = ?, process_status = ?, 
      appointment_date = ?, appointment_time = ?, item_type = ?, family_info = ?
    WHERE id = ?
  `).run(register_date, name, phone, contact_status, process_status, appointment_date, appointment_time, item_type, family_info, id);

  res.json({ success: true });
});

app.patch('/api/registry/:id', authenticateToken, (req, res) => {
  const { contact_status, process_status, new_remark } = req.body;
  const id = req.params.id;

  if (contact_status) db.prepare('UPDATE registry SET contact_status = ? WHERE id = ?').run(contact_status, id);
  if (process_status) db.prepare('UPDATE registry SET process_status = ? WHERE id = ?').run(process_status, id);
  if (new_remark) db.prepare('INSERT INTO registry_notes (registry_id, creator_name, content) VALUES (?, ?, ?)').run(id, req.user.username, new_remark);

  res.json({ success: true });
});

app.delete('/api/registry/:id', authenticateToken, (req, res) => {
  const id = req.params.id;
  const record = db.prepare('SELECT * FROM registry WHERE id = ?').get(id);

  if (!record) return res.status(404).json({ error: '数据不存在' });
  if (req.user.role !== 'super_admin' && record.user_id !== req.user.id) {
    return res.status(403).json({ error: '无权删除此数据' });
  }

  db.prepare('DELETE FROM registry WHERE id = ?').run(id);
  db.prepare('DELETE FROM registry_notes WHERE registry_id = ?').run(id);
  res.json({ success: true });
});

// --- 4. 数据推送功能与收件箱通知 ---

app.post('/api/registry/push', authenticateToken, (req, res) => {
  const { registry_id, target_user_id, message } = req.body;

  const record = db.prepare('SELECT * FROM registry WHERE id = ?').get(registry_id);
  if (!record) return res.status(404).json({ error: '数据不存在' });

  db.prepare('UPDATE registry SET user_id = ? WHERE id = ?').run(target_user_id, registry_id);

  db.prepare(`
    INSERT INTO push_notifications (sender_id, sender_name, receiver_id, registry_id, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, req.user.username, target_user_id, registry_id, message || `用户 ${req.user.username} 向您推送了一条登记数据：${record.name}（${record.entry_code}）`);

  res.json({ success: true, message: '数据推送成功！' });
});

app.get('/api/notifications', authenticateToken, (req, res) => {
  const notifications = db.prepare(`
    SELECT n.*, r.name as record_name, r.entry_code 
    FROM push_notifications n
    LEFT JOIN registry r ON n.registry_id = r.id
    WHERE n.receiver_id = ? 
    ORDER BY n.id DESC
  `).all(req.user.id);

  const unreadCount = db.prepare('SELECT COUNT(*) as count FROM push_notifications WHERE receiver_id = ? AND is_read = 0').get(req.user.id).count;

  res.json({ notifications, unreadCount });
});

app.post('/api/notifications/read/:id', authenticateToken, (req, res) => {
  db.prepare('UPDATE push_notifications SET is_read = 1 WHERE id = ? AND receiver_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// --- 其他原有 API ---
app.get('/api/schedule', authenticateToken, (req, res) => {
  const queryDate = req.query.date || new Date().toISOString().split('T')[0];
  res.json(db.prepare('SELECT * FROM registry WHERE appointment_date = ? ORDER BY appointment_time ASC').all(queryDate));
});

app.get('/api/reminders', authenticateToken, (req, res) => {
  const rows = db.prepare(`
    SELECT *, JULIANDAY('now') - JULIANDAY(register_date) as elapsed_days
    FROM registry
    WHERE contact_status = '未联系' AND reminder_dismissed = 0 AND (JULIANDAY('now') - JULIANDAY(register_date)) >= 70
  `).all();
  res.json(rows.map(r => ({ ...r, elapsed_days: Math.floor(r.elapsed_days) })));
});

app.post('/api/reminders/dismiss/:id', authenticateToken, (req, res) => {
  db.prepare('UPDATE registry SET reminder_dismissed = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/export/excel', authenticateToken, (req, res) => {
  const query = req.user.role === 'super_admin' ? 'SELECT * FROM registry ORDER BY id DESC' : 'SELECT * FROM registry WHERE user_id = ? ORDER BY id DESC';
  const params = req.user.role === 'super_admin' ? [] : [req.user.id];
  const rows = db.prepare(query).all(...params);
  
  let csvContent = '\uFEFF数据编号,登记日期,姓名,联系电话,联系状态,办理状态,预约日期,预约时间,办理事项,家庭情况\n';
  rows.forEach(r => {
    csvContent += `"${r.entry_code || ''}","${r.register_date || ''}","${r.name || ''}","${r.phone || ''}","${r.contact_status || ''}","${r.process_status || ''}","${r.appointment_date || ''}","${r.appointment_time || ''}","${r.item_type || ''}","${(r.family_info || '').replace(/"/g, '""')}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=' + encodeURIComponent('公证登记簿数据.csv'));
  res.send(csvContent);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));