import express from 'express';
// import puppeteer from 'puppeteer';
import type { Report } from "./engine-types/v4/api/IReport";
import { Request, Response, NextFunction } from 'express';
import { aceCheck, initializePagePool, closePagePool } from './aceChecker';
import bodyParser from 'body-parser';
import * as puppeteer from 'puppeteer';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true}));
const PORT = process.env.PORT || 3000;
const DEFAULT_ID = 'WCAG_2_1';
const DEFAULT_REPORT_LEVELS = ['violation', 'potentialviolation', 'manual'];
app.use(bodyParser.json());
let browser: puppeteer.Browser;

let redis: Redis | undefined;
const SCAN_QUEUE = 'scan_queue';

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/**
 * The main scan endpoint that takes in the HTML content and the guideline IDs to scan against.
 * @param {string} html - The HTML content to scan.
 * @param {string | string[]} guidelineIds - The guideline IDs to scan against.
    * Can be: WCAG_2_1, WCAG_2_2, WCAG_2_0, IBM_Accessibility, IBM_Accessibility_Next
    * See the full list of guideline IDs at /ace-engine/src/v4/ruleset.ts
 * @returns {Object} - JSON response with statusCode and body containing the scan results.
 * @example
 * {
 * "html": "<!DOCTYPE html><html><head><title>Test</title></head><body>Hello World</body></html>",
 * "guidelineIds": ["WCAG_2_2"]
}
 */
app.post("/scan", asyncHandler(async (req, res) => {
  const html: string = req.body.html;
  const guidelineIds: string | string[] = req.body.guidelineIds || DEFAULT_ID;
  const reportLevels: string | string[] = req.body.reportLevels || DEFAULT_REPORT_LEVELS;
  const report: Report = await aceCheck(html, browser, guidelineIds, reportLevels);

  // Modified to match Lambda output format
  res.status(200).json(report);
}));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

async function pollRedisQueue() {
  if (!redis) return;
  while (true) {
    try {
      // pop message from scan queue
      const result = await redis.blpop(SCAN_QUEUE, 0);
      const message = result ? result[1] : null;

      if (message) {
        const { scanId, uuid, html, guidelineIds, reportLevels } = JSON.parse(message);
        try {
          const report: Report = await aceCheck(html, browser, guidelineIds || DEFAULT_ID, reportLevels || DEFAULT_REPORT_LEVELS);
          const resultKey = `result:${scanId}:${uuid}`;
          // set result in the Redis queue with an expiration time of 10 minutes
          await redis.set(
            resultKey,
            JSON.stringify(report),
            'EX', 600
          );

          console.log(`Stored result: ${resultKey}`);
        } 
        catch (err: any) {
          console.error("Error scanning page:", err);
          if (err instanceof puppeteer.TimeoutError) {
            console.log("Attempting to requeue...");
            await redis.rpush(SCAN_QUEUE, message);
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    catch (err) {
      console.error("Error processing message from Redis queue:", err);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

(async () => {
  try {
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      headless: true,
    });
    await initializePagePool(browser, 5);

    // if REDIS_URL is set, then only start redis queue polling
    if (process.env.REDIS_URL) {
      redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
      console.log("REDIS_URL set, starting Redis queue polling...");
      pollRedisQueue();
    }
    else {
      console.log(`Starting server on port ${PORT}...`);
      app.listen(PORT, () => {});
    }
    
  } catch (err) {
    console.error("Error launching Puppeteer:", err);
    process.exit(1);
  }
})();

process.on('SIGINT', async () => {
  await closePagePool();
  if (browser) {
    await browser.close();
  }
  process.exit();
});
