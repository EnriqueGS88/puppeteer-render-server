/*
Improved version by Lovable
Without this config, Puppeteer can't find Chromium
This is the #1 cause of "Browser not found" errors on Render
*/


import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Configuration
const INGEST_JOB_URL = process.env.INGEST_JOB_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_SECRET = process.env.API_SECRET;

// Validate environment variables
if (!INGEST_JOB_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('⚠️ Missing required environment variables!');
  console.error('Required: INGEST_JOB_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Simple auth middleware
function validateApiSecret(req, res, next) {
  const secret = req.headers['x-api-secret'];
  
  if (!API_SECRET) {
    console.warn('⚠️ API_SECRET not set - skipping auth');
    return next();
  }
  
  if (secret !== API_SECRET) {
    console.error('❌ Invalid API secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    config: {
      ingestJobUrl: !!INGEST_JOB_URL,
      serviceRoleKey: !!SUPABASE_SERVICE_ROLE_KEY,
      apiSecret: !!API_SECRET
    }
  });
});

// Main scraping endpoint
app.post('/scrape', validateApiSecret, async (req, res) => {
  const { url, user_id } = req.body;

  console.log(`\n📥 Scrape request received:`);
  console.log(`  URL: ${url}`);
  console.log(`  User ID: ${user_id}`);

  if (!url || !user_id) {
    return res.status(400).json({ 
      error: 'Missing required fields: url and user_id' 
    });
  }

  try {
    // Scrape the LinkedIn page
    console.log(`🚀 Launching Puppeteer...`);
    const jobData = await scrapePage(url, user_id);
    
    console.log(`✅ Scraping completed successfully`);
    res.json({
      success: true,
      message: 'Job scraped and ingested successfully',
      jobData: jobData
    });

  } catch (error) {
    console.error('❌ Scraping error:', error.message);
    res.status(500).json({
      error: error.message,
      details: error.stack
    });
  }
});

// Core scraping logic
async function scrapePage(url, user_id) {
  let browser;
  
  try {
    console.log(`🌐 Opening browser for: ${url}`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });

    const page = await browser.newPage();
    
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log(`📄 Navigating to URL...`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    console.log(`🔍 Extracting LinkedIn job data...`);
    
    // Extract LinkedIn-specific job data
    const scrapedData = await page.evaluate(() => {
      // Helper function to get text content safely
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.innerText.trim() : null;
      };

      // Extract job title
      const title = getText('.top-card-layout__title') || 
                    getText('h1.topcard__title') || 
                    getText('h1') || 
                    null;

      // Extract company name
      const company = getText('.topcard__org-name-link') || 
                      getText('.top-card-layout__second-subline a') ||
                      getText('.topcard__flavor--black-link') ||
                      null;

      // Extract location
      const location = getText('.topcard__flavor--bullet') || 
                       getText('.top-card-layout__second-subline span') ||
                       null;

      // Extract employment type & seniority from criteria
      const criteriaItems = Array.from(document.querySelectorAll('.description__job-criteria-item'));
      let employment_type = null;
      let seniority = null;

      criteriaItems.forEach(item => {
        const subheader = item.querySelector('.description__job-criteria-subheader')?.innerText?.trim();
        const text = item.querySelector('.description__job-criteria-text')?.innerText?.trim();
        
        if (subheader?.includes('Employment type')) {
          employment_type = text;
        }
        if (subheader?.includes('Seniority level')) {
          seniority = text;
        }
      });

      // Extract full job description
      const description = getText('.show-more-less-html__markup') || 
                          getText('.description__text') ||
                          getText('.core-section-container__content') ||
                          document.body.innerText.substring(0, 5000);

      // Extract skills (if visible)
      const skills = Array.from(document.querySelectorAll('.job-details-skill-match-status-item__skill-item'))
        .map(el => el.innerText.trim())
        .filter(Boolean);

      // Extract LinkedIn job ID from URL
      const jobIdMatch = window.location.href.match(/\/jobs\/view\/(\d+)/);
      const external_id = jobIdMatch ? jobIdMatch[1] : null;

      // Extract posted date
      const postedText = getText('.topcard__flavor--metadata');
      let posted_at = null;
      if (postedText) {
        const match = postedText.match(/(\d+)\s+(day|hour|week|month)s?\s+ago/i);
        if (match) {
          const amount = parseInt(match[1]);
          const unit = match[2].toLowerCase();
          const now = new Date();
          
          if (unit === 'day') now.setDate(now.getDate() - amount);
          else if (unit === 'hour') now.setHours(now.getHours() - amount);
          else if (unit === 'week') now.setDate(now.getDate() - (amount * 7));
          else if (unit === 'month') now.setMonth(now.getMonth() - amount);
          
          posted_at = now.toISOString();
        }
      }

      return {
        title,
        company,
        location,
        employment_type,
        seniority,
        description,
        skills: skills.length > 0 ? skills : null,
        external_id,
        posted_at,
        url: window.location.href
      };
    });

    console.log(`📊 Extracted data:`, {
      title: scrapedData.title,
      company: scrapedData.company,
      location: scrapedData.location,
      external_id: scrapedData.external_id
    });

    // Validate required fields
    if (!scrapedData.title) {
      throw new Error('Failed to extract job title from page');
    }

    // Format job data for ingest-job
    const jobData = {
      source: 'linkedin',
      external_id: scrapedData.external_id,
      title: scrapedData.title,
      company: scrapedData.company,
      location: scrapedData.location,
      employment_type: scrapedData.employment_type,
      seniority: scrapedData.seniority,
      url: url,
      description: scrapedData.description,
      skills: scrapedData.skills || [],
      posted_at: scrapedData.posted_at,
      user_id: user_id // Include user_id for service role auth
    };

    // Send to ingest-job
    console.log(`📤 Sending to ingest-job...`);
    await sendToIngestJob(jobData);

    return jobData;

  } catch (error) {
    console.error('Scraping error:', error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log(`🔒 Browser closed`);
    }
  }
}

// Send scraped data to ingest-job edge function
async function sendToIngestJob(jobData) {
  if (!INGEST_JOB_URL) {
    throw new Error('INGEST_JOB_URL not configured');
  }

  try {
    console.log(`🎯 Calling ingest-job: ${INGEST_JOB_URL}`);
    
    const response = await fetch(INGEST_JOB_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY
      },
      body: JSON.stringify(jobData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ ingest-job error: ${response.status} - ${errorText}`);
      throw new Error(`Failed to ingest job: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('✅ ingest-job response:', result);
    
    return result;

  } catch (error) {
    console.error('Error sending to ingest-job:', error.message);
    throw error;
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 LinkedIn Scraper Server`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔗 Ingest Job URL: ${INGEST_JOB_URL}`);
  console.log(`🔐 Service Role Key: ${SUPABASE_SERVICE_ROLE_KEY ? '✓ Set' : '✗ Missing'}`);
  console.log(`🔑 API Secret: ${API_SECRET ? '✓ Set' : '⚠️ Not set (auth disabled)'}`);
  console.log(`\n✅ Server ready!\n`);
});