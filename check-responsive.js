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
const readline = require('readline');
const pkg = require('./package.json');

const COMMON_PORTS = [5173, 3000, 5174, 8080, 3001, 4000, 5000];
const START_COMMANDS = ['dev', 'start', 'serve'];
const AUTH_STATE_FILE = path.join(process.cwd(), '.check-responsive-auth.json');

// Error codes for AI Agents & CI/CD
const EXITS = {
    SUCCESS: 0,
    OVERFLOW_FOUND: 1,
    AUTH_REQUIRED: 2,
    SERVER_FAILED: 3,
    MISSING_URL: 4
};

program
  .name('check-responsive')
  .description('Automated pixel-precise overflow detection tool.')
  .version(pkg.version)
  .argument('[url]', 'Target URL to test (optional, will auto-detect dev servers if omitted)')
  .option('-c, --crawl', 'Crawl the site to find multiple routes and test them all')
  .option('-s, --subroutes', 'Restrict crawler to only scan sub-paths (kids) of the target URL')
  .option('-d, --depth <number>', 'Maximum link depth for crawling', '10')
  .option('-w, --wait <ms>', 'Additional delay (in ms) to wait for animations after load', '500')
  .option('-i, --interactive', 'Start in interactive UI mode to manually authenticate before scanning')
  .option('-l, --login-path <string>', 'Custom URL path keyword that triggers the interactive login flow')
  .option('-e, --exclude <selectors>', 'Comma-separated CSS selectors to ignore')
  .option('-t, --tolerance <number>', 'Overflow tolerance in pixels', '2.0')
  .option('--timeout-strategy <strategy>', 'Navigation wait strategy (load, domcontentloaded, networkidle)', 'networkidle')
  .option('--timeout <number>', 'Navigation timeout in milliseconds', '30000')
  .option('-p, --persist-auth', 'Keep the authentication state file between runs')
  .option('--json', 'Output results as machine-readable JSON')
  .option('--non-interactive', 'Disable all interactive prompts and fail if auth is required')
  .option('--fail-on-issue', 'Exit with code 1 if any overflows are detected')
  .option('--auth-cookie <string>', 'Inject a session cookie (e.g., "name=value")')
  .option('--auth-file <path>', 'Use a custom Playwright storageState JSON file')
  .option('--ai-help', 'Output structured JSON metadata for AI agents to understand CLI capabilities')
  .parse(process.argv);

const options = program.opts();
const positionalUrl = program.args[0];

/**
 * AI Metadata for Agents
 */
if (options.aiHelp) {
    const aiMetadata = {
        name: "check-responsive",
        description: "Pixel-precise overflow detection engine for AI agents.",
        usage_patterns: [
            {
                goal: "Scan a specific local feature area under a login",
                command: "check-responsive http://localhost:3000/dashboard --subroutes --interactive",
                hint: "Use --subroutes to isolate testing and --interactive to handle manual login once."
            },
            {
                goal: "Run as part of an automated CI pipeline",
                command: "check-responsive http://localhost:3000 --json --non-interactive --fail-on-issue",
                hint: "JSON output and non-zero exit codes are best for programmatic audit."
            }
        ],
        flags: program.options.map(opt => ({
            flags: opt.flags,
            description: opt.description,
            ai_hint: opt.long.includes('crawl') ? "Broad sweep of all linked pages." :
                    opt.long.includes('tolerance') ? "Increase if you see tiny 1px false positives." :
                    opt.long.includes('subroutes') ? "Restricts crawl to only children of the target URL." : undefined
        }))
    };
    console.log(JSON.stringify(aiMetadata, null, 2));
    process.exit(EXITS.SUCCESS);
}

// Result accumulator for JSON output
const allResults = {
    target: null,
    timestamp: new Date().toISOString(),
    viewports_tested: [],
    pages_tested: [],
    issues: []
};

// Cleanup handler
function cleanupAuth(force = false) {
    if (fs.existsSync(AUTH_STATE_FILE) && (force || !options.persistAuth)) {
      try { fs.unlinkSync(AUTH_STATE_FILE); } catch(e) {}
    }
}

process.on('SIGINT', () => {
    cleanupAuth();
    process.exit(EXITS.SUCCESS);
});

async function log(message, type = 'info') {
    if (options.json) return;
    const colors = {
        info: '\x1b[36m',
        success: '\x1b[32m',
        warn: '\x1b[33m',
        error: '\x1b[31m',
        dim: '\x1b[90m',
        reset: '\x1b[0m'
    };
    console.log(`${colors[type] || ''}${message}${colors.reset}`);
}

