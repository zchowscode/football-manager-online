const express = require('express');
const router = express.Router();
const { calculatePlayerDecision } = require('../game/poaching');

// POST A BID
router.post('/bid', async (req, res) => {
  const { player_id, from_club_id, offered_wage, offered_years, bid_amount } = req.body;
  const pool = req.pool;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[player]] = await conn.execute(
      'SELECT * FROM players WHERE id = ? FOR UPDATE', [player_id]
    );
    if (!player) {
      await conn.rollback();
      return res.status(404).json({ error: 'Player not found' });
    }

    // Check minimum transfer fee
    const playerValue = Math.round((player.overall_rating || 60) * 900000);
    const minFee = Math.round(playerValue * 0.8);
    if (bid_amount < minFee) {
      await conn.rollback();
      return res.status(400).json({
        error: `Bid too low. ${player.name} is valued at £${playerValue.toLocaleString()}. Minimum bid is £${minFee.toLocaleString()}.`
      });
    }

    const [existingBid] = await conn.execute(
      "SELECT id FROM transfer_bids WHERE player_id = ? AND status = 'pending'", [player_id]
    );
    if (existingBid.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'Player already has a pending bid' });
    }

    const [[contract]] = await conn.execute(
      'SELECT * FROM contracts WHERE player_id = ? AND active = true', [player_id]
    );
    if (contract && contract.no_poach_until_week > (global.currentWeek || 1)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Player recently signed - cannot be poached yet' });
    }

    // Free agents don't need a transfer fee
    if (!contract && bid_amount > 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'This player is a free agent — no transfer fee needed. Set fee to 0.' });
    }

    const [result] = await conn.execute(
      `INSERT INTO transfer_bids 
        (player_id, from_club_id, to_club_id, bid_amount, offered_wage, offered_years, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 48 HOUR))`,
      [player_id, contract ? contract.club_id : null, from_club_id, bid_amount, offered_wage, offered_years]
    );

    await conn.commit();

    if (contract) {
      const [[defendingClub]] = await pool.execute(
        'SELECT manager_id FROM clubs WHERE id = ?', [contract.club_id]
      );
      if (defendingClub?.manager_id && req.sendNotification) {
        req.sendNotification(
          defendingClub.manager_id,
          'poach_attempt',
          `£${bid_amount.toLocaleString()} bid received for ${player.name}! You have 48 hours to respond.`,
          { player_id, bid_id: result.insertId, offered_wage, bid_amount }
        );
      }
    }

    res.json({ success: true, bid_id: result.insertId, message: `Bid submitted for ${player.name}` });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// USE LOYALTY TOKEN
router.post('/loyalty-token/:bid_id', async (req, res) => {
  try {
    await req.pool.execute(
      'UPDATE transfer_bids SET loyalty_token_used = true WHERE id = ?', [req.params.bid_id]
    );
    res.json({ success: true, message: 'Loyalty token used - player much more likely to stay' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RESOLVE BID
router.post('/resolve/:bid_id', async (req, res) => {
  const pool = req.pool;
  try {
    const [[bid]] = await pool.execute('SELECT * FROM transfer_bids WHERE id = ?', [req.params.bid_id]);
    if (!bid) return res.status(404).json({ error: 'Bid not found' });

    const [[player]] = await pool.execute('SELECT * FROM players WHERE id = ?', [bid.player_id]);
    const [[contract]] = await pool.execute('SELECT * FROM contracts WHERE player_id = ? AND active = true', [bid.player_id]);
    const [[currentClub]] = await pool.execute('SELECT * FROM clubs WHERE id = ?', [bid.to_club_id]);
    const [[biddingClub]] = await pool.execute('SELECT * FROM clubs WHERE id = ?', [bid.from_club_id]);

    const result = calculatePlayerDecision(player, contract, currentClub, biddingClub, bid);

    if (result.decision === 'leave') {
      await pool.execute('UPDATE contracts SET active = false WHERE player_id = ? AND active = true', [bid.player_id]);
      await pool.execute('UPDATE players SET club_id = ? WHERE id = ?', [bid.from_club_id, bid.player_id]);
      const [[clock]] = await pool.execute('SELECT * FROM game_clock LIMIT 1');
      await pool.execute(
        `INSERT INTO contracts 
          (player_id, club_id, weekly_wage, start_week, start_season, duration_weeks, 
           expires_at_week, expires_at_season, no_poach_until_week)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [bid.player_id, bid.from_club_id, bid.offered_wage,
         clock.current_week, clock.current_season,
         bid.offered_years * 38,
         clock.current_week + bid.offered_years * 38,
         clock.current_season + bid.offered_years,
         clock.current_week + 8]
      );
      await pool.execute(
        "UPDATE transfer_bids SET status = 'completed', player_decision = 'leave' WHERE id = ?",
        [bid.id]
      );
    } else {
      await pool.execute(
        "UPDATE transfer_bids SET status = 'completed', player_decision = 'stay' WHERE id = ?",
        [bid.id]
      );
    }

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TRANSFER MARKET
router.get('/market', async (req, res) => {
  const { position, league, search } = req.query;
  try {
    let query = `
      SELECT p.*, cl.name AS club_name, cl.league,
        ROUND(p.overall_rating * 900000) as market_value,
        ROUND(p.overall_rating * 900000 * 0.8) as min_fee
      FROM players p
      LEFT JOIN contracts c ON c.player_id = p.id AND c.active = 1
      LEFT JOIN clubs cl ON cl.id = c.club_id
      WHERE 1=1
    `;
    const params = [];
    if (position) { params.push(position); query += ` AND p.position = ?`; }
    if (league) { params.push(`%${league}%`); query += ` AND cl.league LIKE ?`; }
    if (search) { params.push(`%${search}%`); query += ` AND p.name LIKE ?`; }
    query += ' ORDER BY p.overall_rating DESC LIMIT 500';
    const [rows] = await req.pool.execute(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
