-- GAME CLOCK
CREATE TABLE IF NOT EXISTS game_clock (
  id INT AUTO_INCREMENT PRIMARY KEY,
  current_week INT DEFAULT 1,
  current_season INT DEFAULT 1,
  transfer_window_open TINYINT(1) DEFAULT 0,
  last_tick TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT IGNORE INTO game_clock (id, current_week, current_season) VALUES (1, 1, 1);

-- SERVERS
CREATE TABLE IF NOT EXISTS servers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  league VARCHAR(100) DEFAULT 'Premier League',
  max_managers INT DEFAULT 20,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- CLUBS
CREATE TABLE IF NOT EXISTS clubs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  server_id INT,
  name VARCHAR(100) NOT NULL,
  short_name VARCHAR(10),
  badge_url TEXT,
  primary_color VARCHAR(20) DEFAULT '#1f6feb',
  league VARCHAR(100),
  prestige INT DEFAULT 50,
  attack_strength DECIMAL(5,2) DEFAULT 70,
  defence_strength DECIMAL(5,2) DEFAULT 70,
  manager_id INT DEFAULT NULL,
  is_ai TINYINT(1) DEFAULT 1,
  wage_budget INT DEFAULT 500000,
  transfer_budget INT DEFAULT 10000000
);

-- MANAGERS
CREATE TABLE IF NOT EXISTS managers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  club_id INT DEFAULT NULL,
  server_id INT DEFAULT NULL,
  is_ai TINYINT(1) DEFAULT 0,
  ai_personality VARCHAR(20) DEFAULT 'balanced',
  session_token VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PLAYERS
CREATE TABLE IF NOT EXISTS players (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  nationality VARCHAR(50),
  position VARCHAR(10) NOT NULL,
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
  club_id INT DEFAULT NULL,
  is_free_agent TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- CONTRACTS
CREATE TABLE IF NOT EXISTS contracts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  player_id INT,
  club_id INT,
  weekly_wage INT NOT NULL,
  start_week INT NOT NULL,
  start_season INT NOT NULL,
  duration_weeks INT NOT NULL,
  expires_at_week INT NOT NULL,
  expires_at_season INT NOT NULL,
  active TINYINT(1) DEFAULT 1,
  no_poach_until_week INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- TRANSFER BIDS
CREATE TABLE IF NOT EXISTS transfer_bids (
  id INT AUTO_INCREMENT PRIMARY KEY,
  player_id INT,
  from_club_id INT,
  to_club_id INT,
  bid_amount INT NOT NULL,
  offered_wage INT NOT NULL,
  offered_years INT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  player_decision VARCHAR(20) DEFAULT 'pending',
  loyalty_token_used TINYINT(1) DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- FIXTURES
CREATE TABLE IF NOT EXISTS fixtures (
  id INT AUTO_INCREMENT PRIMARY KEY,
  server_id INT,
  home_club_id INT,
  away_club_id INT,
  week INT NOT NULL,
  season INT NOT NULL,
  home_goals INT DEFAULT NULL,
  away_goals INT DEFAULT NULL,
  played TINYINT(1) DEFAULT 0,
  home_possession INT DEFAULT NULL,
  away_possession INT DEFAULT NULL,
  home_shots INT DEFAULT NULL,
  away_shots INT DEFAULT NULL
);

-- LEAGUE TABLE
CREATE TABLE IF NOT EXISTS league_table (
  id INT AUTO_INCREMENT PRIMARY KEY,
  server_id INT,
  club_id INT,
  season INT DEFAULT 1,
  played INT DEFAULT 0,
  won INT DEFAULT 0,
  drawn INT DEFAULT 0,
  lost INT DEFAULT 0,
  goals_for INT DEFAULT 0,
  goals_against INT DEFAULT 0,
  goal_difference INT DEFAULT 0,
  points INT DEFAULT 0,
  UNIQUE KEY unique_table (server_id, club_id, season)
);

-- TACTICS
CREATE TABLE IF NOT EXISTS tactics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  club_id INT UNIQUE,
  formation VARCHAR(10) DEFAULT '4-3-3',
  pressing INT DEFAULT 5,
  defensive_line INT DEFAULT 5,
  tempo INT DEFAULT 5,
  width INT DEFAULT 5,
  attacking_risk INT DEFAULT 5,
  mentality VARCHAR(20) DEFAULT 'balanced',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  manager_id INT,
  type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  data JSON,
  `read` TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PRESS CONFERENCES
CREATE TABLE IF NOT EXISTS press_conferences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  manager_id INT,
  club_id INT,
  server_id INT,
  fixture_id INT DEFAULT NULL,
  template_text TEXT NOT NULL,
  custom_text TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PLAYER DEVELOPMENT LOG
CREATE TABLE IF NOT EXISTS development_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  player_id INT,
  season INT NOT NULL,
  week INT NOT NULL,
  overall_before INT,
  overall_after INT,
  attr_snapshot JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
