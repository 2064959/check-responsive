/**
 * Responsive UI Checker using Playwright
 * Automatically detects horizontal overflow and internal content overflow.
 *
 * Usage:
 *   node check-responsive.js [targetUrl]
 *
 * It will automatically try to find a running dev server or start it from package.json.
 */

const { chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

// Configuration
const COMMON_PORTS = [5173, 3000, 5174, 8080, 3001, 4000, 5000];
const START_COMMANDS = ['dev', 'start', 'serve'];

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
 * Tries to detect which port the project is likely to use from package.json
 */
function getPotentialPort(pkg) {
  // Common patterns in scripts
  const scripts = Object.values(pkg.scripts || {}).join(' ');
  const portMatch = scripts.match(/--port (\d+)/);
  if (portMatch) return parseInt(portMatch[1]);
  return null;
}

(async () => {
  let targetUrl = process.argv[2];
  let devProcess = null;

  // 1. If no URL provided, try to find an active one
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

  // 2. If still no URL, try to start the project
  if (!targetUrl) {
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scriptName = START_COMMANDS.find(s => pkg.scripts && pkg.scripts[s]);

      if (scriptName) {
        const port = getPotentialPort(pkg) || COMMON_PORTS[0];
        console.log(`\x1b[33m🚀 Starting dev server (npm run ${scriptName})...\x1b[0m`);
        
        // Spawn the dev server
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

  // 3. Fallback
  if (!targetUrl) {
    console.error(`\x1b[31m❌ Error:\x1b[0m No target URL provided and no local dev server found/started.`);
    console.log(`Usage: node check-responsive.js [url]`);
    process.exit(1);
  }

  console.log(`\x1b[36m🚀 Starting UI responsiveness check for:\x1b[0m \x1b[1m${targetUrl}\x1b[0m\n`);

  // Launch the browser
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  const viewports = [
    { name: 'Mobile Portrait', width: 375, height: 667 },
    { name: 'Tablet Portrait', width: 768, height: 1024 },
    { name: 'Desktop Small', width: 1024, height: 768 },
    { name: 'Desktop Large', width: 1440, height: 900 }
  ];

  try {
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      
      try {
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
      } catch (err) {
        console.error(`\x1b[31m❌ Error loading page at ${vp.name}:\x1b[0m ${err.message}`);
        continue;
      }

      console.log(`\x1b[33m--- Checking ${vp.name} (${vp.width}x${vp.height}) ---\x1b[0m`);

      const issues = await page.evaluate(() => {
        const flaggedElements = [];
        const allElements = document.querySelectorAll('*');

        allElements.forEach(el => {
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME'].includes(el.tagName)) return;
          
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;

          const rect = el.getBoundingClientRect();
          const clientWidth = document.documentElement.clientWidth;
          
          if (rect.right > clientWidth + 1) {
            flaggedElements.push({
              element: `<${el.tagName.toLowerCase()}${el.id ? ' id="' + el.id + '"' : ''}${el.className ? ' class="' + el.className + '"' : ''}>`,
              issue: 'Overflows screen horizontally',
              width: rect.width,
              rightEdge: rect.right,
              screenWidth: clientWidth
            });
          }

          if (el.scrollWidth > el.clientWidth && !['scroll', 'auto'].includes(style.overflowX)) {
            if (el.clientWidth > 0) {
              flaggedElements.push({
                element: `<${el.tagName.toLowerCase()}${el.id ? ' id="' + el.id + '"' : ''}${el.className ? ' class="' + el.className + '"' : ''}>`,
                issue: 'Internal content overflowing container'
              });
            }
          }
        });

        return flaggedElements;
      });

      if (issues.length > 0) {
        console.table(issues);
      } else {
        console.log('\x1b[32m✅ No overflow issues found at this size.\x1b[0m\n');
      }
    }
  } finally {
    await browser.close();
    
    // If we started a dev process, we might want to kill it, 
    // but often users want to keep it running. 
    // For automation, we'll keep it running if it was already there, 
    // but maybe terminate if we started it just for this script.
    // However, the user said "detect if running and if not start it", 
    // implying they might want it for the test.
    if (devProcess) {
      console.log(`\x1b[33m🛑 Tests complete. You can close the dev server (npm run) manually or it will remain running.\x1b[0m`);
      // We don't kill it here by default to let them see results or continue working,
      // but if the script is for CI, we should kill it.
      // Given the prompt, I'll exit and let them decide.
      process.exit(0);
    }
  }
})();
