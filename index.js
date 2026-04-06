const express = require('express');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const wsPort = process.env.WS_PORT || (parseInt(port) + 1);

app.use(express.json());
app.use(express.static('public'));

// Store user credentials and bot status
let userCredentials = null;
let botStatus = {
  isActive: false,
  lastCheck: null,
  nextCheck: null,
  message: 'Bot not started',
  reservations: []
};

// WebSocket server for real-time updates
const wss = new WebSocket.Server({ port: wsPort });

function broadcastStatus() {
  const statusMessage = JSON.stringify({ type: 'status', data: botStatus });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(statusMessage);
    }
  });
}

function updateStatus(message, data = {}) {
  botStatus.message = message;
  botStatus.lastCheck = new Date().toISOString();
  Object.assign(botStatus, data);
  broadcastStatus();
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Tennis court booking logic
async function bookTennisCourt() {
  if (!userCredentials) {
    updateStatus('No credentials provided');
    return;
  }

  let browser;
  try {
    updateStatus('Starting browser and navigating to reservation site...');
    
    browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    
    // Navigate to SF Rec Park tennis reservations
    await page.goto('https://sfrecpark.org/1446/Reservable-Tennis-Courts', {
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    updateStatus('Looking for Alice Marble Tennis Courts reservation link...');
    
    // Look for Alice Marble tennis court reservation link
    const aliceMarbleLink = await page.$x("//a[contains(text(), 'Alice Marble') or contains(@href, 'alice') or contains(@href, 'marble')]");
    
    if (aliceMarbleLink.length > 0) {
      updateStatus('Found Alice Marble link, clicking...');
      await aliceMarbleLink[0].click();
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
    } else {
      // Try to find any tennis court reservation system link
      const reserveLinks = await page.$x("//a[contains(text(), 'Reserve') or contains(text(), 'Book') or contains(@href, 'reservation')]");
      if (reserveLinks.length > 0) {
        updateStatus('Found reservation system link, navigating...');
        await reserveLinks[0].click();
        await page.waitForNavigation({ waitUntil: 'networkidle0' });
      } else {
        throw new Error('Could not find reservation system link');
      }
    }
    
    updateStatus('Attempting to log in...');
    
    // Look for login form
    const loginFields = await page.$$('input[type="text"], input[type="email"], input[name*="user"], input[name*="email"]');
    const passwordFields = await page.$$('input[type="password"]');
    
    if (loginFields.length > 0 && passwordFields.length > 0) {
      await loginFields[0].type(userCredentials.username);
      await passwordFields[0].type(userCredentials.password);
      
      // Look for login button
      const loginButton = await page.$('button[type="submit"], input[type="submit"], button:contains("Log"), button:contains("Sign")');
      if (loginButton) {
        await loginButton.click();
        await page.waitForNavigation({ waitUntil: 'networkidle0' });
      }
    }
    
    updateStatus('Searching for available Alice Marble tennis courts...');
    
    // Look for Alice Marble courts or time slots
    const availableSlots = await page.evaluate(() => {
      const slots = [];
      const elements = document.querySelectorAll('a, button, div');
      
      elements.forEach(el => {
        const text = el.textContent || '';
        const href = el.href || '';
        
        if ((text.toLowerCase().includes('alice marble') || 
             text.toLowerCase().includes('available') || 
             text.toLowerCase().includes('book')) &&
            (el.tagName === 'A' || el.tagName === 'BUTTON' || el.onclick)) {
          slots.push({
            text: text.trim(),
            href: href,
            clickable: true
          });
        }
      });
      
      return slots;
    });
    
    if (availableSlots.length > 0) {
      updateStatus(`Found ${availableSlots.length} potential booking options, attempting to book...`);
      
      // Try to click the first available slot
      const firstSlot = availableSlots[0];
      const element = await page.$x(`//*[contains(text(), '${firstSlot.text.substring(0, 20)}')]`);
      
      if (element.length > 0) {
        await element[0].click();
        await page.waitForTimeout(2000);
        
        // Look for confirmation button
        const confirmButtons = await page.$x("//button[contains(text(), 'Confirm') or contains(text(), 'Book') or contains(text(), 'Reserve')]");
        if (confirmButtons.length > 0) {
          await confirmButtons[0].click();
          updateStatus('Successfully booked tennis court!', {
            reservations: [...botStatus.reservations, {
              court: 'Alice Marble Tennis Court',
              time: new Date().toISOString(),
              status: 'Booked'
            }]
          });
        } else {
          updateStatus('Found available slot but could not complete booking');
        }
      }
    } else {
      updateStatus('No available Alice Marble tennis courts found at this time');
    }
    
  } catch (error) {
    updateStatus(`Error: ${error.message}`);
    console.error('Booking error:', error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Schedule bot to run every hour during peak booking times (6 AM - 10 PM)
let cronJob = null;

function startBot() {
  if (cronJob) {
    cronJob.destroy();
  }
  
  // Run every 15 minutes during booking hours
  cronJob = cron.schedule('*/15 6-22 * * *', async () => {
    if (botStatus.isActive) {
      await bookTennisCourt();
    }
  });
  
  botStatus.isActive = true;
  botStatus.nextCheck = 'Every 15 minutes (6 AM - 10 PM)';
  updateStatus('Bot started and monitoring for tennis court availability');
}

function stopBot() {
  if (cronJob) {
    cronJob.destroy();
    cronJob = null;
  }
  
  botStatus.isActive = false;
  botStatus.nextCheck = null;
  updateStatus('Bot stopped');
}

// API Routes
app.get('/', (req, res) => {
  res.json({ status: 'SF Tennis Bot API is running', timestamp: new Date().toISOString() });
});

app.post('/api/credentials', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  userCredentials = { username, password };
  updateStatus('Credentials updated successfully');
  res.json({ message: 'Credentials saved successfully' });
});

app.post('/api/start', (req, res) => {
  if (!userCredentials) {
    return res.status(400).json({ error: 'Please set credentials first' });
  }
  
  startBot();
  res.json({ message: 'Bot started successfully' });
});

app.post('/api/stop', (req, res) => {
  stopBot();
  res.json({ message: 'Bot stopped successfully' });
});

app.get('/api/status', (req, res) => {
  res.json(botStatus);
});

app.post('/api/test-booking', async (req, res) => {
  if (!userCredentials) {
    return res.status(400).json({ error: 'Please set credentials first' });
  }
  
  // Run booking attempt immediately
  bookTennisCourt();
  res.json({ message: 'Test booking started' });
});

app.listen(port, () => {
  console.log(`SF Tennis Bot server running on port ${port}`);
  console.log(`WebSocket server running on port ${wsPort}`);
  updateStatus('Server started, waiting for credentials and activation');
});