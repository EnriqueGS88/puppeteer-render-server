
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
require('dotenv').config();

// -----------------------------------------------------------------------------
// LINKEDIN SELECTORS (update here when LinkedIn changes their DOM)
// -----------------------------------------------------------------------------
const SELECTORS = {
  signInModal: '.contextual-sign-in-modal__modal-dismiss-icon',
  jobListContainer: 'ul.jobs-search__results-list',
  jobCard: 'ul.jobs-search__results-list li',
  jobTitle: 'h3.base-search-card__title',
  company: 'h4.base-search-card__subtitle',
  location: 'span.job-search-card__location',
  jobLink: 'a.base-card__full-link',
  companyImage: 'img[data-ghost-classes="artdeco-entity-image--ghost"]',
  postingDate: 'time.job-search-card__listdate--new'
};

// -----------------------------------------------------------------------------
// SCRAPER CONFIGURATION
// -----------------------------------------------------------------------------
const SCRAPER_CONFIG = {
  baseUrl: 'https://www.linkedin.com/jobs/search/',
  timeFilter: 'r7200',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 720 },
  recoveryViewport: { width: 1920, height: 1080 },
  timeouts: {
    navigation: 20000,
    jobList: 8000,
    signInModal: 3000
  },
  delays: {
    postNavigation: 2000,
    pageStabilize: 3000,
    signInDismiss: 1000,
    betweenLocations: { min: 2000, max: 5000 },
    zeroResultsExtra: 3000
  },
  browser: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,720'
    ],
    timeout: 60000,
    initialHeadless: false,
    recoveryHeadless: true
  }
};

// -----------------------------------------------------------------------------
// ENV CONFIG
// -----------------------------------------------------------------------------
const INGEST_JOB_URL = process.env.INGEST_JOB_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// -----------------------------------------------------------------------------
// MANUAL CONFIGURATION - Set these before running the script
// -----------------------------------------------------------------------------
const SCRAPE_KEYWORDS = {
  primary: ['Product Manager']
};

const SCRAPE_LOCATIONS = {
  // Dubai: 106204383,
  // London: 90009496,
  // Singapore: 102454443,
  // Geneva: 104406358,
  // Zurich: 102436504,
  // Bern: 104691271,
  // Dublin: 105178154,
  Berlin: 105178154,
  // Tallinn: 104199723,
  // 'San Francisco': 90000084,
  //Amsterdam: 90010383,
  //Utrecht: 100163908,
  Luxembourg: 104042105
};

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

function sanitize(value) {
  return String(value).trim().replace(/\s+/g, '-');
}

