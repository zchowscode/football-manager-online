const express = require('express');
const router = express.Router();
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + (process.env.SECRET_SALT || 'fm_salt_2024')).digest('hex');
}

function generateToken(id) {
  return crypto.createHash('sha256').update(id + Date.now() + (process.env.SECRET_SALT || 'fm_salt_2024')).digest('hex');
}

// REGISTER
router.post('/register', async (req, res) => {
  const { username, password, club_id, server_id } = req.body;
  const pool = req.pool;
  if (!username || !password || !club_id || !server_id)
    return res.status(400).json({ error: 'All fields required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username too short' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
  try {
    const [existing] = await pool.execute('SELECT id FROM managers WHERE username = ?', [username]);
    if (existing.length) return res.status(400).json({ error: 'Username already taken' });
    const [clubTaken] = await pool.execute(
      'SELECT id FROM managers WHERE club_id = ? AND is_ai = false', [club_id]
    );
    if (clubTaken.length) return res.status(400).json({ error: 'Club already taken' });
    const passwordHash = hashPassword(password);
    const token = generateToken(username);
    const [result] = await pool.execute(
      `INSERT INTO managers (username, password_hash, club_id, server_id, is_ai, session_token)
       VALUES (?, ?, ?, ?, false, ?)`,
      [username, passwordHash, club_id, server_id, token]
    );
    const managerId = result.insertId;
    await pool.execute('UPDATE clubs SET manager_id = ?, is_ai = false WHERE id = ?', [managerId, club_id]);
    await pool.execute(
      `INSERT INTO tactics (club_id, formation, pressing, defensive_line, tempo, width, attacking_risk, mentality)
       VALUES (?, '4-3-3', 6, 5, 6, 5, 5, 'balanced')`,
      [club_id]
    );
    res.json({ success: true, token, manager: { id: managerId, username, club_id, server_id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const pool = req.pool;
  if (!username || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const passwordHash = hashPassword(password);
    const [rows] = await pool.execute(
      `SELECT m.*, c.name as club_name, c.league, c.prestige
       FROM managers m
       LEFT JOIN clubs c ON m.club_id = c.id
       WHERE m.username = ? AND m.password_hash = ? AND m.is_ai = false`,
      [username, passwordHash]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid username or password' });
    const token = generateToken(rows[0].id);
    await pool.execute('UPDATE managers SET session_token = ? WHERE id = ?', [token, rows[0].id]);
    const manager = rows[0];
    delete manager.password_hash;
    res.json({ success: true, token, manager });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AUTH MIDDLEWARE
async function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const [rows] = await req.pool.execute(
      `SELECT m.*, c.name as club_name, c.id as club_id, c.league, c.server_id
       FROM managers m LEFT JOIN clubs c ON m.club_id = c.id
       WHERE m.session_token = ? AND m.is_ai = false`,
      [token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid or expired token' });
    req.manager = rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET SERVERS
router.get('/servers', async (req, res) => {
  try {
    const [rows] = await req.pool.execute(
      `SELECT s.*, COUNT(m.id) as human_managers
       FROM servers s LEFT JOIN managers m ON m.server_id = s.id AND m.is_ai = false
       GROUP BY s.id ORDER BY s.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET CLUBS IN SERVER
router.get('/clubs/:server_id', async (req, res) => {
  try {
    const [rows] = await req.pool.execute(
      `SELECT c.*, 
        CASE WHEN m.id IS NOT NULL THEN true ELSE false END as taken,
        m.username as manager_name
       FROM clubs c LEFT JOIN managers m ON c.manager_id = m.id AND m.is_ai = false
       WHERE c.server_id = ? ORDER BY c.prestige DESC`,
      [req.params.server_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, authMiddleware };
