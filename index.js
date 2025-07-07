const puppeteer = require('puppeteer');
const cron = require('cron');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

class PerplexityBot {
  constructor() {
    this.browser = null;
    this.page = null;
    this.csvPath = path.join(__dirname, 'finance_data.csv');
    this.prompt = `Search Finance websites for newly published articles, and using at least 10 sources compile a list of 10 small-cap stocks under $2 billion market cap that have been discussed with positive sentiment within the last 3 days - List the tickers, company name, and market cap`;
  }

  async initBrowser() {
    console.log('Initializing browser...');
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
    this.page = await this.browser.newPage();
    
    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('Browser initialized successfully');
  }

  async queryPerplexity() {
    try {
      console.log('Navigating to Perplexity...');
      await this.page.goto('https://www.perplexity.ai/', { 
        waitUntil: 'networkidle2',
        timeout: 30000 
      });

      await this.page.waitForSelector('textarea[placeholder*="Ask"]', { timeout: 10000 });
      
      console.log('Entering query...');
      await this.page.type('textarea[placeholder*="Ask"]', this.prompt);
      
      await this.page.keyboard.press('Enter');
      
      console.log('Waiting for response...');
      await this.page.waitForTimeout(15000);
      
      const responseText = await this.page.evaluate(() => {
        const selectors = [
          '[data-testid="copilot-answer"]',
          '.prose',
          '[class*="answer"]',
          '[class*="response"]',
          'main div div div div p',
          'div[class*="prose"] p'
        ];
        
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            return Array.from(elements).map(el => el.textContent).join('\n');
          }
        }
        
        const paragraphs = document.querySelectorAll('main p, main div[class*="text"]');
        return Array.from(paragraphs).map(p => p.textContent).join('\n');
      });

      console.log('Response extracted, length:', responseText.length);
      return responseText;
      
    } catch (error) {
      console.error('Error querying Perplexity:', error);
      throw error;
    }
  }

  parseStockData(responseText) {
    console.log('Parsing stock data...');
    const stocks = [];
    
    const patterns = [
      /([A-Z]{1,5})\s*\(([^)]+)\)[^$]*\$([0-9.]+)\s*billion/gi,
      /([^(]+)\s*\(([A-Z]{1,5})\)[^$]*\$([0-9.]+)\s*billion/gi,
      /([A-Z]{1,5}):\s*([^-]+)\s*-[^$]*\$([0-9.]+)\s*billion/gi,
      /(?=.*([A-Z]{2,5}))(?=.*\$([0-9.]+)\s*billion)(.+)/gi
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(responseText)) !== null && stocks.length < 15) {
        let ticker, company, marketCap;
        
        if (pattern.source.includes('(?=.*')) {
          const line = match[3];
          const tickerMatch = line.match(/\b([A-Z]{2,5})\b/);
          const capMatch = line.match(/\$([0-9.]+)\s*billion/);
          
          if (tickerMatch && capMatch) {
            ticker = tickerMatch[1];
            marketCap = capMatch[1];
            company = line.replace(/\([^)]*\)/g, '').replace(/\$[0-9.]+\s*billion/g, '').trim();
          }
        } else {
          ticker = match[1]?.trim();
          company = match[2]?.trim();
          marketCap = match[3]?.trim();
        }

        if (ticker && company && marketCap && parseFloat(marketCap) <= 2.0) {
          ticker = ticker.replace(/[^A-Z]/g, '');
          company = company.replace(/^\d+\.\s*/, '').trim();
          
          if (!stocks.find(s => s.ticker === ticker)) {
            stocks.push({
              ticker,
              company: company.substring(0, 50),
              marketCap: `$${marketCap}B`,
              extractedAt: new Date().toISOString()
            });
          }
        }
      }
    }

    if (stocks.length < 5) {
      console.log('Attempting fallback parsing...');
      const lines = responseText.split('\n');
      
      for (const line of lines) {
        if (stocks.length >= 10) break;
        
        const tickerMatch = line.match(/\b([A-Z]{2,5})\b/);
        const capMatch = line.match(/\$([0-9.]+)\s*billion/i);
        
        if (tickerMatch && capMatch && parseFloat(capMatch[1]) <= 2.0) {
          const ticker = tickerMatch[1];
          const marketCap = capMatch[1];
          
          if (!stocks.find(s => s.ticker === ticker)) {
            stocks.push({
              ticker,
              company: `Company for ${ticker}`,
              marketCap: `$${marketCap}B`,
              extractedAt: new Date().toISOString()
            });
          }
        }
      }
    }

    console.log(`Parsed ${stocks.length} stocks`);
    return stocks;
  }

  async saveToCSV(stocks) {
    console.log('Saving to CSV...');
    
    const csvWriter = createCsvWriter({
      path: this.csvPath,
      header: [
        { id: 'ticker', title: 'Ticker' },
        { id: 'company', title: 'Company Name' },
        { id: 'marketCap', title: 'Market Cap' },
        { id: 'extractedAt', title: 'Extracted At' }
      ],
      append: true
    });

    await csvWriter.writeRecords(stocks);
    console.log(`Saved ${stocks.length} records to CSV`);
  }

  async runQuery() {
    try {
      console.log(`\n=== Starting query run at ${new Date().toISOString()} ===`);
      
      if (!this.browser) {
        await this.initBrowser();
      }

      const responseText = await this.queryPerplexity();
      
      if (!responseText || responseText.length < 100) {
        throw new Error('Response too short or empty');
      }

      const stocks = this.parseStockData(responseText);
      
      if (stocks.length > 0) {
        await this.saveToCSV(stocks);
        console.log('Query completed successfully');
        return { success: true, stockCount: stocks.length, stocks };
      } else {
        console.log('No stocks found in response');
        return { success: false, error: 'No stocks extracted' };
      }
      
    } catch (error) {
      console.error('Error in runQuery:', error);
      
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      
      return { success: false, error: error.message };
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

const bot = new PerplexityBot();

const job = new cron.CronJob(
  '0 */6 * * *',
  async () => {
    await bot.runQuery();
  },
  null,
  true,
  'America/New_York'
);

app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    nextRun: job.nextDate().toString(),
    csvPath: bot.csvPath 
  });
});

app.get('/run-now', async (req, res) => {
  const result = await bot.runQuery();
  res.json(result);
});

app.get('/download-csv', (req, res) => {
  if (fs.existsSync(bot.csvPath)) {
    res.download(bot.csvPath);
  } else {
    res.status(404).json({ error: 'CSV file not found' });
  }
});

app.get('/status', (req, res) => {
  const stats = {
    nextScheduledRun: job.nextDate().toString(),
    csvExists: fs.existsSync(bot.csvPath),
    lastModified: fs.existsSync(bot.csvPath) ? 
      fs.statSync(bot.csvPath).mtime.toISOString() : null
  };
  res.json(stats);
});

setTimeout(async () => {
  console.log('Running initial query...');
  await bot.runQuery();
}, 5000);

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  job.stop();
  await bot.cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  job.stop();
  await bot.cleanup();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Next scheduled run: ${job.nextDate()}`);
});

console.log('Finance bot started. Scheduled to run every 6 hours.');