function formatScreenshotName(keyword, location, tag, timestamp = Date.now()) {
  return `${sanitize(keyword)}-${sanitize(location)}-${tag}-${timestamp}.png`;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function captureAndStore(page, filename, description, store) {
  const filepath = await takeScreenshot(page, filename, description);
  if (filepath) {
    store.push(filepath);
  }
  return filepath;
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

function buildLinkedInUrl(keyword, geoId) {
  const params = new URLSearchParams({
    keywords: keyword,
    f_TPR: SCRAPER_CONFIG.timeFilter,
    geoId: geoId.toString()
  });
  return `${SCRAPER_CONFIG.baseUrl}?${params.toString()}`;
}

function normalizeKeywords(config) {
  if (Array.isArray(config)) {
    return config.filter(Boolean);
  }
  if (config && typeof config === 'object') {
    return Object.values(config)
      .flatMap(value => (Array.isArray(value) ? value : [value]))
      .map(value => (value ?? '').toString().trim())
      .filter(Boolean);
  }
  throw new Error('keywords configuration must be an array or an object of arrays/strings');
}

function normalizeLocations(config) {
  const toNumber = (val) => {
    const num = Number(val);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid geoId value: ${val}`);
    }
    return num;
  };

  if (Array.isArray(config)) {
    return config.reduce((acc, entry) => {
      if (!entry || entry.length < 2) {
        return acc;
      }
      const [name, geoId] = entry;
      if (!name) return acc;
      acc[name] = toNumber(geoId);
      return acc;
    }, {});
  }

  if (config && typeof config === 'object') {
    const entries = Object.entries(config).filter(([, geoId]) => geoId !== undefined && geoId !== null);
    if (entries.length === 0) {
      throw new Error('locations configuration must contain at least one entry');
    }
    return entries.reduce((acc, [name, geoId]) => {
      if (!name) {
        return acc;
      }
      acc[name] = toNumber(geoId);
      return acc;
    }, {});
  }

  throw new Error('locations configuration must be an object or an array of [name, geoId] pairs');
}

async function launchBrowser(headless) {
  return puppeteer.launch({
    headless,
    args: SCRAPER_CONFIG.browser.args,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    timeout: SCRAPER_CONFIG.browser.timeout
  });
}

async function setupPage(page, viewport = SCRAPER_CONFIG.viewport) {
  await page.setViewport(viewport);
  await page.setUserAgent(SCRAPER_CONFIG.userAgent);
}

async function closeSignInModal(page) {
  try {
    const dismissButton = await page.waitForSelector(SELECTORS.signInModal, {
      timeout: SCRAPER_CONFIG.timeouts.signInModal
    });
    if (dismissButton) {
      await dismissButton.click();
      await wait(SCRAPER_CONFIG.delays.signInDismiss);
    }
  } catch (_e) {}
}

async function extractJobs(page) {
  return page.evaluate((selectors) => {
    const jobListings = [];
    const jobElements = document.querySelectorAll(selectors.jobCard);

    jobElements.forEach((jobElement) => {
      try {
        const titleElement = jobElement.querySelector(selectors.jobTitle);
        const jobTitle = titleElement ? titleElement.innerText.trim() : '';
        const companyElement = jobElement.querySelector(selectors.company);
        const company = companyElement ? companyElement.innerText.trim() : '';
        const locationElement = jobElement.querySelector(selectors.location);
        const location = locationElement ? locationElement.innerText.trim() : '';
        const linkElement = jobElement.querySelector(selectors.jobLink);
        const rawJobUrl = linkElement ? linkElement.href : '';
        const imgElement = jobElement.querySelector(selectors.companyImage);
        const imgUrl = imgElement ? imgElement.src : '';
        const timeElement = jobElement.querySelector(selectors.postingDate);
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
            company,
            location,
            url: rawJobUrl,
            img_url: imgUrl,
            posting_date: postingDate,
            posting_time_relative: postingTimeRelative
          });
        }
      } catch (_err) {}
    });

    return jobListings;
  }, SELECTORS);
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
      apikey: SUPABASE_SERVICE_ROLE_KEY
    },
    body: JSON.stringify({ jobs })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to ingest jobs: ${response.status} - ${errorText}`);
  }

  return response.json();
}

async function scrapeLocation({
  browser,
  page,
  keyword,
  locationName,
  geoId,
  screenshots
}) {
  const startTime = Date.now();
  let url = '';

  try {
    if (!browser.isConnected()) {
      throw new Error('Browser disconnected');
    }

    console.log(`\n🔄 [${new Date().toISOString()}] Scraping: "${keyword}" in ${locationName}...`);
    url = buildLinkedInUrl(keyword, geoId);
    console.log(`   URL: ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SCRAPER_CONFIG.timeouts.navigation });

    await captureAndStore(
      page,
      formatScreenshotName(keyword, locationName, 'IMMEDIATE'),
      'Immediate post-navigation',
      screenshots
    );

    await wait(SCRAPER_CONFIG.delays.postNavigation);

    if (page.isClosed()) throw new Error('Page closed during stability wait');
    if (!browser.isConnected()) throw new Error('Browser disconnected during navigation');

    const currentUrl = page.url();
    if (!currentUrl.includes('linkedin.com/jobs/search')) {
      throw new Error(`Redirected away from jobs page to: ${currentUrl}`);
    }

    const timestamp = Date.now();
    await captureAndStore(
      page,
      formatScreenshotName(keyword, locationName, 'initial', timestamp),
      'Initial page load',
      screenshots
    );

    await closeSignInModal(page);
    await page.waitForSelector(SELECTORS.jobListContainer, {
      timeout: SCRAPER_CONFIG.timeouts.jobList,
      visible: true
    });

    console.log('⏳ Waiting for page to stabilize...');
    await wait(SCRAPER_CONFIG.delays.pageStabilize);

    const jobCardCount = await page.evaluate((selector) => {
      return document.querySelectorAll(selector).length;
    }, SELECTORS.jobCard);

    console.log(`📊 Found ${jobCardCount} job card(s) in DOM`);

    if (jobCardCount === 0) {
      await captureAndStore(
        page,
        formatScreenshotName(keyword, locationName, 'no-results'),
        'No jobs found',
        screenshots
      );
      await wait(SCRAPER_CONFIG.delays.zeroResultsExtra);
      throw new Error('No job listings found on page');
    }

    await captureAndStore(
      page,
      formatScreenshotName(keyword, locationName, 'pre-scrape', timestamp),
      'Before scraping job data',
      screenshots
    );

    console.log(`🔍 Extracting data from ${jobCardCount} job card(s)...`);
    const jobs = await extractJobs(page);
    console.log(`✅ Successfully extracted ${jobs.length} job(s) from ${jobCardCount} card(s)`);

    jobs.forEach(job => {
      if (job.url) {
        job.url = transformJobUrl(job.url);
      }
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✅ Scraped ${jobs.length} jobs in ${duration}s`);

    return {
      jobs: jobs.map(job => ({
        ...job,
        scrape_metadata: {
          keyword,
          location: locationName,
          geoId,
          timeFilter: SCRAPER_CONFIG.timeFilter,
          scraped_at: new Date().toISOString()
        }
      })),
      duration
    };
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
      if (page && !page.isClosed() && browser && browser.isConnected()) {
        await captureAndStore(
          page,
          formatScreenshotName(keyword, locationName, 'ERROR'),
          `Error: ${error.message}`,
          screenshots
        );
      }
    } catch (_se) {}

    throw { error, url, duration, pageState, browserState };
  }
}

