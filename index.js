const express = require('express');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const WebSocket = require('ws');
const path = require('path');
const { dbOps } = require('./db');

const app = express();
const port = process.env.PORT || 3000;
const wsPort = process.env.WS_PORT || (parseInt(port) + 1);

app.use(express.json());
app.use(express.static('public'));

// Bot status (in-memory for real-time updates, persisted in DB)
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
  
  // Log to database
  const logType = message.toLowerCase().includes('error') ? 'error' : 
                 message.toLowerCase().includes('success') ? 'success' : 'info';
  dbOps.addLog(message, logType);
  
  broadcastStatus();
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Tennis court booking logic with improved error handling and timeouts
async function bookTennisCourt(retryCount = 0) {
  const maxRetries = 3;
  const userCredentials = dbOps.getCredentials();
  
  if (!userCredentials) {
    updateStatus('No credentials provided');
    return;
  }

  let browser;
  try {
    const attempt = retryCount > 0 ? ` (Attempt ${retryCount + 1}/${maxRetries + 1})` : '';
    updateStatus(`Starting browser and navigating to reservation site...${attempt}`);
    
    browser = await puppeteer.launch({ 
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
      timeout: 60000
    });
    
    const page = await browser.newPage();
    
    // Set longer timeouts and better user agent
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });
    
    // Navigate to SF Rec Park tennis reservations with retry logic
    updateStatus('Navigating to SF Recreation website...');
    
    try {
      await page.goto('https://sfrecpark.org/1446/Reservable-Tennis-Courts', {
        waitUntil: 'domcontentloaded', // Less strict wait condition
        timeout: 60000
      });
    } catch (navError) {
      updateStatus(`Navigation failed: ${navError.message}. Trying alternative approach...`);
      
      // Try direct navigation to reservation system if main page fails
      const alternativeUrls = [
        'https://sfrecpark.perfectmind.com',
        'https://anc.apm.activecommunities.com/sfrecpark',
        'https://secure.rec1.com/CA/san-francisco-ca/catalog'
      ];
      
      let navigationSucceeded = false;
      for (const url of alternativeUrls) {
        try {
          updateStatus(`Trying alternative URL: ${url}`);
          await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
          });
          navigationSucceeded = true;
          break;
        } catch (altError) {
          updateStatus(`Alternative URL ${url} failed: ${altError.message}`);
        }
      }
      
      if (!navigationSucceeded) {
        throw new Error('All navigation attempts failed');
      }
    }
    
    // Wait for page to stabilize
    await page.waitForTimeout(3000);
    
    updateStatus('Page loaded, looking for tennis court reservation options...');
    
    // Look for various reservation-related links and buttons
    const reservationSelectors = [
      'a[href*="alice"]',
      'a[href*="marble"]',
      'a[href*="tennis"]',
      'a[href*="reservation"]',
      'a[href*="book"]',
      'button:contains("Reserve")',
      'button:contains("Book")',
      'a:contains("Alice Marble")',
      'a:contains("Tennis Courts")',
      'a:contains("Make Reservation")'
    ];
    
    let reservationLink = null;
    
    for (const selector of reservationSelectors) {
      try {
        if (selector.includes(':contains')) {
          // Use XPath for text content searches
          const textSearch = selector.split(':contains("')[1].replace('")','');
          const elements = await page.$x(`//a[contains(text(), '${textSearch}') or contains(@title, '${textSearch}')]`);
          if (elements.length > 0) {
            reservationLink = elements[0];
            updateStatus(`Found reservation link using text search: "${textSearch}"`);
            break;
          }
        } else {
          // Use CSS selector
          const element = await page.$(selector);
          if (element) {
            reservationLink = element;
            updateStatus(`Found reservation link using selector: ${selector}`);
            break;
          }
        }
      } catch (selectorError) {
        // Continue to next selector
        continue;
      }
    }
    
    if (reservationLink) {
      try {
        updateStatus('Clicking on reservation link...');
        
        // Get the href before clicking if it's a link
        const href = await reservationLink.evaluate(el => el.href || el.getAttribute('onclick') || '');
        updateStatus(`Navigating to: ${href || 'JavaScript link'}`);
        
        // Click and wait for navigation
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {
            // Navigation might not happen for JavaScript links
            updateStatus('No navigation detected, continuing...');
          }),
          reservationLink.click()
        ]);
        
        await page.waitForTimeout(5000); // Allow page to load
        
      } catch (clickError) {
        updateStatus(`Click failed: ${clickError.message}. Trying direct href navigation...`);
        
        const href = await reservationLink.evaluate(el => el.href);
        if (href && href !== '#') {
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }
      }
    } else {
      updateStatus('No reservation link found, searching page content for booking opportunities...');
    }
    
    // Look for login form
    updateStatus('Looking for login form...');
    
    const loginSelectors = {
      username: [
        'input[type="text"]',
        'input[type="email"]',
        'input[name*="user"]',
        'input[name*="email"]',
        'input[name*="login"]',
        'input[id*="user"]',
        'input[id*="email"]'
      ],
      password: [
        'input[type="password"]',
        'input[name*="pass"]',
        'input[id*="pass"]'
      ]
    };
    
    let usernameField = null;
    let passwordField = null;
    
    // Find username field
    for (const selector of loginSelectors.username) {
      const field = await page.$(selector);
      if (field) {
        const isVisible = await field.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (isVisible) {
          usernameField = field;
          break;
        }
      }
    }
    
    // Find password field
    for (const selector of loginSelectors.password) {
      const field = await page.$(selector);
      if (field) {
        const isVisible = await field.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (isVisible) {
          passwordField = field;
          break;
        }
      }
    }
    
    if (usernameField && passwordField) {
      updateStatus('Found login form, attempting to log in...');
      
      try {
        await usernameField.click();
        await usernameField.type(userCredentials.username, { delay: 100 });
        
        await passwordField.click();
        await passwordField.type(userCredentials.password, { delay: 100 });
        
        // Look for login button
        const loginButtonSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:contains("Login")',
          'button:contains("Sign In")',
          'button:contains("Log In")',
          'input[value*="Login"]',
          'input[value*="Sign")',
          '.login-button',
          '#login-button'
        ];
        
        let loginButton = null;
        for (const selector of loginButtonSelectors) {
          if (selector.includes(':contains')) {
            const textSearch = selector.split(':contains("')[1].replace('")','');
            const buttons = await page.$x(`//button[contains(text(), '${textSearch}')]`);
            if (buttons.length > 0) {
              loginButton = buttons[0];
              break;
            }
          } else {
            const button = await page.$(selector);
            if (button) {
              loginButton = button;
              break;
            }
          }
        }
        
        if (loginButton) {
          updateStatus('Clicking login button...');
          
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
              updateStatus('Login may have succeeded without navigation');
            }),
            loginButton.click()
          ]);
          
          await page.waitForTimeout(3000);
        } else {
          // Try pressing Enter on password field
          await passwordField.press('Enter');
          await page.waitForTimeout(3000);
        }
        
      } catch (loginError) {
        updateStatus(`Login attempt failed: ${loginError.message}`);
      }
    }
    
    updateStatus('Searching for available Alice Marble tennis courts...');
    
    // Enhanced search for available courts/time slots
    const availableSlots = await page.evaluate(() => {
      const slots = [];
      const searchTerms = [
        'alice marble',
        'available',
        'book now',
        'reserve',
        'select time',
        'tennis court'
      ];
      
      const elements = document.querySelectorAll('a, button, div[onclick], span[onclick]');
      
      elements.forEach(el => {
        const text = (el.textContent || '').toLowerCase();
        const href = el.href || '';
        const hasOnClick = el.onclick || el.getAttribute('onclick');
        
        const isRelevant = searchTerms.some(term => 
          text.includes(term) || 
          href.toLowerCase().includes(term)
        );
        
        if (isRelevant && (el.tagName === 'A' || el.tagName === 'BUTTON' || hasOnClick)) {
          slots.push({
            text: (el.textContent || '').trim().substring(0, 100),
            href: href,
            tagName: el.tagName,
            hasOnClick: !!hasOnClick,
            isVisible: el.offsetParent !== null
          });
        }
      });
      
      return slots.filter(slot => slot.isVisible);
    });
    
    if (availableSlots.length > 0) {
      updateStatus(`Found ${availableSlots.length} potential booking options, attempting to book...`);
      
      // Try to book the first available slot
      for (let i = 0; i < Math.min(3, availableSlots.length); i++) {
        const slot = availableSlots[i];
        
        try {
          updateStatus(`Attempting to book slot ${i + 1}: "${slot.text.substring(0, 50)}..."`);
          
          // Find and click the element
          if (slot.href && slot.tagName === 'A') {
            // It's a link
            await page.goto(slot.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } else {
            // Find by text content and click
            const elements = await page.$x(`//*[contains(text(), '${slot.text.substring(0, 30)}')]`);
            if (elements.length > 0) {
              await elements[0].click();
              await page.waitForTimeout(3000);
            }
          }
          
          // Look for confirmation or next step
          const confirmationSelectors = [
            'button:contains("Confirm")',
            'button:contains("Book")',
            'button:contains("Reserve")',
            'button:contains("Complete")',
            'input[value*="Confirm"]',
            'input[value*="Book"]',
            'input[value*="Reserve"]'
          ];
          
          let confirmButton = null;
          for (const selector of confirmationSelectors) {
            if (selector.includes(':contains')) {
              const textSearch = selector.split(':contains("')[1].replace('")','');
              const buttons = await page.$x(`//button[contains(text(), '${textSearch}')] | //input[contains(@value, '${textSearch}')]`);
              if (buttons.length > 0) {
                confirmButton = buttons[0];
                break;
              }
            } else {
              const button = await page.$(selector);
              if (button) {
                confirmButton = button;
                break;
              }
            }
          }
          
          if (confirmButton) {
            updateStatus('Found confirmation button, completing booking...');
            await confirmButton.click();
            await page.waitForTimeout(5000);
            
            // Check for success indicators
            const successText = await page.evaluate(() => {
              const body = document.body.textContent.toLowerCase();
              const successIndicators = [
                'successfully booked',
                'reservation confirmed',
                'booking complete',
                'confirmation number',
                'reserved successfully'
              ];
              
              return successIndicators.find(indicator => body.includes(indicator));
            });
            
            if (successText) {
              // Add successful reservation to database
              const reservationDate = new Date().toISOString().split('T')[0];
              const reservationTime = new Date().toLocaleTimeString();
              const reservationId = dbOps.addReservation(
                'Alice Marble Tennis Court',
                reservationDate,
                reservationTime,
                'booked',
                JSON.stringify({ slot: slot, successIndicator: successText })
              );
              
              // Update status with new reservations list
              const reservations = dbOps.getReservations(10).map(res => ({
                id: res.id,
                court: res.court_name,
                date: res.reservation_date,
                time: res.reservation_time,
                status: res.status,
                created: res.created_at
              }));
              
              updateStatus(`Successfully booked tennis court! Confirmation: ${successText}`, { reservations });
              return; // Success, exit the function
            }
          }
          
          updateStatus(`Booking attempt ${i + 1} did not complete successfully, trying next option...`);
          
        } catch (slotError) {
          updateStatus(`Error with booking attempt ${i + 1}: ${slotError.message}`);
          continue;
        }
      }
      
      updateStatus('Could not complete any booking - may require manual intervention');
      
    } else {
      updateStatus('No available Alice Marble tennis courts found at this time');
    }
    
  } catch (error) {
    const errorMessage = `Error during booking attempt: ${error.message}`;
    updateStatus(errorMessage);
    console.error('Detailed booking error:', error);
    
    // Retry logic for certain errors
    if (retryCount < maxRetries && 
        (error.message.includes('timeout') || 
         error.message.includes('Navigation') || 
         error.message.includes('net::ERR'))) {
      
      updateStatus(`Retrying in 10 seconds... (${retryCount + 1}/${maxRetries})`);
      
      setTimeout(async () => {
        await bookTennisCourt(retryCount + 1);
      }, 10000);
    }
    
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('Error closing browser:', closeError);
      }
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
  
  // Update database
  dbOps.setBotActive(true);
  
  updateStatus('Bot started and monitoring for tennis court availability');
}

