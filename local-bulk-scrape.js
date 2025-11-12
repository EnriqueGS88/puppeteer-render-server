
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
require('dotenv').config();

// __filename and __dirname are available in CommonJS

// -----------------------------------------------------------------------------
// ENV CONFIG
// -----------------------------------------------------------------------------
const INGEST_JOB_URL = process.env.INGEST_JOB_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// -----------------------------------------------------------------------------
// BULK SCRAPING CONFIGURATION (same defaults as server)
// -----------------------------------------------------------------------------
const BULK_SCRAPE_CONFIG = {
  timeFilter: "r7200", // Past 24 hours
  baseUrl: "https://www.linkedin.com/jobs/search/"
};

// -----------------------------------------------------------------------------
// MANUAL CONFIGURATION - Set these before running the script
// -----------------------------------------------------------------------------
const KEYWORDS = ['Product Manager'];
const LOCATIONS = [
  ['Dubai', 106204383],
  ['London', 90009496]
];

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

const LOCAL_TMP_DIR = path.join(__dirname, 'tmp');
ensureDir(LOCAL_TMP_DIR);

async function takeScreenshot(page, filename, description) {
  try {
    if (!page || page.isClosed()) {
      console.warn(`⚠️ Cannot screenshot ${description} - page is closed`);
      return null;
    }
    const filepath = path.join(LOCAL_TMP_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false, timeout: 5000 });
    console.log(`📸 Screenshot saved: ${description} -> ${filepath}`);
    return filepath;
  } catch (error) {
    console.warn(`⚠️ Screenshot failed for ${description}: ${error.message}`);
    return null;
  }
}

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
  } catch (_e) {
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

async function ensureFetch() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Please run with Node 18+ or higher.');
  }
}

async function sendBulkJobsToSupabase(jobs) {
  if (!INGEST_JOB_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('⚠️ Skipping ingest: missing INGEST_JOB_URL or SUPABASE_SERVICE_ROLE_KEY');
    return { inserted: 0, skipped: jobs.length, message: 'Ingest skipped - env not set' };
  }
  await ensureFetch();
  const BULK_INGEST_URL = INGEST_JOB_URL.replace('/ingest-job', '/ingest-scraped-jobs');
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
    throw new Error(`Failed to ingest jobs: ${response.status} - ${errorText}`);
  }
  return response.json();
}

