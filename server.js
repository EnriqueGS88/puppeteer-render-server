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
  locations: {
    "Dubai": 106204383,
    "Bern": 104691271,
    "London": 90009496,
  },
  keywords: ["Product Manager"],
  timeFilter: "r604800", // Past 7 days
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

  let browser;
  const allScrapedJobs = [];
  const errors = [];

  try {
    console.log(`🚀 Launching Puppeteer for bulk scraping...`);
    
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

    // Loop through locations × keywords
    for (const keyword of BULK_SCRAPE_CONFIG.keywords) {
      for (const [locationName, geoId] of Object.entries(BULK_SCRAPE_CONFIG.locations)) {
        try {
          console.log(`\n🔄 Scraping: "${keyword}" in ${locationName}...`);
          
          const url = buildLinkedInUrl(keyword, locationName, geoId, BULK_SCRAPE_CONFIG.timeFilter);
          console.log(`   URL: ${url}`);
          
          await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
          });

          // Close popup if it appears
          try {
            const popupDismissButton = await page.waitForSelector('.contextual-sign-in-modal__modal-dismiss-icon', { timeout: 3000 });
            if (popupDismissButton) {
              await popupDismissButton.click();
              await page.waitForTimeout(1000);
            }
          } catch (error) {
            // No popup, continue
          }

          // Wait for job listings
          await page.waitForSelector('ul.jobs-search__results-list', { timeout: 10000 });
          
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

          // Add metadata to each job
          jobs.forEach(job => {
            allScrapedJobs.push({
              ...job,
              scrape_metadata: {
                keyword: keyword,
                location: locationName,
                geoId: geoId,
                timeFilter: BULK_SCRAPE_CONFIG.timeFilter,
                scraped_at: new Date().toISOString()
              }
            });
          });

          // Delay between requests to avoid rate limiting
          await page.waitForTimeout(5000);

        } catch (error) {
          console.error(`❌ Error scraping "${keyword}" in ${locationName}:`, error.message);
          errors.push({
            keyword,
            location: locationName,
            error: error.message
          });
        }
      }
    }

    console.log(`\n✅ Bulk scraping completed`);
    console.log(`   Total jobs scraped: ${allScrapedJobs.length}`);
    console.log(`   Errors: ${errors.length}`);

    res.json({
      success: true,
      total_scraped: allScrapedJobs.length,
      jobs: allScrapedJobs,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('❌ Bulk scraping error:', error.message);
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
