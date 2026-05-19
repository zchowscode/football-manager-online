-- GAME CLOCK
CREATE TABLE IF NOT EXISTS game_clock (
  id SERIAL PRIMARY KEY,
  current_week INT DEFAULT 1,
  current_season INT DEFAULT 1,
  transfer_window_open BOOLEAN DEFAULT false,
  last_tick TIMESTAMP DEFAULT NOW()
);
INSERT INTO game_clock (current_week, current_season) VALUES (1, 1) ON CONFLICT DO NOTHING;

-- SERVERS (each server = one multiplayer world)
CREATE TABLE IF NOT EXISTS servers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  league TEXT DEFAULT 'Premier League',
  max_managers INT DEFAULT 20,
  created_at TIMESTAMP DEFAULT NOW()
);

-- CLUBS
CREATE TABLE IF NOT EXISTS clubs (
  id SERIAL PRIMARY KEY,
  server_id INT REFERENCES servers(id),
  name TEXT NOT NULL,
  short_name TEXT,
  badge_url TEXT,
  primary_color TEXT DEFAULT '#1f6feb',
  league TEXT,
  prestige INT DEFAULT 50,
  attack_strength NUMERIC DEFAULT 70,
  defence_strength NUMERIC DEFAULT 70,
  manager_id INT,
  is_ai BOOLEAN DEFAULT true,
  wage_budget INT DEFAULT 500000,
  transfer_budget INT DEFAULT 10000000
);

-- MANAGERS
CREATE TABLE IF NOT EXISTS managers (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  club_id INT REFERENCES clubs(id),
  server_id INT REFERENCES servers(id),
  is_ai BOOLEAN DEFAULT false,
  ai_personality TEXT DEFAULT 'balanced',
  created_at TIMESTAMP DEFAULT NOW()
);

-- PLAYERS
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  nationality TEXT,
  position TEXT NOT NULL,
  age INT NOT NULL,
  overall_rating INT NOT NULL,
  potential INT NOT NULL,
  pace INT DEFAULT 70,
  shooting INT DEFAULT 70,
  passing INT DEFAULT 70,
  dribbling INT DEFAULT 70,
  defending INT DEFAULT 70,
  physical INT DEFAULT 70,
  happiness INT DEFAULT 80,
  loyalty INT DEFAULT 50,
  reputation INT DEFAULT 50,
  club_id INT REFERENCES clubs(id),
  is_free_agent BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- CONTRACTS
CREATE TABLE IF NOT EXISTS contracts (
  id SERIAL PRIMARY KEY,
  player_id INT REFERENCES players(id),
  club_id INT REFERENCES clubs(id),
  weekly_wage INT NOT NULL,
  start_week INT NOT NULL,
  start_season INT NOT NULL,
  duration_weeks INT NOT NULL,
  expires_at_week INT NOT NULL,
  expires_at_season INT NOT NULL,
  active BOOLEAN DEFAULT true,
  no_poach_until_week INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- TRANSFER BIDS
CREATE TABLE IF NOT EXISTS transfer_bids (
  id SERIAL PRIMARY KEY,
  player_id INT REFERENCES players(id),
  from_club_id INT REFERENCES clubs(id),
  to_club_id INT REFERENCES clubs(id),
  bid_amount INT NOT NULL,
  offered_wage INT NOT NULL,
  offered_years INT NOT NULL,
  status TEXT DEFAULT 'pending',
  player_decision TEXT DEFAULT 'pending',
  loyalty_token_used BOOLEAN DEFAULT false,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- FIXTURES
CREATE TABLE IF NOT EXISTS fixtures (
  id SERIAL PRIMARY KEY,
  server_id INT REFERENCES servers(id),
  home_club_id INT REFERENCES clubs(id),
  away_club_id INT REFERENCES clubs(id),
  week INT NOT NULL,
  season INT NOT NULL,
  home_goals INT,
  away_goals INT,
  played BOOLEAN DEFAULT false,
  home_possession INT,
  away_possession INT,
  home_shots INT,
  away_shots INT
);

-- LEAGUE TABLE
CREATE TABLE IF NOT EXISTS league_table (
  id SERIAL PRIMARY KEY,
  server_id INT REFERENCES servers(id),
  club_id INT REFERENCES clubs(id),
  season INT DEFAULT 1,
  played INT DEFAULT 0,
  won INT DEFAULT 0,
  drawn INT DEFAULT 0,
  lost INT DEFAULT 0,
  goals_for INT DEFAULT 0,
  goals_against INT DEFAULT 0,
  goal_difference INT DEFAULT 0,
  points INT DEFAULT 0,
  UNIQUE(server_id, club_id, season)
);

-- TACTICS
CREATE TABLE IF NOT EXISTS tactics (
  id SERIAL PRIMARY KEY,
  club_id INT REFERENCES clubs(id) UNIQUE,
  formation TEXT DEFAULT '4-3-3',
  pressing INT DEFAULT 5,
  defensive_line INT DEFAULT 5,
  tempo INT DEFAULT 5,
  width INT DEFAULT 5,
  attacking_risk INT DEFAULT 5,
  mentality TEXT DEFAULT 'balanced',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  manager_id INT REFERENCES managers(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- PRESS CONFERENCES
CREATE TABLE IF NOT EXISTS press_conferences (
  id SERIAL PRIMARY KEY,
  manager_id INT REFERENCES managers(id),
  club_id INT REFERENCES clubs(id),
  server_id INT REFERENCES servers(id),
  fixture_id INT REFERENCES fixtures(id),
  template_text TEXT NOT NULL,
  custom_text TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- PLAYER DEVELOPMENT LOG
CREATE TABLE IF NOT EXISTS development_log (
  id SERIAL PRIMARY KEY,
  player_id INT REFERENCES players(id),
  season INT NOT NULL,
  week INT NOT NULL,
  overall_before INT,
  overall_after INT,
  attr_snapshot JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
