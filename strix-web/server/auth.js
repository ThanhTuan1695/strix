import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getDB } from './db.js';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_EXPIRY = '7d';

function col() {
  const db = getDB();
  return db ? db.collection('users') : null;
}

export async function initUsers() {
  const c = col();
  if (!c) return;
  await c.createIndex({ username: 1 }, { unique: true });
  const count = await c.countDocuments();
  if (count === 0) {
    const hash = await bcrypt.hash('admin', 10);
    await c.insertOne({ username: 'admin', password: hash, role: 'admin', createdAt: new Date().toISOString() });
    console.log('Default admin user created (admin/admin)');
  }
}

export function authMiddleware(req, res, next) {
  if (req.path === '/api/auth/login') return next();
  if (!req.path.startsWith('/api')) return next();

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

export function authRoutes(app) {
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const c = col();
    if (!c) return res.status(503).json({ error: 'Database not available' });

    const user = await c.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    res.json({ token, user: { username: user.username, role: user.role } });
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ username: req.user.username, role: req.user.role });
  });

  app.get('/api/auth/users', adminOnly, async (req, res) => {
    const c = col();
    if (!c) return res.json([]);
    const users = await c.find({}, { projection: { password: 0, _id: 0 } }).toArray();
    res.json(users);
  });

  app.post('/api/auth/users', adminOnly, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (role && !['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be admin or user' });

    const c = col();
    if (!c) return res.status(503).json({ error: 'Database not available' });

    const exists = await c.findOne({ username });
    if (exists) return res.status(409).json({ error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    await c.insertOne({ username, password: hash, role: role || 'user', createdAt: new Date().toISOString() });
    res.json({ success: true, user: { username, role: role || 'user' } });
  });

  app.put('/api/auth/users/:username', adminOnly, async (req, res) => {
    const { password, role } = req.body;
    const c = col();
    if (!c) return res.status(503).json({ error: 'Database not available' });

    const update = {};
    if (password) update.password = await bcrypt.hash(password, 10);
    if (role && ['admin', 'user'].includes(role)) update.role = role;
    if (!Object.keys(update).length) return res.status(400).json({ error: 'Nothing to update' });

    const result = await c.updateOne({ username: req.params.username }, { $set: update });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  });

  app.delete('/api/auth/users/:username', adminOnly, async (req, res) => {
    if (req.params.username === req.user.username) return res.status(400).json({ error: 'Cannot delete yourself' });
    const c = col();
    if (!c) return res.status(503).json({ error: 'Database not available' });

    const result = await c.deleteOne({ username: req.params.username });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  });

  app.post('/api/auth/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });

    const c = col();
    if (!c) return res.status(503).json({ error: 'Database not available' });

    const user = await c.findOne({ username: req.user.username });
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await c.updateOne({ username: req.user.username }, { $set: { password: hash } });
    res.json({ success: true });
  });
}
