
/*
Render.com has specific filesystem permissions
Without this config, Puppeteer can't find Chromium
This is the #1 cause of "Browser not found" errors on Render
*/

import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Environment variables
const SUPABASE_EDGE_FUNCTION_URL = process.env.SUPABASE_RESULT_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const API_SECRET = process.env.API_SECRET; // Security token

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'Puppeteer Scraper',
    timestamp: new Date().toISOString()
  });
});

// Main scraping endpoint - receives URL from Supabase Edge Function
app.post('/scrape', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Verify API secret for security
    const providedSecret = req.headers['x-api-secret'];
    if (providedSecret !== API_SECRET) {
      console.error('Unauthorized request - invalid API secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Extract data from request body
    const { url, telegram_user_id, options = {} } = req.body;

    // Validate URL
    if (!url || !isValidUrl(url)) {
      console.error('Invalid URL provided:', url);
      return res.status(400).json({ error: 'Invalid or missing URL' });
    }

    console.log(`[${new Date().toISOString()}] Scraping request received for: ${url}`);

    // Respond immediately to Supabase (don't make it wait)
    res.status(202).json({ 
      status: 'accepted', 
      message: 'Scraping started',
      url: url
    });

    // Run scraping asynchronously
    scrapePage(url, telegram_user_id, options, startTime)
      .catch(error => {
        console.error('Scraping error:', error);
        // Even if scraping fails, send error details to Supabase
        sendResultsToSupabase({
          url,
          telegram_user_id,
          error: error.message,
          success: false,
          timestamp: new Date().toISOString()
        });
      });

  } catch (error) {
    console.error('Request handling error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Puppeteer scraping function
async function scrapePage(url, telegram_user_id, options = {}, startTime) {
  console.log(`Starting Puppeteer for: ${url}`);
  
  let browser;
  try {
    // Launch browser with Render-optimized settings
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });

    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ 
      width: options.viewport?.width || 1920, 
      height: options.viewport?.height || 1080 
    });

    // Set user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to URL
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { 
      waitUntil: options.waitUntil || 'networkidle2', 
      timeout: options.timeout || 30000 
    });

    console.log('Page loaded, extracting data...');

    // ========================================
    // CUSTOMIZE THIS SECTION FOR YOUR SCRAPING
    // ========================================
    const scrapedData = await page.evaluate(() => {
      // Extract page title
      const title = document.querySelector('h1')?.innerText || 
                    document.querySelector('title')?.innerText || 
                    'No title found';
      
      // Extract meta description
      const description = document.querySelector('meta[name="description"]')?.content || 
                         document.querySelector('meta[property="og:description"]')?.content || 
                         'No description found';
      
      // Extract all headings
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
        .map(h => ({
          tag: h.tagName.toLowerCase(),
          text: h.innerText.trim()
        }))
        .filter(h => h.text.length > 0);
      
      // Extract links
      const links = Array.from(document.querySelectorAll('a'))
        .map(a => ({
          text: a.innerText.trim(),
          href: a.href
        }))
        .filter(l => l.href && l.href.startsWith('http'))
        .slice(0, 50); // Limit to 50 links
      
      // Extract images
      const images = Array.from(document.querySelectorAll('img'))
        .map(img => ({
          src: img.src,
          alt: img.alt || ''
        }))
        .filter(img => img.src)
        .slice(0, 20); // Limit to 20 images

      // Get page text content (first 5000 characters)
      const bodyText = document.body?.innerText?.substring(0, 5000) || '';

      return {
        title,
        description,
        headings,
        links,
        images,
        bodyText,
        url: window.location.href,
        scrapedAt: new Date().toISOString()
      };
    });

    await browser.close();
    browser = null;

    const scrapingDuration = Date.now() - startTime;
    console.log(`Scraping completed in ${scrapingDuration}ms`);

    // Prepare result payload
    const resultPayload = {
      url,
      telegram_user_id,
      success: true,
      data: scrapedData,
      metadata: {
        scraping_duration_ms: scrapingDuration,
        timestamp: new Date().toISOString()
      }
    };

    // Send results to Supabase Edge Function #2
    await sendResultsToSupabase(resultPayload);

    console.log('Results sent to Supabase successfully');

  } catch (error) {
    console.error('Scraping error:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(e => console.error('Browser close error:', e));
    }
  }
}

// Send results back to Supabase Edge Function
async function sendResultsToSupabase(payload) {
  if (!SUPABASE_EDGE_FUNCTION_URL) {
    console.error('SUPABASE_RESULT_URL not configured');
    return;
  }

  try {
    console.log(`Sending results to Supabase: ${SUPABASE_EDGE_FUNCTION_URL}`);
    
    const response = await fetch(SUPABASE_EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supabase Edge Function error: ${response.status} - ${errorText}`);
      throw new Error(`Failed to send results: ${response.status}`);
    }

    const result = await response.json().catch(() => ({}));
    console.log('Supabase response:', result);

  } catch (error) {
    console.error('Error sending to Supabase:', error.message);
    // Don't throw - we don't want to crash the server if Supabase is down
  }
}

// URL validation helper
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Puppeteer server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Supabase URL configured: ${!!SUPABASE_EDGE_FUNCTION_URL}`);
});
