#!/usr/bin/env node

/**
 * Check-Responsive 🚀
 * Flutter-style pixel-precise overflow detection.
 * Automatically finds, starts, and waits for your dev server.
 */

const { chromium } = require('@playwright/test');
const { spawn, exec } = require('child_process');
const http = require('http');
const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const { program } = require('commander');
const net = require('net');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pkg = require('./package.json');

const COMMON_PORTS = [5173, 3000, 5174, 8080, 3001, 4000, 5000];
const START_COMMANDS = ['dev', 'start', 'serve'];
const AUTH_STATE_FILE = path.join(process.cwd(), '.check-responsive-auth.json');
const REPORT_DIR = path.join(process.cwd(), 'responsive-report');
const SCREENSHOTS_DIR = path.join(REPORT_DIR, 'screenshots');
const SNAPSHOTS_DIR = path.join(REPORT_DIR, 'snapshots');

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
  .option('--screenshots', 'Capture element-level screenshots of all detected overflows')
  .option('--visual-buffer <number>', 'Vertical overflow buffer in pixels (useful for decorative fonts)', '0')
  .option('--persist-reports', 'Keep the responsive-report folder between runs')
  .option('-v, --view', 'Open the interactive report viewer after scanning')
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

function initReportDir() {
    if (!options.persistReports && fs.existsSync(REPORT_DIR)) {
        fs.rmSync(REPORT_DIR, { recursive: true, force: true });
    }
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
        fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
}

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
 * Captures a complete DOM & Style snapshot for the interactive viewer.
 */
async function capturePageSnapshot(page, url, vpName) {
    try {
        const snapshot = await page.evaluate(() => {
            // 1. Snapshot the styles
            let allStyles = "";
            for (const sheet of document.styleSheets) {
                try {
                    for (const rule of sheet.cssRules) {
                        allStyles += rule.cssText + "\n";
                    }
                } catch (e) {
                    // cross-origin stylesheets ignore
                }
            }

            // 2. Clone the DOM
            const doc = document.documentElement.cloneNode(true);
            
            // 3. Remove all scripts to prevent logic re-execution
            const scripts = doc.querySelectorAll('script');
            scripts.forEach(s => s.remove());

            // 4. Inject the frozen styles
            const styleTag = document.createElement('style');
            styleTag.id = 'check-responsive-frozen-styles';
            styleTag.textContent = allStyles;
            doc.querySelector('head').appendChild(styleTag);

            // 5. Add a base tag for relative images/assets
            const base = document.createElement('base');
            base.href = window.location.origin + window.location.pathname;
            doc.querySelector('head').prepend(base);

            return doc.outerHTML;
        });

        const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        let pageBase = path.basename(new URL(url).pathname);
        if (!pageBase || pageBase === '/') pageBase = 'index';
        const filename = `${slugify(pageBase)}_${slugify(vpName)}.html`;
        const snapshotPath = path.join(SNAPSHOTS_DIR, filename);
        
        fs.writeFileSync(snapshotPath, snapshot);
        return path.relative(REPORT_DIR, snapshotPath); // Relative to the index.html
    } catch (e) {
        return null;
    }
}

/**
 * Generates the Interactive Dashboard HTML.
 */