// -----------------------------------------------------------------------------
// CORE BULK-SCRAPE RUNNER (extracted from /bulk-scrape with local-safe defaults)
// -----------------------------------------------------------------------------
async function runBulkScrape({ keywords, locations }) {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    throw new Error('keywords must be a non-empty array');
  }
  if (!locations || Object.keys(locations).length === 0) {
    throw new Error('locations must be a non-empty object mapping locationName -> geoId');
  }

  let browser;
  let page;
  let totalScraped = 0;
  let totalInserted = 0;
  const errors = [];
  const screenshots = [];

  console.log('🔍 Search parameters:', { keywords, locations: Object.keys(locations) });
  console.log(`📊 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used`);

  try {
    browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,720'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      timeout: 60000
    });
    console.log('✅ Puppeteer launched');

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    for (const keyword of keywords) {
      for (const [locationName, geoId] of Object.entries(locations)) {
        const startTime = Date.now();
        let url = '';
        try {
          if (!browser.isConnected()) {
            console.warn('⚠️ Browser disconnected - relaunching...');
            try { await browser.close().catch(() => {}); } catch {}
            browser = await puppeteer.launch({
              headless: true,
              args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1280,720'
              ],
              executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
              timeout: 60000
            });
            page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
          }

          console.log(`\n🔄 [${new Date().toISOString()}] Scraping: "${keyword}" in ${locationName}...`);
          url = buildLinkedInUrl(keyword, locationName, geoId, BULK_SCRAPE_CONFIG.timeFilter);
          console.log(`   URL: ${url}`);

          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

          const immediateScreenshot = await takeScreenshot(
            page,
            `${keyword.replace(/\s+/g, '-')}-${locationName.replace(/\s+/g, '-')}-IMMEDIATE-${Date.now()}.png`,
            'Immediate post-navigation'
          );
          if (immediateScreenshot) screenshots.push(immediateScreenshot);

          await new Promise(resolve => setTimeout(resolve, 2000));

          if (page.isClosed()) throw new Error('Page closed during stability wait');
          if (!browser.isConnected()) throw new Error('Browser disconnected during navigation');

          const currentUrl = page.url();
          if (!currentUrl.includes('linkedin.com/jobs/search')) {
            throw new Error(`Redirected away from jobs page to: ${currentUrl}`);
          }

          const timestamp = Date.now();
          const screenshotFilename = await takeScreenshot(
            page,
            `${keyword.replace(/\s+/g, '-')}-${locationName.replace(/\s+/g, '-')}-initial-${timestamp}.png`,
            'Initial page load'
          );
          if (screenshotFilename) screenshots.push(screenshotFilename);

          // Attempt to close sign-in modal if present
          try {
            const popupDismissButton = await page.waitForSelector('.contextual-sign-in-modal__modal-dismiss-icon', { timeout: 3000 });
            if (popupDismissButton) {
              await popupDismissButton.click();
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (_e) {}

          // Stage 1: container
          await page.waitForSelector('ul.jobs-search__results-list', { timeout: 8000, visible: true });

          console.log('⏳ Waiting for page to stabilize...');
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Stage 2: Check if job cards exist using the same selector as extraction
          // Use evaluate to check count instead of waitForSelector with wrong class
          const jobCardCount = await page.evaluate(() => {
            const elements = document.querySelectorAll('ul.jobs-search__results-list li');
            return elements.length;
          });
          
          console.log(`📊 Found ${jobCardCount} job card(s) in DOM`);

          if (jobCardCount === 0) {
            await takeScreenshot(page, `${keyword.replace(/\s+/g, '-')}-${locationName.replace(/\s+/g, '-')}-no-results-${Date.now()}.png`, 'No jobs found');
            await new Promise(resolve => setTimeout(resolve, 3000));
            throw new Error('No job listings found on page');
          }

          const preScrapeFilename = await takeScreenshot(
            page,
            `${keyword.replace(/\s+/g, '-')}-${locationName.replace(/\s+/g, '-')}-pre-scrape-${timestamp}.png`,
            'Before scraping job data'
          );
          if (preScrapeFilename) screenshots.push(preScrapeFilename);

          // Extract job summaries
          console.log(`🔍 Extracting data from ${jobCardCount} job card(s)...`);
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

                let jobId = '';
                if (rawJobUrl) {
                  try {
                    const url = new URL(rawJobUrl);
                    const idFromPath = url.pathname.match(/\/jobs\/view\/.*?(\d+)/);
                    if (idFromPath && idFromPath[1]) {
                      jobId = idFromPath[1];
                    }
                  } catch (_e) {
                    const idMatch = rawJobUrl.match(/\/jobs\/view\/.*?(\d+)/);
                    if (idMatch) jobId = idMatch[1];
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
              } catch (_err) {}
            });
            return jobListings;
          });

          console.log(`✅ Successfully extracted ${jobs.length} job(s) from ${jobCardCount} card(s)`);

          jobs.forEach(job => {
            if (job.url) job.url = transformJobUrl(job.url);
          });

          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`   ✅ Scraped ${jobs.length} jobs in ${duration}s`);

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

          if (jobsWithMetadata.length > 0) {
            try {
              console.log(`   📤 Sending ${jobsWithMetadata.length} jobs to Supabase...`);
              const ingestResult = await sendBulkJobsToSupabase(jobsWithMetadata);
              totalInserted += ingestResult?.inserted || 0;
              console.log(`   ✅ Inserted: ${ingestResult?.inserted || 0}`);
            } catch (ingestError) {
              console.error(`   ❌ Failed to ingest jobs for ${locationName}: ${ingestError.message}`);
              errors.push({ keyword, location: locationName, type: 'ingest', error: ingestError.message });
            }
          }
        } catch (error) {
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          let pageState = 'unknown';
          let browserState = 'unknown';
          try {
            pageState = page?.isClosed() ? 'closed' : 'open';
            browserState = browser?.isConnected() ? 'connected' : 'disconnected';
          } catch (_e) {
            pageState = 'error checking';
            browserState = 'error checking';
          }
          console.error(`❌ [${new Date().toISOString()}] Error after ${duration}s scraping "${keyword}" in ${locationName}: ${error.message}`);
          console.error(`   📊 Diagnostics: Page=${pageState}, Browser=${browserState}`);
          try {
            if (page && !page.isClosed() && browser.isConnected()) {
              const errorTimestamp = Date.now();
              const errorScreenshot = await takeScreenshot(
                page,
                `${keyword.replace(/\s+/g, '-')}-${locationName.replace(/\s+/g, '-')}-ERROR-${errorTimestamp}.png`,
                `Error: ${error.message}`
              );
              if (errorScreenshot) screenshots.push(errorScreenshot);
            }
          } catch (_se) {}
          errors.push({
            keyword,
            location: locationName,
            error: error.message,
            url: url || 'not generated',
            timestamp: new Date().toISOString(),
            duration: `${duration}s`
          });

          // Recover for next iterations
          if (browserState === 'disconnected' || /Target closed|detached Frame/i.test(error.message)) {
            console.warn('♻️ Recovering from browser crash/disconnect...');
            try { await browser.close().catch(() => {}); } catch {}
            try {
              browser = await puppeteer.launch({
                headless: true,
                args: [
                  '--no-sandbox',
                  '--disable-setuid-sandbox',
                  '--disable-dev-shm-usage',
                  '--disable-gpu',
                  '--window-size=1280,720'
                ],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                timeout: 60000
              });
              page = await browser.newPage();
              await page.setViewport({ width: 1920, height: 1080 });
              await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
              console.log('✅ Browser relaunched successfully');
            } catch (relaunchError) {
              console.error('❌ Failed to relaunch browser:', relaunchError.message);
            }
          }
        }

        const randomDelay = 2000 + Math.random() * 3000;
        console.log(`⏳ Waiting ${Math.round(randomDelay / 1000)}s before next location...`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));
      }
    }
  } finally {
    if (browser) {
      await browser.close();
      console.log('🔒 Browser closed');
    }
  }

  console.log('\n✅ Bulk scraping completed');
  console.log(`   Total jobs scraped: ${totalScraped}`);
  console.log(`   Total jobs inserted: ${totalInserted}`);
  console.log(`   Errors: ${errors.length}`);

  return {
    success: true,
    total_scraped: totalScraped,
    inserted: totalInserted,
    errors: errors.length > 0 ? errors : undefined,
    screenshots,
    screenshot_dir: LOCAL_TMP_DIR
  };
}

module.exports = { runBulkScrape };

// -----------------------------------------------------------------------------
// CLI SUPPORT
// -----------------------------------------------------------------------------
if (require.main === module) {
  // Convert LOCATIONS array to object format expected by runBulkScrape
  const locationsObj = {};
  LOCATIONS.forEach(([name, geoId]) => {
    locationsObj[name] = geoId;
  });

  runBulkScrape({ keywords: KEYWORDS, locations: locationsObj })
    .then(result => {
      console.log('\nResult:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal error:', err.message);
      process.exit(1);
    });
}