async function recoverBrowser(currentBrowser) {
  try {
    await currentBrowser?.close().catch(() => {});
  } catch (_e) {}

  try {
    const browser = await launchBrowser(SCRAPER_CONFIG.browser.recoveryHeadless);
    const page = await browser.newPage();
    await setupPage(page, SCRAPER_CONFIG.recoveryViewport);
    console.log('✅ Browser relaunched successfully');
    return { browser, page };
  } catch (relaunchError) {
    console.error('❌ Failed to relaunch browser:', relaunchError.message);
    throw relaunchError;
  }
}

// -----------------------------------------------------------------------------
// MAIN SCRAPER FUNCTION
// -----------------------------------------------------------------------------
async function runBulkScrape({ keywords, locations }) {
  const keywordList = normalizeKeywords(keywords);
  const locationMap = normalizeLocations(locations);

  if (keywordList.length === 0) {
    throw new Error('keywords must contain at least one entry');
  }
  if (Object.keys(locationMap).length === 0) {
    throw new Error('locations must contain at least one entry');
  }

  let browser;
  let page;
  let totalScraped = 0;
  let totalInserted = 0;
  const errors = [];
  const screenshots = [];

  console.log('🔍 Search parameters:', { keywords: keywordList, locations: Object.keys(locationMap) });
  console.log(`📊 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used`);

  try {
    browser = await launchBrowser(SCRAPER_CONFIG.browser.initialHeadless);
    console.log('✅ Puppeteer launched');
    page = await browser.newPage();
    await setupPage(page);

    for (const keyword of keywordList) {
      for (const [locationName, geoId] of Object.entries(locationMap)) {
        try {
          if (!browser.isConnected()) {
            console.warn('⚠️ Browser disconnected - relaunching...');
            ({ browser, page } = await recoverBrowser(browser));
          }

          const result = await scrapeLocation({ browser, page, keyword, locationName, geoId, screenshots });
          totalScraped += result.jobs.length;

          if (result.jobs.length > 0) {
            try {
              console.log(`   📤 Sending ${result.jobs.length} jobs to Supabase...`);
              const ingestResult = await sendBulkJobsToSupabase(result.jobs);
              totalInserted += ingestResult?.inserted || 0;
              console.log(`   ✅ Inserted: ${ingestResult?.inserted || 0}`);
            } catch (ingestError) {
              console.error(`   ❌ Failed to ingest jobs for ${locationName}: ${ingestError.message}`);
              errors.push({ keyword, location: locationName, type: 'ingest', error: ingestError.message });
            }
          }
        } catch (scrapeError) {
          const errorMessage = scrapeError.error?.message || scrapeError.message || 'Unknown error';
          errors.push({
            keyword,
            location: locationName,
            error: errorMessage,
            url: scrapeError.url || 'not generated',
            timestamp: new Date().toISOString(),
            duration: scrapeError.duration || 'unknown'
          });

          if (scrapeError.browserState === 'disconnected' || /Target closed|detached Frame/i.test(errorMessage)) {
            console.warn('♻️ Recovering from browser crash/disconnect...');
            try {
              ({ browser, page } = await recoverBrowser(browser));
            } catch (recoverError) {
              console.error('❌ Failed to recover browser:', recoverError.message);
            }
          }
        }

        const delayMs = randomBetween(
          SCRAPER_CONFIG.delays.betweenLocations.min,
          SCRAPER_CONFIG.delays.betweenLocations.max
        );
        console.log(`⏳ Waiting ${Math.round(delayMs / 1000)}s before next location...`);
        await wait(delayMs);
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
// ENTRY POINT
// -----------------------------------------------------------------------------
if (require.main === module) {
  runBulkScrape({ keywords: SCRAPE_KEYWORDS, locations: SCRAPE_LOCATIONS })
    .then(result => {
      console.log('\nResult:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal error:', err.message);
      process.exit(1);
    });
}





