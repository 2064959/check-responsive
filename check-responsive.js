#!/usr/bin/env node

/**
 * Check-Responsive 🚀
 * Flutter-style pixel-precise overflow detection.
 * Automatically finds, starts, and waits for your dev server.
 */

const { chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const { program } = require('commander');
const net = require('net');
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

const COMMON_PORTS = [5173, 3000, 5174, 8080, 3001, 4000, 5000];
const START_COMMANDS = ['dev', 'start', 'serve'];

program
  .name('check-responsive')
  .description('Automated pixel-precise overflow detection tool.')
  .version(pkg.version)
  .argument('[url]', 'Target URL to test (optional, will auto-detect dev servers if omitted)')
  .option('-c, --crawl', 'Crawl the site to find multiple routes and test them all')
  .option('-s, --subroutes', 'Restrict crawler to only scan sub-paths (kids) of the target URL')
  .option('-d, --depth <number>', 'Maximum link depth for crawling', '10')
  .option('-w, --wait <ms>', 'Additional delay (in ms) to wait for animations after load', '500')
  .parse(process.argv);

const options = program.opts();
const positionalUrl = program.args[0];

/**
 * Checks if a port is in use.
 */
function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.connect({ port, host: 'localhost' }, () => {
      server.destroy();
      resolve(true);
    });
    server.on('error', () => {
      resolve(false);
    });
    server.setTimeout(200);
    server.on('timeout', () => {
      server.destroy();
      resolve(false);
    });
  });
}

/**
 * Waits for a port to become active.
 */
