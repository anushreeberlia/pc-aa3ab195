const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

// Initialize database file if it doesn't exist
function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      users: [],
      bot_config: [{ id: 1, is_active: false, created_at: new Date().toISOString() }],
      activity_logs: [],
      reservations: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

// Read data from JSON file
function readData() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      initDB();
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading database:', error);
    initDB();
    return readData();
  }
}

// Write data to JSON file
function writeData(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Error writing database:', error);
    return false;
  }
}

// Helper functions
function getAll(collection) {
  const data = readData();
  return data[collection] || [];
}

function getById(collection, id) {
  const items = getAll(collection);
  return items.find(item => item.id === id);
}

function insert(collection, item) {
  const data = readData();
  if (!data[collection]) {
    data[collection] = [];
  }
  
  // Generate ID if not provided
  if (!item.id) {
    const maxId = data[collection].reduce((max, item) => Math.max(max, item.id || 0), 0);
    item.id = maxId + 1;
  }
  
  // Add timestamp
  item.created_at = new Date().toISOString();
  
  data[collection].push(item);
  writeData(data);
  return item.id;
}

function update(collection, id, newData) {
  const data = readData();
  const items = data[collection] || [];
  const index = items.findIndex(item => item.id === id);
  
  if (index !== -1) {
    items[index] = { ...items[index], ...newData, updated_at: new Date().toISOString() };
    writeData(data);
    return true;
  }
  return false;
}

function remove(collection, id) {
  const data = readData();
  const items = data[collection] || [];
  const newItems = items.filter(item => item.id !== id);
  
  if (newItems.length !== items.length) {
    data[collection] = newItems;
    writeData(data);
    return true;
  }
  return false;
}

// Database operations specific to the tennis bot
const dbOps = {
  // User operations
  saveCredentials(username, password) {
    try {
      const data = readData();
      const existingUser = data.users.find(u => u.id === 1);
      
      if (existingUser) {
        update('users', 1, { username, password });
      } else {
        insert('users', { id: 1, username, password });
      }
      
      this.addLog(`Credentials updated for user: ${username}`, 'info');
      return true;
    } catch (error) {
      this.addLog(`Error saving credentials: ${error.message}`, 'error');
      return false;
    }
  },
  
  getCredentials() {
    try {
      const user = getById('users', 1);
      return user ? { username: user.username, password: user.password } : null;
    } catch (error) {
      this.addLog(`Error retrieving credentials: ${error.message}`, 'error');
      return null;
    }
  },
  
  // Bot config operations
  setBotActive(isActive) {
    try {
      update('bot_config', 1, { is_active: isActive });
      this.addLog(`Bot ${isActive ? 'activated' : 'deactivated'}`, 'info');
      return true;
    } catch (error) {
      this.addLog(`Error updating bot status: ${error.message}`, 'error');
      return false;
    }
  },
  
  getBotConfig() {
    try {
      return getById('bot_config', 1);
    } catch (error) {
      this.addLog(`Error retrieving bot config: ${error.message}`, 'error');
      return null;
    }
  },
  
  // Activity log operations
  addLog(message, type = 'info') {
    try {
      insert('activity_logs', { message, log_type: type });
      
      // Clean up old logs (keep only last 100)
      if (Math.random() < 0.1) { // 10% chance to clean up
        const logs = getAll('activity_logs');
        if (logs.length > 100) {
          const data = readData();
          data.activity_logs = logs.slice(-100); // Keep last 100
          writeData(data);
        }
      }
    } catch (error) {
      console.error('Error adding log:', error);
    }
  },
  
  getLogs(limit = 50) {
    try {
      const logs = getAll('activity_logs');
      return logs.slice(-limit); // Get last N logs
    } catch (error) {
      console.error('Error retrieving logs:', error);
      return [];
    }
  },
  
  // Reservation operations
  addReservation(courtName, date, time, status = 'booked', details = null) {
    try {
      const id = insert('reservations', {
        court_name: courtName,
        reservation_date: date,
        reservation_time: time,
        status: status,
        booking_details: details
      });
      
      this.addLog(`Reservation added: ${courtName} on ${date} at ${time}`, 'success');
      return id;
    } catch (error) {
      this.addLog(`Error adding reservation: ${error.message}`, 'error');
      return null;
    }
  },
  
  getReservations(limit = 20) {
    try {
      const reservations = getAll('reservations');
      return reservations.slice(-limit).reverse(); // Get last N, most recent first
    } catch (error) {
      this.addLog(`Error retrieving reservations: ${error.message}`, 'error');
      return [];
    }
  },
  
  updateReservationStatus(id, status) {
    try {
      const success = update('reservations', id, { status });
      if (success) {
        this.addLog(`Reservation ${id} status updated to: ${status}`, 'info');
      }
      return success;
    } catch (error) {
      this.addLog(`Error updating reservation status: ${error.message}`, 'error');
      return false;
    }
  }
};

// Initialize database on module load
initDB();

module.exports = { getAll, getById, insert, update, remove, dbOps };