function stopBot() {
  if (cronJob) {
    cronJob.destroy();
    cronJob = null;
  }
  
  botStatus.isActive = false;
  botStatus.nextCheck = null;
  
  // Update database
  dbOps.setBotActive(false);
  
  updateStatus('Bot stopped');
}

// Load initial data from database
function loadInitialData() {
  const config = dbOps.getBotConfig();
  if (config) {
    botStatus.isActive = Boolean(config.is_active);
    if (botStatus.isActive) {
      startBot(); // Restart bot if it was active
    }
  }
  
  // Load recent reservations
  const reservations = dbOps.getReservations(10).map(res => ({
    id: res.id,
    court: res.court_name,
    date: res.reservation_date,
    time: res.reservation_time,
    status: res.status,
    created: res.created_at
  }));
  
  botStatus.reservations = reservations;
  updateStatus('Server started, data loaded from database');
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
  
  const success = dbOps.saveCredentials(username, password);
  if (success) {
    updateStatus('Credentials updated successfully');
    res.json({ message: 'Credentials saved successfully' });
  } else {
    res.status(500).json({ error: 'Failed to save credentials' });
  }
});

app.post('/api/start', (req, res) => {
  const credentials = dbOps.getCredentials();
  if (!credentials) {
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
  // Include recent logs
  const logs = dbOps.getLogs(20);
  res.json({
    ...botStatus,
    logs: logs.map(log => ({
      message: log.message,
      type: log.log_type,
      timestamp: log.created_at
    }))
  });
});

app.get('/api/reservations', (req, res) => {
  const reservations = dbOps.getReservations(50).map(res => ({
    id: res.id,
    court: res.court_name,
    date: res.reservation_date,
    time: res.reservation_time,
    status: res.status,
    created: res.created_at,
    details: res.booking_details
  }));
  
  res.json({ reservations });
});

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = dbOps.getLogs(limit);
  res.json({ logs });
});

app.post('/api/test-booking', async (req, res) => {
  const credentials = dbOps.getCredentials();
  if (!credentials) {
    return res.status(400).json({ error: 'Please set credentials first' });
  }
  
  // Run booking attempt immediately
  bookTennisCourt();
  res.json({ message: 'Test booking started' });
});

app.listen(port, () => {
  console.log(`SF Tennis Bot server running on port ${port}`);
  console.log(`WebSocket server running on port ${wsPort}`);
  
  // Load initial data from database
  loadInitialData();
});