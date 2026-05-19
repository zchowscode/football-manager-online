const express = require('express');
const router = express.Router();

// ---- AUTH MIDDLEWARE ----
function auth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  next();
}

// ---- CLOCK ----
router.get('/clock', async (req, res) => {
  try {
    const [rows] = await req.pool.query('SELECT * FROM game_clock ORDER BY id DESC LIMIT 1');
    res.json(rows[0] || { current_season: 1, current_week: 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- SQUAD ----
router.get('/squad/:club_id', auth, async (req, res) => {
  try {
    const [rows] = await req.pool.query(`
      SELECT p.*, c.weekly_wage, c.expires_at_week, c.team_type
      FROM players p
      LEFT JOIN contracts c ON c.player_id = p.id AND c.club_id = ? AND c.active = 1
      WHERE c.club_id = ?
      ORDER BY p.overall_rating DESC
    `, [req.params.club_id, req.params.club_id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/squad/promote/:id', auth, async (req, res) => {
  try {
    await req.pool.query(`UPDATE contracts SET team_type = 'first' WHERE player_id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- LEAGUE TABLE ----
router.get('/table/:server_id', async (req, res) => {
  try {
    const [rows] = await req.pool.query(`
      SELECT lt.*, cl.name AS club_name
      FROM league_table lt
      JOIN clubs cl ON cl.id = lt.club_id
      WHERE lt.server_id = ?
      ORDER BY lt.points DESC, lt.goal_difference DESC, lt.goals_for DESC
    `, [req.params.server_id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- TRANSFER MARKET ----
router.get('/transfers/market', async (req, res) => {
  try {
    const [rows] = await req.pool.query(`
      SELECT p.*, cl.name AS club_name, cl.league
      FROM players p
      LEFT JOIN contracts c ON c.player_id = p.id AND c.active = 1
      LEFT JOIN clubs cl ON cl.id = c.club_id
      ORDER BY p.overall_rating DESC
      LIMIT 500
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/transfers/bid', auth, async (req, res) => {
  const { player_id, from_club_id, offered_wage, offered_years, bid_amount } = req.body;
  if (!player_id || !from_club_id || !offered_wage || !offered_years) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const [clock] = await req.pool.query('SELECT * FROM game_clock ORDER BY id DESC LIMIT 1');
    const week = clock[0]?.current_week || 1;
    await req.pool.query(`
      INSERT INTO transfer_bids (player_id, from_club_id, offered_wage, offered_years, bid_amount, status, submitted_at_week)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `, [player_id, from_club_id, offered_wage, offered_years, bid_amount || 0, week]);

    // notify the player's current club manager
    const [contracts] = await req.pool.query(`
      SELECT c.club_id, m.id AS manager_id, p.name AS player_name, cl.name AS from_club_name
      FROM contracts c
      JOIN players p ON p.id = c.player_id
      JOIN clubs cl ON cl.id = ?
      LEFT JOIN managers m ON m.club_id = c.club_id
      WHERE c.player_id = ? AND c.active = 1
    `, [from_club_id, player_id]);

    if (contracts.length && contracts[0].manager_id) {
      await req.pool.query(`
        INSERT INTO notifications (manager_id, type, message)
        VALUES (?, 'poach_attempt', ?)
      `, [contracts[0].manager_id, `${contracts[0].from_club_name} have bid for your player ${contracts[0].player_name}`]);
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- NOTIFICATIONS ----
router.get('/notifications/:manager_id', auth, async (req, res) => {
  try {
    const [rows] = await req.pool.query(`
      SELECT * FROM notifications
      WHERE manager_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.params.manager_id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/notifications/:id/read', auth, async (req, res) => {
  try {
    await req.pool.query('UPDATE notifications SET `read` = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/notifications/:manager_id/read-all', auth, async (req, res) => {
  try {
    await req.pool.query('UPDATE notifications SET `read` = 1 WHERE manager_id = ?', [req.params.manager_id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- PRESS ROOM ----
router.get('/press/:server_id', async (req, res) => {
  try {
    const [rows] = await req.pool.query(`
      SELECT pc.*, m.username, cl.name AS club_name
      FROM press_conferences pc
      JOIN managers m ON m.id = pc.manager_id
      JOIN clubs cl ON cl.id = pc.club_id
      WHERE pc.server_id = ?
      ORDER BY pc.created_at DESC
      LIMIT 30
    `, [req.params.server_id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/press', auth, async (req, res) => {
  const { server_id, club_id, template_text, custom_text } = req.body;
  if (!server_id || !club_id || !template_text) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    const [mgr] = await req.pool.query('SELECT id FROM managers WHERE club_id = ?', [club_id]);
    const manager_id = mgr[0]?.id;
    if (!manager_id) return res.status(400).json({ error: 'Manager not found' });

    await req.pool.query(`
      INSERT INTO press_conferences (manager_id, server_id, club_id, template_text, custom_text)
      VALUES (?, ?, ?, ?, ?)
    `, [manager_id, server_id, club_id, template_text, custom_text || null]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- TACTICS ----
router.post('/tactics', auth, async (req, res) => {
  const { club_id, formation, pressing, defensive_line, tempo, width, attacking_risk, mentality } = req.body;
  if (!club_id) return res.status(400).json({ error: 'Missing club_id' });
  try {
    await req.pool.query(`
      INSERT INTO tactics (club_id, formation, pressing, defensive_line, tempo, width, attacking_risk, mentality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        formation=VALUES(formation), pressing=VALUES(pressing), defensive_line=VALUES(defensive_line),
        tempo=VALUES(tempo), width=VALUES(width), attacking_risk=VALUES(attacking_risk), mentality=VALUES(mentality)
    `, [club_id, formation, pressing, defensive_line, tempo, width, attacking_risk, mentality]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