async function performInteractiveLogin(loginUrl) {
    if (options.nonInteractive) {
        if (options.json) {
            console.log(JSON.stringify({ error: "Authentication required but running in --non-interactive mode", url: loginUrl }));
        } else {
            console.error(`\x1b[31m❌ Error:\x1b[0m Authentication required at ${loginUrl} but running in --non-interactive mode.`);
        }
        process.exit(EXITS.AUTH_REQUIRED);
    }

    log(`\n🚀 Launching interactive browser for authentication...`, 'info');
    const authBrowser = await chromium.launch({ headless: false });
    let authContextArgs = {};
    const authPath = options.authFile || AUTH_STATE_FILE;
    if (fs.existsSync(authPath)) {
        authContextArgs.storageState = authPath;
    }
    const authContext = await authBrowser.newContext(authContextArgs);
    const authPage = await authContext.newPage();
    try {
        await authPage.goto(loginUrl);
    } catch(e) {}

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    await new Promise(resolve => {
        rl.question('\n\x1b[33m🔑 Log in using the opened window. When you have full access, press ENTER here to resume scanning...\x1b[0m\n', () => {
            rl.close();
            resolve();
        });
    });

    await authContext.storageState({ path: AUTH_STATE_FILE });
    await authBrowser.close();
    log(`✅ Session saved! Resuming background tests...\n`, 'success');
}

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
  let targetUrl = null;
  let targetPath = '';
  let devProcess = null;

  if (positionalUrl) {
    if (positionalUrl.startsWith('http://') || positionalUrl.startsWith('https://')) {
      targetUrl = positionalUrl;
    } else {
      targetPath = positionalUrl.startsWith('/') ? positionalUrl : '/' + positionalUrl;
    }
  }

  // 1. Auto-Detection
  if (!targetUrl) {
    await log(`🔍 Searching for active development servers...`, 'info');
    let activePort = null;
    for (const port of COMMON_PORTS) {
      if (await checkPort(port)) {
        activePort = port;
        break;
      }
    }

    if (activePort) {
      targetUrl = `http://localhost:${activePort}${targetPath}`;
      await log(`✅ Found running server at: http://localhost:${activePort}`, 'success');
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
        await log(`🚀 Starting dev server (npm run ${scriptName})...`, 'warn');
        
        devProcess = spawn('npm', ['run', scriptName], {
          stdio: 'inherit',
          shell: true
        });

        await log(`⏳ Waiting for localhost:${port} to be ready...`, 'warn');
        const ready = await waitForPort(port);
        if (ready) {
          targetUrl = `http://localhost:${port}${targetPath}`;
        } else {
          if (options.json) {
              console.log(JSON.stringify({ error: `Server failed to start on port ${port}` }));
          } else {
              console.error(`\x1b[31m❌ Server failed to start on port ${port} within timeout.\x1b[0m`);
          }
          devProcess.kill();
          process.exit(EXITS.SERVER_FAILED);
        }
      }
    }
  }

  // 3. Final Check
  if (!targetUrl) {
    if (options.json) {
        console.log(JSON.stringify({ error: "No target URL provided" }));
    } else {
        console.error(`\x1b[31m❌ Error:\x1b[0m No target URL provided and no local dev server found/started.`);
        program.help();
    }
    process.exit(EXITS.MISSING_URL);
  }

  targetUrl = targetUrl.replace(/\/$/, ''); // Normalize trailing slash
  allResults.target = targetUrl;
  const baseUrl = new URL(targetUrl).origin;

  await log(`🚀 Starting Flutter-style overflow check for: ${targetUrl}\n`, 'info');

  // Interactive initial hook
  if (options.interactive) {
      await performInteractiveLogin(targetUrl);
  }

  // Launch Headless Browser function (re-usable for session reloading)
  let browser, context, page;
  async function initBrowser() {
      if (browser) await browser.close();
      browser = await chromium.launch();
      let ctxArgs = {};
      
      const authPath = options.authFile || AUTH_STATE_FILE;
      if (fs.existsSync(authPath)) {
          ctxArgs.storageState = authPath;
      }
      
      context = await browser.newContext(ctxArgs);
      
      if (options.authCookie) {
          const [name, value] = options.authCookie.split('=');
          await context.addCookies([{
              name,
              value,
              domain: new URL(targetUrl).hostname,
              path: '/'
          }]);
      }

      page = await context.newPage();
  }
  
  await initBrowser();
  
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
    allResults.pages_tested.push(url);

    await log(` 🔗 TESTING PAGE: ${url} `, 'info');

    let needToRestartLoop = false;

    for (let i = 0; i < viewports.length; i++) {
        const vp = viewports[i];
        await page.setViewportSize({ width: vp.width, height: vp.height });
        
        try {
            const timeout = parseInt(options.timeout) || 30000;
            const waitUntil = ['load', 'domcontentloaded', 'networkidle'].includes(options.timeoutStrategy) ? options.timeoutStrategy : 'networkidle';
            
            await page.goto(url, { waitUntil, timeout });
            
            // Login Detection Hand-off
            const currentUrlPath = page.url().toLowerCase();
            let needsAuth = false;
            
            if (options.loginPath && currentUrlPath.includes(options.loginPath.toLowerCase())) {
                needsAuth = true;
            } else if (!options.loginPath && (currentUrlPath.includes('login') || currentUrlPath.includes('signin') || currentUrlPath.includes('auth'))) {
                needsAuth = true;
            }
            
            if (needsAuth) {
                await log(`🔒 Authentication wall detected at: ${page.url()}`, 'warn');
                await performInteractiveLogin(page.url());
                await initBrowser(); // Re-init with new state
                
                // Re-queue the original URL to try it again correctly
                queue.unshift({ url, depth });
                visited.delete(url);
                needToRestartLoop = true;
                break; // Break the viewports loop
            }

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
            continue; // Go to next viewport
        }

        await log(`📱 ${vp.name} (${vp.width}x${vp.height})`, 'dim');
        if (!allResults.viewports_tested.includes(vp.name)) {
            allResults.viewports_tested.push(vp.name);
        }

        const tolerance = parseFloat(options.tolerance) || 2.0;
        const excludeSelectors = options.exclude ? options.exclude.split(',').map(s => s.trim()) : [];

        const issues = await page.evaluate(({ tolerance, excludeSelectors }) => {
            const flagged = [];
            const allElements = document.querySelectorAll('*');
            const viewportWidth = document.documentElement.clientWidth;
            const viewportHeight = document.documentElement.clientHeight;

            // Helper to check if an element is a marquee/ticker
            const isMarquee = (el, style) => {
                if (el.tagName === 'MARQUEE') return true;
                const anim = style.animationName || '';
                return /marquee|ticker|scroll/i.test(anim);
            };

            // Helper to check if an element is off-canvas and hidden by a parent
            const isIntentionallyOffCanvas = (el, rect, style) => {
                // If it's already outside the viewport
                if (rect.right <= 0 || rect.left >= viewportWidth || rect.bottom <= 0 || rect.top >= viewportHeight) {
                    let parent = el.parentElement;
                    while (parent) {
                        const pStyle = window.getComputedStyle(parent);
                        if (pStyle.overflow === 'hidden' || pStyle.overflowX === 'hidden' || pStyle.overflowY === 'hidden') {
                            return true;
                        }
                        parent = parent.parentElement;
                    }
                }
                return false;
            };

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
                
                // Manual exclusion
                if (excludeSelectors.some(sel => el.matches(sel))) return;

                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

                const rect = el.getBoundingClientRect();

                // Skip marquees
                if (isMarquee(el, style)) return;

                // Skip intentionally off-canvas elements
                if (isIntentionallyOffCanvas(el, rect, style)) return;
                
                // 1. VIEWPORT OVERFLOW
                if (rect.right > viewportWidth + tolerance) { 
                    const overflowPx = Math.round(rect.right - viewportWidth);
                    flagged.push({
                        type: '⚠️ VIEWPORT OVERFLOW',
                        message: `Element overflowed the right edge of the screen by ${overflowPx} pixels.`,
                        element: getElementPath(el)
                    });
                }

                if (rect.bottom > viewportHeight + tolerance && style.position === 'fixed') {
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
                    if (el.scrollWidth > el.clientWidth + tolerance) {
                        const overflowPx = Math.round(el.scrollWidth - el.clientWidth);
                        flagged.push({
                            type: '📦 CONTAINER OVERFLOW',
                            message: `Content overflowed its container horizontally by ${overflowPx} pixels.`,
                            element: getElementPath(el)
                        });
                    }

                    if (el.scrollHeight > el.clientHeight + tolerance && !['hidden', 'scroll', 'auto', 'clip'].includes(style.overflowY)) {
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
        }, { tolerance, excludeSelectors });

        if (issues.length > 0) {
            issues.forEach(issue => {
                const issueData = { page: url, viewport: vp.name, ...issue };
                allResults.issues.push(issueData);
                
                if (!options.json) {
                    console.log(`\x1b[33m${issue.type}\x1b[0m`);
                    console.log(`   Message : ${issue.message}`);
                    console.log(`   Element : \x1b[36m${issue.element}\x1b[0m\n`);
                }
            });
        } else {
            await log('✅ No layout overflows detected.\n', 'success');
        }
    }
  }

  await browser.close();
  
  if (options.json) {
      console.log(JSON.stringify(allResults, null, 2));
  }

  if (devProcess) {
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', devProcess.pid, '/f', '/t']);
    } else {
        devProcess.kill('SIGINT');
    }
    await log(`🛑 Tests complete. Dev server shut down.`, 'warn');
  } else {
    await log(`🛑 Tests complete.`, 'warn');
  }
  
  cleanupAuth();
  
  if (options.failOnIssue && allResults.issues.length > 0) {
      process.exit(EXITS.OVERFLOW_FOUND);
  }
  process.exit(EXITS.SUCCESS);
})();