function generateInteractiveReport(results) {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Check-Responsive | Interactive Audit</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0a0a0a;
            --sidebar: #121212;
            --border: #2a2a2a;
            --accent: #3b82f6;
            --accent-dim: rgba(59, 130, 246, 0.1);
            --text: #e2e8f0;
            --text-dim: #94a3b8;
            --critical: #ef4444;
            --warning: #f59e0b;
            --success: #10b981;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
            font-family: 'Inter', sans-serif; 
            background: var(--bg); 
            color: var(--text);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* Navbar */
        nav {
            height: 56px;
            background: var(--sidebar);
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            padding: 0 16px;
            gap: 12px;
            z-index: 100;
        }

        .logo {
            font-weight: 700;
            font-size: 14px;
            letter-spacing: -0.5px;
            margin-right: 20px;
            color: var(--accent);
        }

        .tabs {
            display: flex;
            gap: 4px;
            height: 100%;
            align-items: flex-end;
        }

        .tab {
            padding: 8px 16px;
            background: transparent;
            border: 1px solid transparent;
            border-bottom: 0;
            border-radius: 6px 6px 0 0;
            color: var(--text-dim);
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s;
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .tab:hover { color: var(--text); background: var(--accent-dim); }
        .tab.active { 
            background: var(--bg); 
            border-color: var(--border); 
            color: var(--text);
            font-weight: 500;
        }

        /* Layout */
        main {
            flex: 1;
            display: flex;
            overflow: hidden;
        }

        /* Sidebar */
        aside {
            width: 320px;
            background: var(--sidebar);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            overflow-y: auto;
        }

        .section {
            padding: 20px;
            border-bottom: 1px solid var(--border);
        }

        .section-title {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-dim);
            margin-bottom: 12px;
            font-weight: 600;
        }

        .viewport-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .vp-item {
            padding: 10px;
            border-radius: 6px;
            font-size: 13px;
            cursor: pointer;
            transition: 0.2s;
            border: 1px solid transparent;
        }

        .vp-item:hover { background: var(--accent-dim); }
        .vp-item.active { 
            background: var(--accent-dim); 
            border-color: var(--accent);
            color: var(--accent);
        }

        .issue-card {
            padding: 12px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            margin-bottom: 10px;
            cursor: pointer;
            transition: 0.2s;
            position: relative;
        }

        .issue-card:hover { border-color: var(--accent); }
        .issue-card.selected { border-color: var(--success); background: rgba(16, 185, 129, 0.05); }

        .issue-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 6px;
        }

        .severity {
            font-size: 9px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 4px;
            text-transform: uppercase;
        }

        .severity.critical { background: var(--critical); color: white; }
        .severity.warning { background: var(--warning); color: black; }

        .issue-msg { font-size: 12px; line-height: 1.4; margin-bottom: 8px; }
        .issue-el { 
            font-family: 'JetBrains Mono', monospace; 
            font-size: 10px; 
            color: var(--text-dim);
            background: rgba(0,0,0,0.3);
            padding: 4px;
            border-radius: 4px;
            display: block;
            word-break: break-all;
        }

        .approve-checkbox {
            position: absolute;
            top: 10px;
            right: 10px;
            accent-color: var(--success);
        }

        /* Viewer - pan/zoom canvas */
        .viewer {
            flex: 1;
            background: #111;
            overflow: hidden;
            position: relative;
            cursor: grab;
            user-select: none;
        }
        .viewer.dragging { cursor: grabbing; }

        /* checkerboard background */
        .viewer::before {
            content: '';
            position: absolute;
            inset: 0;
            background-image:
                linear-gradient(45deg, #1a1a1a 25%, transparent 25%),
                linear-gradient(-45deg, #1a1a1a 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, #1a1a1a 75%),
                linear-gradient(-45deg, transparent 75%, #1a1a1a 75%);
            background-size: 20px 20px;
            background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
            pointer-events: none;
            opacity: 0.5;
        }

        .iframe-container {
            position: absolute;
            top: 0;
            left: 0;
            transform-origin: top left;
            background: white;
            box-shadow: 0 8px 60px rgba(0,0,0,0.7);
            will-change: transform;
        }

        iframe {
            display: block;
            border: 0;
            /* width/height set dynamically */
        }

        /* Footer */
        .toolbar {
            height: 48px;
            background: var(--sidebar);
            border-top: 1px solid var(--border);
            display: flex;
            align-items: center;
            padding: 0 16px;
            justify-content: space-between;
            gap: 12px;
            flex-shrink: 0;
        }

        .zoom-controls {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .btn-icon {
            background: var(--border);
            color: var(--text);
            border: 1px solid #3a3a3a;
            width: 30px;
            height: 30px;
            border-radius: 6px;
            font-size: 16px;
            line-height: 1;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: 0.15s;
        }
        .btn-icon:hover { background: var(--accent); border-color: var(--accent); }

        .zoom-label {
            font-size: 12px;
            color: var(--text-dim);
            min-width: 44px;
            text-align: center;
            font-variant-numeric: tabular-nums;
        }

        .btn-fit {
            background: var(--border);
            color: var(--text);
            border: 1px solid #3a3a3a;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            transition: 0.15s;
        }
        .btn-fit:hover { background: var(--accent); border-color: var(--accent); }

        button.primary {
            background: var(--accent);
            color: white;
            border: 0;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
        }
        button.primary:hover { background: #2563eb; }

        .stat { font-size: 12px; color: var(--text-dim); }
        .stat b { color: var(--text); }

        .hint {
            font-size: 11px;
            color: #555;
            pointer-events: none;
        }
    </style>
</head>
<body>
    <nav>
        <div class="logo">CHECK-RESPONSIVE</div>
        <div class="tabs" id="page-tabs"></div>
    </nav>

    <main>
        <aside>
            <div class="section">
                <div class="section-title">Viewports</div>
                <div class="viewport-list" id="vp-list"></div>
            </div>
            <div class="section" style="flex: 1; overflow-y: auto;">
                <div class="section-title">Flagged Issues</div>
                <div id="issue-list"></div>
            </div>
        </aside>

        <section class="viewer" id="viewer-canvas">
            <div class="iframe-container" id="iframe-wrap">
                <iframe id="target-frame" scrolling="no"></iframe>
            </div>
        </section>
    </main>

    <footer class="toolbar">
        <div class="stat">
            Issues: <b id="count-total">0</b> | Selected: <b id="count-selected">0</b>
        </div>
        <div class="zoom-controls">
            <span class="hint">Scroll: zoom &nbsp;·&nbsp; Ctrl+drag / Middle drag: pan</span>
            <button class="btn-icon" onclick="zoomOut()" title="Zoom out">−</button>
            <span class="zoom-label" id="zoom-label">100%</span>
            <button class="btn-icon" onclick="zoomIn()" title="Zoom in">+</button>
            <button class="btn-fit" onclick="fitToView(true)" title="Fit to screen">Fit</button>
        </div>
        <button class="primary" onclick="exportReport()">Export Final Audit JSON</button>
    </footer>

    <script>
        const data = ${JSON.stringify(results)};
        let currentPage = data.pages_tested[0];
        let currentVp = 'Mobile Portrait';
        let selectedIssues = new Set();

        // Pan/Zoom state
        let scale = 1;
        let panX = 0, panY = 0;
        let isDragging = false;
        let dragStart = { x: 0, y: 0 };
        let panStart  = { x: 0, y: 0 };
        let pendingSelector = null;

        const vpDef = {
            'Mobile Portrait':  { w: 375,  h: 667  },
            'Mobile Landscape': { w: 667,  h: 375  },
            'Tablet Portrait':  { w: 768,  h: 1024 },
            'Tablet Landscape': { w: 1024, h: 768  },
            'Small Desktop':    { w: 1280, h: 800  },
            'Large Desktop':    { w: 1440, h: 900  }
        };

        // ── Pan / Zoom engine ──────────────────────────────────────────
        function applyTransform() {
            document.getElementById('iframe-wrap').style.transform =
                \`translate(\${panX}px, \${panY}px) scale(\${scale})\`;
        }

        function updateZoomLabel() {
            document.getElementById('zoom-label').textContent = Math.round(scale * 100) + '%';
        }

        function resetView(animate) {
            const canvas = document.getElementById('viewer-canvas');
            const vpW    = parseFloat(document.getElementById('iframe-wrap').style.width) || vpDef[currentVp].w;
            scale = 1;
            panX  = (canvas.clientWidth - vpW) / 2;
            panY  = 40;
            if (animate) {
                const w = document.getElementById('iframe-wrap');
                w.style.transition = 'transform .25s ease';
                setTimeout(() => w.style.transition = '', 280);
            }
            applyTransform();
            updateZoomLabel();
        }

        function fitToView(animate) {
            const canvas = document.getElementById('viewer-canvas');
            const wrap   = document.getElementById('iframe-wrap');
            const vpW    = parseFloat(wrap.style.width)  || vpDef[currentVp].w;
            const vpH    = parseFloat(wrap.style.height) || 800;
            const cW     = canvas.clientWidth  - 80;
            const cH     = canvas.clientHeight - 80;
            scale  = Math.min(cW / vpW, cH / vpH, 1);
            panX   = (canvas.clientWidth  - vpW * scale) / 2;
            panY   = 40;
            if (animate) {
                const w = document.getElementById('iframe-wrap');
                w.style.transition = 'transform .25s ease';
                setTimeout(() => w.style.transition = '', 280);
            }
            applyTransform();
            updateZoomLabel();
        }


        function zoomAt(cx, cy, newScale) {
            newScale = Math.max(0.08, Math.min(4, newScale));
            panX = cx - (cx - panX) * (newScale / scale);
            panY = cy - (cy - panY) * (newScale / scale);
            scale = newScale;
            applyTransform();
            updateZoomLabel();
        }

        function zoomIn()  { const c = document.getElementById('viewer-canvas'); zoomAt(c.clientWidth/2, c.clientHeight/2, scale * 1.25); }
        function zoomOut() { const c = document.getElementById('viewer-canvas'); zoomAt(c.clientWidth/2, c.clientHeight/2, scale / 1.25); }

        function initZoomPan() {
            const canvas = document.getElementById('viewer-canvas');

            canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const rect  = canvas.getBoundingClientRect();
                const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12;
                zoomAt(e.clientX - rect.left, e.clientY - rect.top, scale * delta);
            }, { passive: false });

            canvas.addEventListener('mousedown', (e) => {
                const isPan = e.button === 1 || (e.button === 0 && e.ctrlKey);
                if (!isPan) return;
                e.preventDefault();
                isDragging = true;
                dragStart  = { x: e.clientX, y: e.clientY };
                panStart   = { x: panX, y: panY };
                canvas.classList.add('dragging');
            });

            window.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                panX = panStart.x + (e.clientX - dragStart.x);
                panY = panStart.y + (e.clientY - dragStart.y);
                applyTransform();
            });

            window.addEventListener('mouseup', () => {
                if (isDragging) { isDragging = false; document.getElementById('viewer-canvas').classList.remove('dragging'); }
            });

            canvas.addEventListener('contextmenu', e => e.preventDefault());
        }

        // ── iframe full-height loading ─────────────────────────────────
        function setIframeUrl(snapshotPath) {
            const frame  = document.getElementById('target-frame');
            const wrap   = document.getElementById('iframe-wrap');
            const canvas = document.getElementById('viewer-canvas');
            const vpW    = vpDef[currentVp].w;

            // Size the container
            frame.style.width  = vpW + 'px';
            frame.style.height = '800px';
            wrap.style.width   = vpW + 'px';
            wrap.style.height  = '800px';

            // ✅ Position at center/top BEFORE src loads → no jump on render
            scale = 1;
            panX  = (canvas.clientWidth - vpW) / 2;
            panY  = 40;
            applyTransform();
            updateZoomLabel();

            frame.onload = () => {
                try {
                    const h = frame.contentDocument.documentElement.scrollHeight;
                    frame.style.height = h + 'px';
                    wrap.style.height  = h + 'px';
                    // Re-center after height is known (panX unchanged, stay at top)
                    panX = (canvas.clientWidth - vpW) / 2;
                    panY = 40;
                    applyTransform();
                } catch(e) {}
                if (pendingSelector) doHighlight(pendingSelector);
            };

            frame.src = snapshotPath;
        }

        // ── Highlighting ───────────────────────────────────────────────
        // Zero-regex CSS selector escaper — walks char-by-char, handles Tailwind [arbitrary] values and slashes
        function escapeSelector(sel) {
            var out = '';
            var i = 0;
            while (i < sel.length) {
                var ch = sel.charAt(i);
                if (ch === '.') {
                    // Collect class name token, tracking [...] bracket depth
                    var cls = '';
                    i++;
                    var depth = 0;
                    while (i < sel.length) {
                        var c = sel.charAt(i);
                        if (c === '[')       { depth++; cls += c; i++; }
                        else if (c === ']') { depth--; cls += c; i++; }
                        else if (depth > 0) { cls += c; i++; }
                        else if (c === '.' || c === ' ' || c === '>' || c === '+' ||
                                 c === '~' || c === ':' || c === '#' || c === ')') { break; }
                        else { cls += c; i++; }
                    }
                    out += '.' + (cls ? CSS.escape(cls) : '');
                } else {
                    out += ch;
                    i++;
                }
            }
            return out;
        }

        function doHighlight(selector) {
            const frame = document.getElementById('target-frame');
            try {
                const doc = frame.contentDocument;
                if (!doc || doc.readyState !== 'complete') return;

                if (!doc.getElementById('check-resp-anim')) {
                    const s = doc.createElement('style');
                    s.id = 'check-resp-anim';
                    s.textContent = \`
                        @keyframes crh-pulse {
                            0%   { box-shadow: 0 0 0 0 rgba(239,68,68,.9); }
                            70%  { box-shadow: 0 0 0 12px rgba(239,68,68,0); }
                            100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
                        }
                        .crh {
                            outline: 3px solid #ef4444 !important;
                            outline-offset: 3px !important;
                            animation: crh-pulse 1.2s ease-in-out infinite !important;
                        }
                    \`;
                    doc.head.appendChild(s);
                }

                doc.querySelectorAll('.crh').forEach(el => el.classList.remove('crh'));

                // Try escaped selector, fall back to ID-only if still failing
                let el = null;
                const escaped = escapeSelector(selector);
                try {
                    el = doc.querySelector(escaped);
                } catch(e2) {
                    // Last resort: extract the #id part and query just that
                    const idMatch = selector.match(/#([\w-]+)/);
                    if (idMatch) el = doc.getElementById(idMatch[1]);
                }

                if (!el) { console.warn('crh: not found:', selector); return; }
                el.classList.add('crh');

                // ✅ Smooth pan to keep element in view
                const canvas   = document.getElementById('viewer-canvas');
                const wrapEl   = document.getElementById('iframe-wrap');
                const wrapRect = wrapEl.getBoundingClientRect();
                const elRect   = el.getBoundingClientRect();
                const elTop    = wrapRect.top + elRect.top * scale;
                const elBot    = wrapRect.top + elRect.bottom * scale;
                const margin   = 80;
                let needsPan   = false;

                if (elTop < margin) { panY += margin - elTop; needsPan = true; }
                else if (elBot > canvas.clientHeight - margin) { panY -= elBot - (canvas.clientHeight - margin); needsPan = true; }

                if (needsPan) {
                    wrapEl.style.transition = 'transform 0.45s cubic-bezier(0.4, 0, 0.2, 1)';
                    applyTransform();
                    setTimeout(() => wrapEl.style.transition = '', 480);
                }
            } catch(e) { console.error('crh:', e); }
        }

        function highlightElement(selector) {
            pendingSelector = selector;
            const frame = document.getElementById('target-frame');
            if (frame.contentDocument && frame.contentDocument.readyState === 'complete') {
                doHighlight(selector);
            }
        }

        // ── Navigation ─────────────────────────────────────────────────
        function init() {
            initZoomPan();
            renderTabs();
            renderViewports();
            update();
        }

        function renderTabs() {
            const c = document.getElementById('page-tabs');
            c.innerHTML = data.pages_tested.map(url => \`
                <div class="tab \${url === currentPage ? 'active' : ''}" onclick="setPage('\${url}')">
                    \${new URL(url).pathname || '/'}
                </div>
            \`).join('');
        }

        function renderViewports() {
            const c = document.getElementById('vp-list');
            const active = Array.from(new Set(
                data.issues.filter(i => i.page === currentPage).map(i => i.viewport)
            ));
            if (active.length > 0 && !active.includes(currentVp)) currentVp = active[0];
            if (active.length === 0) {
                c.innerHTML = '<div class="stat" style="padding:8px">No issues for this page</div>';
                return;
            }
            c.innerHTML = active.map(name => \`
                <div class="vp-item \${name === currentVp ? 'active' : ''}" onclick="setVp('\${name}')">
                    \${name} (\${vpDef[name].w}×\${vpDef[name].h})
                </div>
            \`).join('');
        }

        function setPage(url)  { currentPage = url; pendingSelector = null; renderTabs(); renderViewports(); update(); }
        function setVp(name)   { currentVp = name; pendingSelector = null; renderViewports(); update(); }

        function update() {
            const snapshotPath = data.pages_snapshots?.[currentPage]?.[currentVp];
            if (snapshotPath) setIframeUrl(snapshotPath);
            else { document.getElementById('target-frame').src = 'about:blank'; fitToView(false); }
            renderIssues();
        }

        // ── Issues ─────────────────────────────────────────────────────
        function renderIssues() {
            const container = document.getElementById('issue-list');
            // Mapping issues with their original index in the global data.issues array
            const issuesWithIdx = data.issues
                .map((issue, idx) => ({ ...issue, globalIdx: idx }))
                .filter(i => i.page === currentPage && i.viewport === currentVp);
            
            document.getElementById('count-total').innerText = issuesWithIdx.length;

            if (issuesWithIdx.length === 0) {
                container.innerHTML = '<div class="stat" style="padding:12px;color:#94a3b8">✅ No issues on this viewport</div>';
                document.getElementById('count-selected').innerText = selectedIssues.size;
                return;
            }

            container.innerHTML = issuesWithIdx.map((issue) => {
                const key = issue.globalIdx;
                const encodedSel = btoa(unescape(encodeURIComponent(issue.element)));
                return \`<div class="issue-card \${selectedIssues.has(key) ? 'selected' : ''}" 
                             data-key="\${key}" 
                             data-sel="\${encodedSel}"
                             onclick="selectIssue(this)">
                    <input type="checkbox" class="approve-checkbox" \${selectedIssues.has(key) ? 'checked' : ''} onclick="event.stopPropagation();toggleIssue(\${key})">
                    <div class="issue-header"><span class="severity \${issue.severity.toLowerCase()}">\${issue.severity}: \${issue.type}</span></div>
                    <div class="issue-msg">\${issue.message}</div>
                    <code class="issue-el">\${issue.element}</code>
                </div>\`;
            }).join('');

            document.getElementById('count-selected').innerText = selectedIssues.size;
        }

        function selectIssue(cardEl) { 
            const key = parseInt(cardEl.getAttribute('data-key'));
            const encodedSel = cardEl.getAttribute('data-sel');
            const selector = decodeURIComponent(escape(atob(encodedSel)));
            
            highlightElement(selector); 
            // Also select it if not already selected (improves UX)
            if (!selectedIssues.has(key)) {
                selectedIssues.add(key);
                renderIssues();
            }
        }
        function toggleIssue(key) { 
            if (selectedIssues.has(key)) selectedIssues.delete(key); 
            else selectedIssues.add(key); 
            renderIssues(); 
        }

        function exportReport() {
            const final = data.issues.filter((iss, idx) => selectedIssues.has(idx));
            const blob = new Blob([JSON.stringify({...data, issues: final}, null, 2)], {type:'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href=url; a.download='final-audit.json'; a.click();
        }

        init();
    </script>
</body>
</html>
    `;
    fs.writeFileSync(path.join(REPORT_DIR, 'index.html'), html);
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
  initReportDir();
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
      // SMART CHECK: Verify if the port actually serves the requested path
      const checkPath = targetPath || '/';
      const checkUrl = `http://localhost:${activePort}${checkPath}`;
      
      targetUrl = checkUrl;
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
  const maxDepth = options.crawl ? (parseInt(options.depth) || Infinity)
                 : options.subroutes ? Infinity
                 : 0;

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
            const waitUntil = ['load', 'domcontentloaded', 'networkidle'].includes(options.timeoutStrategy) ? options.timeoutStrategy : 'load';
            
            await page.goto(url, { waitUntil, timeout });
            
            // Login Detection Hand-off
            const currentUrlPath = page.url().toLowerCase();
            let needsAuth = false;
            
            // Refined Auth Check: Only trip if we are hit a login wall and NOT on our intended path
            const targetPathname = new URL(url).pathname.toLowerCase();
            const currentPathname = new URL(page.url()).pathname.toLowerCase();
            
            if (currentPathname !== targetPathname) {
                if (options.loginPath && currentUrlPath.includes(options.loginPath.toLowerCase())) {
                    needsAuth = true;
                } else if (!options.loginPath && (currentUrlPath.includes('login') || currentUrlPath.includes('signin') || currentUrlPath.includes('auth'))) {
                    needsAuth = true;
                }
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
                // Give React/Vue/SPA time to render nav links before harvesting
                await page.waitForTimeout(600);

                const links = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('[href]'))
                        .map(el => el.href)
                        .filter(h => h && h.startsWith('http'));
                });

                // Use the actual navigated URL (post-redirect) as the subroute base
                const actualBase = page.url();

                links.forEach(link => {
                    try {
                        const u = new URL(link);
                        if (u.origin === baseUrl) {
                            if (options.subroutes) {
                                // Use original targetUrl path OR actual post-redirect path — whichever is shorter (broader)
                                const targetPath = new URL(targetUrl).pathname;
                                const actualPath = new URL(actualBase).pathname;
                                const basePath = targetPath.length <= actualPath.length ? targetPath : actualPath;
                                const isKid = u.pathname === basePath || u.pathname.startsWith(basePath === '/' ? '/' : basePath + '/');
                                if (!isKid) return;
                            }

                            u.hash = '';
                            const cleanUrl = u.href.replace(/\/$/, '');

                            if (!visited.has(cleanUrl) && !queue.find(q => q.url === cleanUrl)) {
                                queue.push({ url: cleanUrl, depth: depth + 1 });
                            }
                        }
                    } catch (e) {}
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

        const issues = await page.evaluate(({ tolerance, excludeSelectors, visualBuffer: vbRaw }) => {
            const visualBuffer = parseFloat(vbRaw) || 0;
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

            // Helper to generate a readable CSS path with high-value attribute priority
            const getElementPath = (el) => {
                // Priority attributes
                const priorityAttrs = ['data-testid', 'data-qa', 'aria-label'];
                for (const attr of priorityAttrs) {
                    if (el.getAttribute(attr)) return `[${attr}="${el.getAttribute(attr)}"]`;
                }
                if (el.id) return `#${el.id}`;

                let path = [];
                let curr = el;
                while (curr && curr.nodeType === Node.ELEMENT_NODE && curr.tagName !== 'HTML') {
                    let selector = curr.tagName.toLowerCase();
                    
                    // Check for priority attributes on ancestors too
                    let foundPriority = false;
                    for (const attr of priorityAttrs) {
                        if (curr.getAttribute(attr)) {
                            selector = `[${attr}="${curr.getAttribute(attr)}"]`;
                            foundPriority = true;
                            break;
                        }
                    }
                    
                    if (foundPriority) {
                        path.unshift(selector);
                        break; // Stop at first unique identifier
                    }

                    if (curr.id) {
                        path.unshift(`#${curr.id}`);
                        break;
                    }

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

            const isIgnored = (el) => {
                let curr = el;
                while (curr) {
                    if (curr.hasAttribute && curr.hasAttribute('data-check-ignore')) return true;
                    curr = curr.parentElement;
                }
                return false;
            };

            allElements.forEach(el => {
                if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'HTML', 'BODY', 'META', 'HEAD', 'TITLE'].includes(el.tagName)) return;
                
                // Manual exclusion
                if (excludeSelectors.some(sel => el.matches(sel))) return;
                if (isIgnored(el)) return;

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
                        type: 'VIEWPORT OVERFLOW',
                        severity: 'CRITICAL',
                        message: `Element overflowed the right edge of the screen by ${overflowPx} pixels.`,
                        element: getElementPath(el)
                    });
                }

                if (rect.bottom > viewportHeight + tolerance && style.position === 'fixed') {
                    const overflowPx = Math.round(rect.bottom - viewportHeight);
                    
                    // Apply visual buffer to vertical fixed overflows
                    if (overflowPx > visualBuffer) {
                        flagged.push({
                            type: 'VIEWPORT OVERFLOW',
                            severity: 'CRITICAL',
                            message: `Fixed element overflowed the bottom edge of the screen by ${overflowPx} pixels.`,
                            element: getElementPath(el)
                        });
                    }
                }

                // 2. CONTAINER OVERFLOW
                // We check scrollWidth vs clientWidth, but we also look for manual Clipping 
                // if a parent has overflow: hidden but a child is clearly sticking out.
                const isOverflowHidden = ['hidden', 'scroll', 'auto', 'clip'].includes(style.overflow) || ['hidden', 'scroll', 'auto', 'clip'].includes(style.overflowX);
                
                if (el.scrollWidth > el.clientWidth + tolerance) {
                    const overflowPx = Math.round(el.scrollWidth - el.clientWidth);
                    
                    // NOISE REDUCTION: If a direct child already has a similar overflow, 
                    // this container is just the carrier, not the cause.
                    const children = Array.from(el.children);
                    const childExplainsIt = children.some(child => {
                        const cRect = child.getBoundingClientRect();
                        return cRect.right > rect.right + tolerance;
                    });

                    // If it's overflow hidden, we only flag if it's a "Top Level" container 
                    // that is probably causing visual clipping of the whole page.
                    if (isOverflowHidden && (el.clientWidth < viewportWidth - 50)) {
                        // Probably not an error if it's a small internal component with hidden overflow
                    } else if (!childExplainsIt) {
                        flagged.push({
                            type: 'CONTAINER OVERFLOW',
                            severity: 'WARNING',
                            message: `Content overflowed its container horizontally by ${overflowPx} pixels${isOverflowHidden ? ' (even with overflow:hidden)' : ''}.`,
                            element: getElementPath(el)
                        });
                    }
                }

                if (el.scrollHeight > el.clientHeight + tolerance && !['hidden', 'scroll', 'auto', 'clip'].includes(style.overflowY)) {
                    const overflowPx = Math.round(el.scrollHeight - el.clientHeight);
                    if (overflowPx > visualBuffer) {
                        flagged.push({
                            type: 'CONTAINER OVERFLOW',
                            severity: 'WARNING',
                            message: `Content overflowed its container vertically by ${overflowPx} pixels.`,
                            element: getElementPath(el)
                        });
                    }
                }
            });

            return flagged;
        }, { tolerance, excludeSelectors, visualBuffer: options.visualBuffer });

        if (issues.length > 0) {
            for (const issue of issues) {
                let screenshotPath = null;
                if (options.screenshots) {
                    try {
                        const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                        let pageBase = path.basename(new URL(url).pathname);
                        if (!pageBase || pageBase === '/') pageBase = 'index';
                        const filename = `${slugify(pageBase)}_${slugify(vp.name)}_${slugify(issue.element).slice(0, 30)}.png`;
                        screenshotPath = path.join(SCREENSHOTS_DIR, filename);
                        
                        const locator = page.locator(issue.element).first();
                        // Ensure element is visible and stable before screenshot
                        await locator.scrollIntoViewIfNeeded();
                        await locator.screenshot({ path: screenshotPath, timeout: 5000 });
                    } catch (e) {
                         screenshotPath = null; // Silent skip for screenshots on un-reachable elements
                    }
                }

                const issueData = { 
                    page: url, 
                    viewport: vp.name, 
                    ...issue,
                    screenshot: screenshotPath ? path.relative(process.cwd(), screenshotPath) : null
                };
                allResults.issues.push(issueData);
                
                if (!options.json) {
                    const icon = issue.severity === 'CRITICAL' ? '🚨' : '⚠️';
                    const color = issue.severity === 'CRITICAL' ? '\x1b[31m' : '\x1b[33m';
                    
                    console.log(`${icon} ${color}${issue.severity}: ${issue.type}\x1b[0m`);
                    console.log(`   Message : ${issue.message}`);
                    console.log(`   Element : \x1b[36m${issue.element}\x1b[0m`);
                    if (screenshotPath) {
                        console.log(`   Capture : \x1b[90m${path.relative(process.cwd(), screenshotPath)}\x1b[0m`);
                    }
                    console.log('');
                }
            }
        } else {
            await log('✅ No layout overflows detected.\n', 'success');
        }

        // CAPTURE SNAPSHOT for the Interactive Viewer
        if (options.view) {
            const snapshotPath = await capturePageSnapshot(page, url, vp.name);
            // Store snapshot reference in results for the UI
            allResults.pages_snapshots = allResults.pages_snapshots || {};
            allResults.pages_snapshots[url] = allResults.pages_snapshots[url] || {};
            allResults.pages_snapshots[url][vp.name] = snapshotPath;
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

  if (allResults.issues.length > 0 && options.screenshots) {
      await log(`📸 ${allResults.issues.filter(i => i.screenshot).length} screenshots saved to: ${path.relative(process.cwd(), SCREENSHOTS_DIR)}\n`, 'success');
  }

  if (options.view) {
      generateInteractiveReport(allResults);

      // Spin up a tiny HTTP server to serve the report dir (bypasses file:// iframe security block)
      await new Promise((resolve) => {
          const server = http.createServer((req, res) => {
              let filePath = path.join(REPORT_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
              const ext = path.extname(filePath);
              const mime = mimeTypes[ext] || 'text/plain';
              fs.readFile(filePath, (err, data) => {
                  if (err) { res.writeHead(404); res.end('Not found'); return; }
                  res.writeHead(200, { 'Content-Type': mime });
                  res.end(data);
              });
          });

          server.listen(0, '127.0.0.1', () => {
              const port = server.address().port;
              const viewerUrl = `http://127.0.0.1:${port}/`;
              log(`📊 Interactive viewer running at: ${viewerUrl}`, 'success');

              // Open browser
              const openCmd = process.platform === 'win32' ? `start "" "${viewerUrl}"` : process.platform === 'darwin' ? `open "${viewerUrl}"` : `xdg-open "${viewerUrl}"`;
              exec(openCmd, (err) => { if (err) log(`❌ Failed to open browser: ${err.message}`, 'error'); });

              log(`\n🟡 Viewer is live. Press ENTER to stop the server and exit.`, 'warn');
              const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
              rl2.question('', () => { rl2.close(); server.close(); resolve(); });
          });
      });
  }
  
  cleanupAuth();
  
  if (options.failOnIssue && allResults.issues.length > 0) {
      process.exit(EXITS.OVERFLOW_FOUND);
  }
  process.exit(EXITS.SUCCESS);
})();
