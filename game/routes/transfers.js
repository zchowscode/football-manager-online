const express = require('express');
const router = express.Router();
const { calculatePlayerDecision } = require('../game/poaching');

router.post('/bid', async (req, res) => {
  const { player_id, from_club_id, offered_wage, offered_years, bid_amount } = req.body;
  const pool = req.pool;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const playerResult = await client.query('SELECT * FROM players WHERE id = $1 FOR UPDATE', [player_id]);
    if (!playerResult.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Player not found' }); }
    const player = playerResult.rows[0];
    const existingBid = await client.query(`SELECT id FROM transfer_bids WHERE player_id = $1 AND status = 'pending'`, [player_id]);
    if (existingBid.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Player already has a pending bid' }); }
    const contract = await client.query('SELECT * FROM contracts WHERE player_id = $1 AND active = true', [player_id]);
    if (contract.rows.length && contract.rows[0].no_poach_until_week > (global.currentWeek || 1)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Player recently signed - cannot be poached yet' });
    }
    const bidResult = await client.query(
      `INSERT INTO transfer_bids (player_id, from_club_id, to_club_id, bid_amount, offered_wage, offered_years, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, NOW() + INTERVAL '48 hours') RETURNING *`,
      [player_id, player.club_id, from_club_id, bid_amount, offered_wage, offered_years]
    );
    await client.query('COMMIT');
    const defendingClub = await pool.query('SELECT manager_id FROM clubs WHERE id = $1', [player.club_id]);
    if (defendingClub.rows[0]?.manager_id && req.sendNotification) {
      req.sendNotification(defendingClub.rows[0].manager_id, 'poach_attempt',
        `Someone is trying to poach ${player.name}! You have 48 hours to respond.`,
        { player_id, bid_id: bidResult.rows[0].id, offered_wage, bid_amount }
      );
    }
    res.json({ success: true, bid: bidResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

router.post('/loyalty-token/:bid_id', async (req, res) => {
  try {
    await req.pool.query('UPDATE transfer_bids SET loyalty_token_used = true WHERE id = $1', [req.params.bid_id]);
    res.json({ success: true, message: 'Loyalty token used - player much more likely to stay' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/market', async (req, res) => {
  const { position, league, search } = req.query;
  try {
    let query = `SELECT p.*, c.weekly_wage, c.expires_at_week, cl.name as club_name, cl.league
      FROM players p JOIN contracts c ON p.id = c.player_id AND c.active = true
      JOIN clubs cl ON p.club_id = cl.id WHERE 1=1`;
    const params = [];
    if (position) { params.push(position); query += ` AND p.position = $${params.length}`; }
    if (league) { params.push(league); query += ` AND cl.league = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND p.name ILIKE $${params.length}`; }
    query += ' ORDER BY p.overall_rating DESC LIMIT 100';
    const result = await req.pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
