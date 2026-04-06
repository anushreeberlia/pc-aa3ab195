const Database = require('better-sqlite3');
const path = require('path');

// Initialize database
const db = new Database('./data.db');

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bot_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    is_active BOOLEAN DEFAULT 0,
    schedule_pattern TEXT DEFAULT '*/15 6-22 * * *',
    target_court TEXT DEFAULT 'Alice Marble Tennis Court',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    log_type TEXT DEFAULT 'info',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    court_name TEXT NOT NULL,
    reservation_date TEXT NOT NULL,
    reservation_time TEXT,
    status TEXT DEFAULT 'booked',
    booking_details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Insert default bot config if none exists
  INSERT OR IGNORE INTO bot_config (id, is_active) VALUES (1, 0);
`);

// Prepared statements
const statements = {
  // User operations
  saveUser: db.prepare('INSERT OR REPLACE INTO users (id, username, password, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)'),
  getUser: db.prepare('SELECT * FROM users WHERE id = 1'),
  
  // Bot config operations
  updateBotConfig: db.prepare('UPDATE bot_config SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'),
  getBotConfig: db.prepare('SELECT * FROM bot_config WHERE id = 1'),
  
  // Activity log operations
  addLog: db.prepare('INSERT INTO activity_logs (message, log_type) VALUES (?, ?)'),
  getLogs: db.prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?'),
  clearOldLogs: db.prepare('DELETE FROM activity_logs WHERE created_at < datetime("now", "-7 days")'),
  
  // Reservation operations
  addReservation: db.prepare('INSERT INTO reservations (court_name, reservation_date, reservation_time, status, booking_details) VALUES (?, ?, ?, ?, ?)'),
  getReservations: db.prepare('SELECT * FROM reservations ORDER BY created_at DESC LIMIT ?'),
  updateReservationStatus: db.prepare('UPDATE reservations SET status = ? WHERE id = ?')
};

// Database operations
const dbOps = {
  // User operations
  saveCredentials(username, password) {
    try {
      statements.saveUser.run(username, password);
      this.addLog(`Credentials updated for user: ${username}`, 'info');
      return true;
    } catch (error) {
      this.addLog(`Error saving credentials: ${error.message}`, 'error');
      return false;
    }
  },
  
  getCredentials() {
    try {
      const user = statements.getUser.get();
      return user ? { username: user.username, password: user.password } : null;
    } catch (error) {
      this.addLog(`Error retrieving credentials: ${error.message}`, 'error');
      return null;
    }
  },
  
  // Bot config operations
  setBotActive(isActive) {
    try {
      statements.updateBotConfig.run(isActive ? 1 : 0);
      this.addLog(`Bot ${isActive ? 'activated' : 'deactivated'}`, 'info');
      return true;
    } catch (error) {
      this.addLog(`Error updating bot status: ${error.message}`, 'error');
      return false;
    }
  },
  
  getBotConfig() {
    try {
      return statements.getBotConfig.get();
    } catch (error) {
      this.addLog(`Error retrieving bot config: ${error.message}`, 'error');
      return null;
    }
  },
  
  // Activity log operations
  addLog(message, type = 'info') {
    try {
      statements.addLog.run(message, type);
      // Clean up old logs periodically
      if (Math.random() < 0.01) { // 1% chance to clean up old logs
        statements.clearOldLogs.run();
      }
    } catch (error) {
      console.error('Error adding log:', error);
    }
  },
  
  getLogs(limit = 50) {
    try {
      return statements.getLogs.all(limit);
    } catch (error) {
      console.error('Error retrieving logs:', error);
      return [];
    }
  },
  
  // Reservation operations
  addReservation(courtName, date, time, status = 'booked', details = null) {
    try {
      const result = statements.addReservation.run(courtName, date, time, status, details);
      this.addLog(`Reservation added: ${courtName} on ${date} at ${time}`, 'success');
      return result.lastInsertRowid;
    } catch (error) {
      this.addLog(`Error adding reservation: ${error.message}`, 'error');
      return null;
    }
  },
  
  getReservations(limit = 20) {
    try {
      return statements.getReservations.all(limit);
    } catch (error) {
      this.addLog(`Error retrieving reservations: ${error.message}`, 'error');
      return [];
    }
  },
  
  updateReservationStatus(id, status) {
    try {
      statements.updateReservationStatus.run(status, id);
      this.addLog(`Reservation ${id} status updated to: ${status}`, 'info');
      return true;
    } catch (error) {
      this.addLog(`Error updating reservation status: ${error.message}`, 'error');
      return false;
    }
  }
};

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Closing database connection...');
  db.close();
  process.exit(0);
});

module.exports = { db, dbOps };