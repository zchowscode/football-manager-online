const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Simple hash function - in production use bcrypt
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + process.env.SECRET_SALT || 'fm_salt_2024').digest('hex');
}

function generateToken(managerId) {
  return crypto.createHash('sha256').update(managerId + Date.now() + (process.env.SECRET_SALT || 'fm_salt_2024')).digest('hex');
}

// REGISTER
router.post('/register', async (req, res) => {
  const { username, password, club_id, server_id } = req.body;
  const pool = req.pool;

  if (!username || !password || !club_id || !server_id) {
    return res.status(400).json({ error: 'All fields required' });
  }
  if (username.length < 3) return res.status(400).json({ error: 'Username too short' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });

  try {
    // Check username taken
    const existing = await pool.query('SELECT id FROM managers WHERE username = $1', [username]);
    if (existing.rows.length) return res.status(400).json({ error: 'Username already taken' });

    // Check club not already taken
    const clubTaken = await pool.query(
      'SELECT id FROM managers WHERE club_id = $1 AND is_ai = false', [club_id]
    );
    if (clubTaken.rows.length) return res.status(400).json({ error: 'Club already taken by another manager' });

    const passwordHash = hashPassword(password);
    const token = generateToken(username);

    // Create manager
    const result = await pool.query(
      `INSERT INTO managers (username, password_hash, club_id, server_id, is_ai, session_token)
       VALUES ($1, $2, $3, $4, false, $5) RETURNING id, username, club_id, server_id`,
      [username, passwordHash, club_id, server_id, token]
    );

    // Assign club to this manager
    await pool.query('UPDATE clubs SET manager_id = $1, is_ai = false WHERE id = $2', [result.rows[0].id, club_id]);

    // Create default tactics for new manager
    await pool.query(
      `INSERT INTO tactics (club_id, formation, pressing, defensive_line, tempo, width, attacking_risk, mentality)
       VALUES ($1, '4-3-3', 6, 5, 6, 5, 5, 'balanced')
       ON CONFLICT (club_id) DO NOTHING`,
      [club_id]
    );

    res.json({ success: true, token, manager: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const pool = req.pool;

  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const passwordHash = hashPassword(password);
    const result = await pool.query(
      `SELECT m.*, c.name as club_name, c.league, c.prestige, c.badge_url
       FROM managers m
       LEFT JOIN clubs c ON m.club_id = c.id
       WHERE m.username = $1 AND m.password_hash = $2 AND m.is_ai = false`,
      [username, passwordHash]
    );

    if (!result.rows.length) return res.status(401).json({ error: 'Invalid username or password' });

    const token = generateToken(result.rows[0].id);
    await pool.query('UPDATE managers SET session_token = $1 WHERE id = $2', [token, result.rows[0].id]);

    const manager = result.rows[0];
    delete manager.password_hash;

    res.json({ success: true, token, manager });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MIDDLEWARE - verify token on protected routes
async function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const result = await req.pool.query(
      `SELECT m.*, c.name as club_name, c.id as club_id, c.league, c.server_id
       FROM managers m
       LEFT JOIN clubs c ON m.club_id = c.id
       WHERE m.session_token = $1 AND m.is_ai = false`,
      [token]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid or expired token' });
    req.manager = result.rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET AVAILABLE SERVERS
router.get('/servers', async (req, res) => {
  try {
    const result = await req.pool.query(
      `SELECT s.*, 
        COUNT(m.id) FILTER (WHERE m.is_ai = false) as human_managers,
        s.max_managers
       FROM servers s
       LEFT JOIN managers m ON m.server_id = s.id
       GROUP BY s.id
       ORDER BY s.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET AVAILABLE CLUBS IN A SERVER
router.get('/clubs/:server_id', async (req, res) => {
  try {
    const result = await req.pool.query(
      `SELECT c.*, 
        CASE WHEN m.id IS NOT NULL THEN true ELSE false END as taken,
        m.username as manager_name
       FROM clubs c
       LEFT JOIN managers m ON c.manager_id = m.id AND m.is_ai = false
       WHERE c.server_id = $1
       ORDER BY c.prestige DESC`,
      [req.params.server_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, authMiddleware };
