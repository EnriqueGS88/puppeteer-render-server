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

// ============================================================================
// BULK SCRAPING CONFIGURATION
// ============================================================================

const BULK_SCRAPE_CONFIG = {
  // timeFilter: "r24800", // Past 24h
  timeFilter: "r7200", // Past 2h
  baseUrl: "https://www.linkedin.com/jobs/search/"
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function transformJobUrl(jobUrl) {
  if (!jobUrl) return '';
  
  try {
    const u = new URL(jobUrl);
    const idFromPath = u.pathname.match(/\/jobs\/view\/.*-(\d{10,12})(?:[?#]|$)/);
    if (idFromPath && idFromPath[1]) {
      return `${u.origin}/jobs/view/${idFromPath[1]}`;
    }

    const rootMatch = jobUrl.match(/^(https:\/\/[^\/]+)\/jobs\/view\//);
    const idMatch = jobUrl.match(/\/jobs\/view\/.*-(\d{10,12})(?:[?#]|$)/);
    if (rootMatch && idMatch) {
      return `${rootMatch[1]}/jobs/view/${idMatch[1]}`;
    }

    return jobUrl;
  } catch (error) {
    console.error('Error transforming job URL:', error);
    return jobUrl;
  }
}

function buildLinkedInUrl(keyword, locationName, geoId, timeFilter) {
  const params = new URLSearchParams({
    keywords: keyword,
    f_TPR: timeFilter,
    geoId: geoId.toString()
  });
  
  return `${BULK_SCRAPE_CONFIG.baseUrl}?${params.toString()}`;
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

// ============================================================================
// BULK SCRAPE ENDPOINT
// ============================================================================

app.post('/bulk-scrape', validateApiSecret, async (req, res) => {
  console.log(`\n📦 Bulk scrape request received`);
  
  // Extract parameters from request body (REQUIRED)
  const { keywords, locations } = req.body || {};
  
  // Validate required parameters
  if (!keywords || keywords.length === 0) {
    return res.status(400).json({ 
      error: 'Missing required parameter: keywords (must be non-empty array)' 
    });
  }
  
  if (!locations || Object.keys(locations).length === 0) {
    return res.status(400).json({ 
      error: 'Missing required parameter: locations (must be non-empty object)' 
    });
  }
  
  console.log('🔍 Search parameters:', { 
    keywords, 
    locations: Object.keys(locations) 
  });

  let browser;
  let totalScraped = 0;
  let totalInserted = 0;
  const errors = [];

  try {
    console.log(`🚀 Launching Puppeteer for bulk scraping...`);
    console.log(`📊 Initial memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS`);
    
    // Force garbage collection if available
    if (global.gc) {
      console.log(`🧹 Running garbage collection...`);
      global.gc();
    }
    
    console.log(`📊 Memory before launch: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-tools',
        '--disable-extensions',
        '--no-first-run',
        '--no-zygote',  // Critical for low memory
        '--single-process',  // Run in single process (saves ~100MB)
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--window-size=1024,600',  // Smaller viewport = less memory
        '--disable-features=IsolateOrigins,site-per-process'  // Reduce memory overhead
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      timeout: 60000  // 60 second timeout for launch
    });

    console.log(`✅ Puppeteer launched successfully`);
    console.log(`📊 Memory after launch: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 600 });  // Reduced viewport for memory savings
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Loop through locations × keywords
    for (const keyword of keywords) {
      for (const [locationName, geoId] of Object.entries(locations)) {
        // Phase 9: Safety - Check memory before each iteration
        const currentMem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        if (currentMem > 450) {
          console.error(`❌ Memory limit reached (${currentMem}MB), stopping scrape`);
          break; // Exit keyword loop
        }
        try {
          console.log(`\n🔄 Scraping: "${keyword}" in ${locationName}...`);
          
          const url = buildLinkedInUrl(keyword, locationName, geoId, BULK_SCRAPE_CONFIG.timeFilter);
          console.log(`   URL: ${url}`);
          
          // Navigate to the LinkedIn URL
          await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
          });

          // Close popup if it appears
          try {
            const popupDismissButton = await page.waitForSelector('.contextual-sign-in-modal__modal-dismiss-icon', { timeout: 3000 });
            if (popupDismissButton) {
              await popupDismissButton.click();
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (error) {
            // No popup, continue
          }
          
          // Extract job data (SUMMARY ONLY - no full details)
          const jobs = await page.evaluate(() => {
            const jobListings = [];
            const jobElements = document.querySelectorAll('ul.jobs-search__results-list li');
            
            jobElements.forEach((jobElement, index) => {
              try {
                const titleElement = jobElement.querySelector('h3.base-search-card__title');
                const jobTitle = titleElement ? titleElement.innerText.trim() : '';

                const companyElement = jobElement.querySelector('h4.base-search-card__subtitle');
                const company = companyElement ? companyElement.innerText.trim() : '';

                const locationElement = jobElement.querySelector('span.job-search-card__location');
                const location = locationElement ? locationElement.innerText.trim() : '';

                const linkElement = jobElement.querySelector('a.base-card__full-link');
                const rawJobUrl = linkElement ? linkElement.href : '';
                
                const imgElement = jobElement.querySelector('img[data-ghost-classes="artdeco-entity-image--ghost"]');
                const imgUrl = imgElement ? imgElement.src : '';
                
                const timeElement = jobElement.querySelector('time.job-search-card__listdate--new');
                const postingDate = timeElement ? timeElement.getAttribute('datetime') : '';
                const postingTimeRelative = timeElement ? timeElement.innerText.trim() : '';
                
                // Extract job ID from URL
                let jobId = '';
                if (rawJobUrl) {
                  try {
                    const url = new URL(rawJobUrl);
                    const idFromPath = url.pathname.match(/\/jobs\/view\/.*?(\d+)/);
                    if (idFromPath && idFromPath[1]) {
                      jobId = idFromPath[1];
                    }
                  } catch (error) {
                    const idMatch = rawJobUrl.match(/\/jobs\/view\/.*?(\d+)/);
                    if (idMatch) {
                      jobId = idMatch[1];
                    }
                  }
                }
                
                if (jobTitle && jobId) {
                  jobListings.push({
                    job_id: jobId,
                    job_title: jobTitle,
                    company: company,
                    location: location,
                    url: rawJobUrl,
                    img_url: imgUrl,
                    posting_date: postingDate,
                    posting_time_relative: postingTimeRelative
                  });
                }
              } catch (error) {
                console.error(`Error processing job ${index + 1}:`, error);
              }
            });
            
            return jobListings;
          });

          // Transform URLs
          jobs.forEach(job => {
            if (job.url) {
              job.url = transformJobUrl(job.url);
            }
          });

          console.log(`   ✅ Scraped ${jobs.length} jobs`);
          
          // Phase 8: Memory monitoring
          const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          console.log(`   📊 Memory: ${memUsage}MB`);
          
          // Warn if approaching limits
          if (memUsage > 400) {
            console.warn(`   ⚠️ High memory usage: ${memUsage}MB`);
          }

          // Add metadata to each job
          const jobsWithMetadata = jobs.map(job => ({
            ...job,
            scrape_metadata: {
              keyword: keyword,
              location: locationName,
              geoId: geoId,
              timeFilter: BULK_SCRAPE_CONFIG.timeFilter,
              scraped_at: new Date().toISOString()
            }
          }));

          totalScraped += jobsWithMetadata.length;

          // POST jobs immediately after scraping this location
          if (jobsWithMetadata.length > 0) {
            try {
              console.log(`   📤 Sending ${jobsWithMetadata.length} jobs to Supabase...`);
              const ingestResult = await sendBulkJobsToSupabase(jobsWithMetadata);
              totalInserted += ingestResult?.inserted || 0;
              console.log(`   ✅ Inserted: ${ingestResult?.inserted || 0}`);
            } catch (ingestError) {
              console.error(`   ❌ Failed to ingest jobs for ${locationName}: ${ingestError.message}`);
              // Phase 6: Error array management - limit error detail size
              errors.push({
                keyword,
                location: locationName,
                type: 'ingest',
                error: ingestError.message.substring(0, 200) // Limit error message length
              });
              
              // Limit total errors stored
              if (errors.length > 50) {
                errors.shift(); // Remove oldest error
              }
            }
          }

          // Delay between requests to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 5000));

        } catch (error) {
          console.error(`❌ Error scraping "${keyword}" in ${locationName}:`, error.message);
          errors.push({
            keyword,
            location: locationName,
            error: error.message
          });
        }
      }
      
      // Phase 7: Force garbage collection between keywords
      if (global.gc) {
        global.gc();
        console.log(`🧹 GC after keyword "${keyword}"`);
      }
    }

    console.log(`\n✅ Bulk scraping completed`);
    console.log(`   Total jobs scraped: ${totalScraped}`);
    console.log(`   Total jobs inserted: ${totalInserted}`);
    console.log(`   Errors: ${errors.length}`);

    res.json({
      success: true,
      total_scraped: totalScraped,
      inserted: totalInserted,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.error('❌ Bulk scraping error:', error.message);
    console.error(`📊 Memory at crash: ${memoryUsage}MB`);
    
    // Enhanced error context for debugging
    const errorContext = error.message.includes('launch') 
      ? `Browser launch failed (Memory: ${memoryUsage}MB)`
      : `/bulk-scrape endpoint - Keywords: ${JSON.stringify(keywords)}, Locations: ${JSON.stringify(locationIds || Object.keys(locations))}`;
    
    await sendErrorAlert(
      errorContext,
      `${error.message}\n\nMemory: ${memoryUsage}MB\n\nStack: ${error.stack?.substring(0, 500)}`
    );
    
    res.status(500).json({
      error: error.message,
      details: error.stack
    });
  } finally {
    if (browser) {
      await browser.close();
      console.log(`🔒 Browser closed`);
    }
  }
});

// ============================================================================
// MAIN SCRAPING ENDPOINT
// ============================================================================

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
      jobData: jobData.jobData || jobData,
      job: jobData.job
    });

  } catch (error) {
    console.error('❌ Scraping error:', error.message);
    
    // Send Telegram error alert
    await sendErrorAlert(
      `/scrape endpoint - URL: ${url}`,
      `${error.message}\n\nStack: ${error.stack?.substring(0, 500)}`
    );
    
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
    const ingestResult = await sendToIngestJob(jobData);

    return {
      ...jobData,
      job: ingestResult.job
    };

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

// Send bulk scraped jobs to ingest-scraped-jobs edge function
async function sendBulkJobsToSupabase(jobs) {
  const BULK_INGEST_URL = INGEST_JOB_URL.replace('/ingest-job', '/ingest-scraped-jobs');
  
  try {
    console.log(`📤 Posting ${jobs.length} jobs to Supabase edge function...`);
    console.log(`🎯 URL: ${BULK_INGEST_URL}`);
    
    const response = await fetch(BULK_INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY
      },
      body: JSON.stringify({ jobs })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Bulk ingest error: ${response.status} - ${errorText}`);
      throw new Error(`Failed to ingest jobs: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`✅ Successfully posted ${jobs.length} jobs to Supabase`);
    console.log(`   Inserted: ${result.inserted || 0}`);
    return result;

  } catch (error) {
    console.error('Error sending bulk jobs to Supabase:', error.message);
    throw error;
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

// Send error notifications to admin Telegram bot
async function sendErrorAlert(errorContext, errorDetails) {
  const ERROR_BOT_TOKEN = process.env.ERROR_ALERT_BOT_TOKEN;
  const ERROR_CHAT_ID = process.env.ERROR_ALERT_CHAT_ID;
  
  if (!ERROR_BOT_TOKEN || !ERROR_CHAT_ID) {
    console.warn('⚠️ Error alerts not configured (missing ERROR_ALERT_BOT_TOKEN or ERROR_ALERT_CHAT_ID)');
    return;
  }
  
  try {
    const timestamp = new Date().toISOString();
    const message = `
🚨 *Scraping Error Alert*

⏰ Time: ${timestamp}
📍 Context: ${errorContext}

❌ Error Details:
\`\`\`
${errorDetails}
\`\`\`

🔗 Check logs: https://dashboard.render.com
    `.trim();
    
    await fetch(`https://api.telegram.org/bot${ERROR_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ERROR_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
    
    console.log('✅ Error alert sent to Telegram');
  } catch (telegramError) {
    console.error('❌ Failed to send Telegram error alert:', telegramError.message);
    // Don't throw - we don't want error notification to break the main flow
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