async function waitForPort(port, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await checkPort(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Detects potential port from package.json
 */
function getPotentialPort(pkgObj) {
  const scripts = Object.values(pkgObj.scripts || {}).join(' ');
  const portMatch = scripts.match(/--port (\d+)/);
  if (portMatch) return parseInt(portMatch[1]);
  return null;
}

(async () => {
  let targetUrl = positionalUrl;
  let devProcess = null;

  // 1. Auto-Detection
  if (!targetUrl) {
    console.log(`\x1b[36m🔍 Searching for active development servers...\x1b[0m`);
    let activePort = null;
    for (const port of COMMON_PORTS) {
      if (await checkPort(port)) {
        activePort = port;
        break;
      }
    }

    if (activePort) {
      targetUrl = `http://localhost:${activePort}`;
      console.log(`\x1b[32m✅ Found running server at:\x1b[0m ${targetUrl}`);
    }
  }

  // 2. Auto-Startup
  if (!targetUrl) {
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkgObj = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scriptName = START_COMMANDS.find(s => pkgObj.scripts && pkgObj.scripts[s]);

      if (scriptName) {
        const port = getPotentialPort(pkgObj) || COMMON_PORTS[0];
        console.log(`\x1b[33m🚀 Starting dev server (npm run ${scriptName})...\x1b[0m`);
        
        devProcess = spawn('npm', ['run', scriptName], {
          stdio: 'inherit',
          shell: true
        });

        console.log(`\x1b[33m⏳ Waiting for localhost:${port} to be ready...\x1b[0m`);
        const ready = await waitForPort(port);
        if (ready) {
          targetUrl = `http://localhost:${port}`;
        } else {
          console.error(`\x1b[31m❌ Server failed to start on port ${port} within timeout.\x1b[0m`);
          devProcess.kill();
          process.exit(1);
        }
      }
    }
  }

  // 3. Final Check
  if (!targetUrl) {
    console.error(`\x1b[31m❌ Error:\x1b[0m No target URL provided and no local dev server found/started.`);
    program.help();
  }

  targetUrl = targetUrl.replace(/\/$/, ''); // Normalize trailing slash
  const baseUrl = new URL(targetUrl).origin;

  console.log(`\x1b[36m🚀 Starting Flutter-style overflow check for:\x1b[0m \x1b[1m${targetUrl}\x1b[0m\n`);

  // Launch Browser
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const viewports = [
    { name: 'Mobile Portrait', width: 375, height: 667 },
    { name: 'Mobile Landscape', width: 667, height: 375 },
    { name: 'Tablet Portrait', width: 768, height: 1024 },
    { name: 'Tablet Landscape', width: 1024, height: 768 },
    { name: 'Small Desktop', width: 1280, height: 800 },
    { name: 'Large Desktop', width: 1440, height: 900 }
  ];

  const queue = [{ url: targetUrl, depth: 0 }];
  const visited = new Set();
  const delayMs = parseInt(options.wait) || 0;
  const maxDepth = options.crawl ? (parseInt(options.depth) || Infinity) : 0;

  while (queue.length > 0) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    console.log(`\x1b[45m\x1b[37m 🔗 TESTING PAGE: ${url} \x1b[0m`);

    for (let i = 0; i < viewports.length; i++) {
        const vp = viewports[i];
        await page.setViewportSize({ width: vp.width, height: vp.height });
        
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
            
            // Wait for fonts to load
            await page.evaluate(async () => {
              if (document.fonts) { await document.fonts.ready; }
            });
            
            if (delayMs > 0) {
                await page.waitForTimeout(delayMs);
            }
            
            // On first viewport, extract internal links for queue
            if ((options.crawl || options.subroutes) && i === 0 && depth < maxDepth) {
                const links = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a'))
                        .map(a => a.href)
                        .filter(h => h.startsWith('http'));
                });
                
                links.forEach(link => {
                    try {
                        const u = new URL(link);
                        // Only follow same-origin links
                        if (u.origin === baseUrl) {
                            if (options.subroutes) {
                                const targetPath = new URL(targetUrl).pathname;
                                const isKid = u.pathname === targetPath || u.pathname.startsWith(targetPath === '/' ? '/' : targetPath + '/');
                                if (!isKid) return;
                            }
                            
                            u.hash = ''; // Remove hash
                            const cleanUrl = u.href.replace(/\/$/, '');
                            
                            // Check if already visited or queued
                            if (!visited.has(cleanUrl) && !queue.find(q => q.url === cleanUrl)) {
                                queue.push({ url: cleanUrl, depth: depth + 1 });
                            }
                        }
                    } catch (e) {
                         // Ignore invalid URLs
                    }
                });
            }
        } catch (err) {
            console.error(`\x1b[31m❌ Error loading page at ${vp.name}:\x1b[0m ${err.message}`);
            continue;
        }

        console.log(`\x1b[90m-------------------------------------------------\x1b[0m`);
        console.log(`\x1b[1m📱 ${vp.name} (${vp.width}x${vp.height})\x1b[0m`);
        console.log(`\x1b[90m-------------------------------------------------\x1b[0m`);

        const issues = await page.evaluate(() => {
            const flagged = [];
            const allElements = document.querySelectorAll('*');
            const viewportWidth = document.documentElement.clientWidth;
            const viewportHeight = document.documentElement.clientHeight;

            // Helper to generate a readable CSS path with nth-of-type
            const getElementPath = (el) => {
                if (el.id) return `#${el.id}`;
                let path = [];
                let curr = el;
                while (curr && curr.nodeType === Node.ELEMENT_NODE && curr.tagName !== 'HTML') {
                    let selector = curr.tagName.toLowerCase();
                    if (curr.className && typeof curr.className === 'string') {
                        const classes = curr.className.trim().split(/\s+/).filter(c => c && !c.includes(':')).join('.');
                        if (classes) selector += '.' + classes;
                    }
                    
                    // Add nth-of-type for precision if sibling tags match
                    let siblingIndex = 1;
                    let sibling = curr.previousElementSibling;
                    while (sibling) {
                        if (sibling.tagName === curr.tagName) siblingIndex++;
                        sibling = sibling.previousElementSibling;
                    }
                    if (siblingIndex > 1) {
                         selector += `:nth-of-type(${siblingIndex})`;
                    }

                    path.unshift(selector);
                    curr = curr.parentNode;
                }
                return path.join(' > ');
            };

            allElements.forEach(el => {
                if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'HTML', 'BODY', 'META', 'HEAD', 'TITLE'].includes(el.tagName)) return;
                
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return;

                const rect = el.getBoundingClientRect();
                
                // 1. VIEWPORT OVERFLOW
                if (rect.right > viewportWidth + 0.5) { 
                    const overflowPx = Math.round(rect.right - viewportWidth);
                    flagged.push({
                        type: '⚠️ VIEWPORT OVERFLOW',
                        message: `Element overflowed the right edge of the screen by ${overflowPx} pixels.`,
                        element: getElementPath(el)
                    });
                }

                if (rect.bottom > viewportHeight + 0.5 && style.position === 'fixed') {
                    const overflowPx = Math.round(rect.bottom - viewportHeight);
                    flagged.push({
                        type: '⚠️ VIEWPORT OVERFLOW',
                        message: `Fixed element overflowed the bottom edge of the screen by ${overflowPx} pixels.`,
                        element: getElementPath(el)
                    });
                }

                // 2. CONTAINER OVERFLOW
                const isOverflowHidden = ['hidden', 'scroll', 'auto', 'clip'].includes(style.overflow) || ['hidden', 'scroll', 'auto', 'clip'].includes(style.overflowX);
                
                if (!isOverflowHidden) {
                    if (el.scrollWidth > el.clientWidth + 0.5) {
                        const overflowPx = Math.round(el.scrollWidth - el.clientWidth);
                        flagged.push({
                            type: '📦 CONTAINER OVERFLOW',
                            message: `Content overflowed its container horizontally by ${overflowPx} pixels.`,
                            element: getElementPath(el)
                        });
                    }

                    if (el.scrollHeight > el.clientHeight + 0.5 && !['hidden', 'scroll', 'auto', 'clip'].includes(style.overflowY)) {
                        const overflowPx = Math.round(el.scrollHeight - el.clientHeight);
                        flagged.push({
                            type: '📦 CONTAINER OVERFLOW',
                            message: `Content overflowed its container vertically by ${overflowPx} pixels.`,
                            element: getElementPath(el)
                        });
                    }
                }
            });

            return flagged;
        });

        if (issues.length > 0) {
            issues.forEach(issue => {
                console.log(`\x1b[33m${issue.type}\x1b[0m`); // Yellow
                console.log(`   Message : ${issue.message}`);
                console.log(`   Element : \x1b[36m${issue.element}\x1b[0m\n`); // Cyan
            });
        } else {
            console.log('\x1b[32m✅ No layout overflows detected.\x1b[0m\n');
        }
    }
    console.log('');
  }

  await browser.close();
  
  if (devProcess) {
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', devProcess.pid, '/f', '/t']);
    } else {
        devProcess.kill('SIGINT');
    }
    console.log(`\x1b[33m🛑 Tests complete. Dev server shut down.\x1b[0m`);
  } else {
    console.log(`\x1b[33m🛑 Tests complete.\x1b[0m`);
  }
  process.exit(0);
})();
