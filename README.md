# Check-Responsive 🚀

An automated pixel-precise responsive UI testing tool built with Playwright. This tool helps you quickly identify horizontal and internal content overflows across multiple viewports (Mobile, Tablet, Desktop) and intelligently crawls your application to test all linked pages.

## Key Features

- **🕸️ Intelligent Web Crawler**: Pass the `--crawl` flag to discover and test all linked pages inside your app automatically.
- **🔍 Auto-Detection**: Scans common development ports (3000, 5173, 5174, 8080) to find your running project if no URL is provided.
- **🚀 Auto-Startup**: If no server is running, it analyzes your `package.json` for a `dev` or `start` command and launches it.
- **⏳ Robust Waiting**: Monitors the port to wait for the server, and automatically waits for web fonts (`document.fonts.ready`) and animations to settle before evaluating the layout.
- **🎨 Expanded Viewport Support**: Tests everything from Mobile Portrait to Large Desktop (6 total viewports).
- **🛡️ Noise Reduction & Precision**: Automatically filters out "ignore-able" overflows like off-canvas menus, marquees, and 2px sub-pixel rounding errors.
- **🚨 Severity Grouping**: Distinctly highlights **Critical** (viewport-breaking) vs **Warning** (container-only) issues.
- **📸 Element Isolation**: Automatically captures cropped screenshots of every detected overflow (use `--screenshots`).
- **✨ Decorative Buffers**: Use `data-check-ignore` or `--visual-buffer` to bypass cursive/decorative font flourishes.
- **🔐 Interactive Authentication**: Automatically detects when a test gets redirected to login walls.
- **🤖 AI Agent Synchronization**: First-class support for AI coding agents with JSON output and machine-readable metadata.
- **🧹 Clean Teardown**: Automatically shuts down any dev servers it spawned.

## Installation

```bash
npm install
npx playwright install
```

### Make it Global

If you want to run `check-responsive` from anywhere on your terminal:

```bash
npm link
```

## Usage

From **any** repository with a dev server, let `check-responsive` figure it out:

```bash
check-responsive
```

Or target a specific URL:

```bash
check-responsive http://localhost:3000
```

### Advanced Options (Crawler & Delays)

Use the crawler to test an entire website and its routes:

```bash
check-responsive http://localhost:3000 --crawl
```

Restrict the crawler to only scan a specific route and its kids (sub-routes). Can be combined with `--depth`:

```bash
check-responsive http://localhost:3000/shop --subroutes --depth 2
```

Limit crawler depth (useful for huge applications):

```bash
check-responsive http://localhost:3000 --crawl --depth 2
```

Wait an extra 1000ms after load for complex micro-animations to finish:

```bash
check-responsive http://localhost:3000 --wait 1000
```

### Noise Reduction & Precision

The tool is designed to be "quiet" by default, ignoring common false positives that plague automated layout tests.

#### Sub-pixel Tolerance
Browsers often report 1px or 2px overflows due to rounding on high-DPI screens. By default, `check-responsive` ignores any overflow smaller than **2.0px**. You can adjust this:
```bash
check-responsive --tolerance 0.5
```

#### Smart Filtering
- **Off-canvas Elements**: Sidebars or menus that are `translate`-ed off-screen are automatically ignored if they are contained within an `overflow: hidden` parent.
- **Marquees & Tickers**: Elements with CSS animations named `marquee`, `ticker`, or `scroll` are bypassed to avoid cluttering your report.
- **Manual Exclusions**: Use the `--exclude` flag to skip specific problematic selectors:
```bash
check-responsive --exclude ".ads-banner, #cookie-consent"
```

#### Timeout Strategies
If your app uses constant polling (Stripe/Supabase), `networkidle` might hang. Switch strategies or increase timeouts:
```bash
check-responsive --timeout-strategy domcontentloaded --timeout 60000
```

### ✨ Advanced Buffers & Decorative Noise

For projects with heavy **cursive or decorative typography** (where a font's bounding box might be taller than its glyphs), use these tools:

#### 1. Visual Buffer
Ignore vertical overflows that are smaller than a specific pixel threshold:
```bash
check-responsive --visual-buffer 15
```

#### 2. The `data-check-ignore` Attribute
Add this attribute to any element (or its parent) that you want the auditor to skip entirely. Perfect for decorative off-canvas menus or SVGs:
```html
<div class="glow-effect" data-check-ignore>...</div>
```

### 📸 Bug Reports & Screenshots

Capture visual proof of every detected overflow to make fixing them faster:
```bash
check-responsive --screenshots
```
This will generate a `./responsive-report/screenshots/` folder containing cropped images of every failing element, labeled by page and viewport.

### 🤖 AI Agent Synchronization

`check-responsive` is designed to be fully controllable by AI agents and automated pipelines. 

#### JSON Output
Get a structured report of all tests and issues:
```bash
check-responsive --json
```

#### Non-Interactive Mode
Ensure the tool never hangs by disabling interactive prompts. If a login is required, it will exit with a specific error code.
```bash
check-responsive --non-interactive
```

#### Session Injection
Agents can provide pre-existing session data to skip manual login:
```bash
# Inject a cookie directly
check-responsive --auth-cookie "session_id=xyz123"

# Or use a Playwright storageState file
check-responsive --auth-file "./auth.json"
```

#### Machine-Readable Metadata
AI agents can run this flag to get a JSON-formatted guide of all available flags and usage patterns:
```bash
check-responsive --ai-help
```

### Authentication Handling

If the crawler runs into a login wall (e.g., getting redirected to `/login`), the CLI tool will pause and open a fully-interactive Chrome window. Simply fill in your username/password in that window and press `ENTER` inside the console. The crawler will securely rip the LocalStorage and Session Cookies out of the page and resume the automated test series without missing a beat!

To force this window to open immediately before testing starts, use:
```bash
check-responsive http://localhost:3000 --interactive
```

If your application uses a non-standard login path, tell the crawler what URL keyword implies a login wall:
```bash
check-responsive http://localhost:3000 --login-path "/authorize" 
```

### All CLI Options

```bash
Usage: check-responsive [options] [url]

Automated pixel-precise overflow detection tool.

Arguments:
  url                  Target URL(optional, will auto-detect dev servers if omitted)

Options:
  -V, --version        output the version number
  -c, --crawl                Crawl the site to find multiple routes and test them all
  -s, --subroutes            Restrict crawler to only scan sub-paths (kids) of the target URL
  -d, --depth <number>       Maximum link depth for crawling (default: "10")
  -w, --wait <ms>            Additional delay (in ms) to wait for animations after load (default: "500")
  -i, --interactive          Start in interactive UI mode to manually authenticate before scanning
  -l, --login-path <string>  Custom URL path keyword that triggers the interactive login flow
  -e, --exclude <selectors>  Comma-separated CSS selectors to ignore
  -t, --tolerance <number>  Overflow tolerance in pixels (default: "2.0")
  --timeout <number>         Navigation timeout in milliseconds (default: "30000")
  -p, --persist-auth         Keep the authentication state file between runs
  --json                     Output results as machine-readable JSON
  --non-interactive          Disable all interactive prompts and fail if auth is required
  --fail-on-issue            Exit with code 1 if any overflows are detected
  --auth-cookie <string>     Inject a session cookie (e.g., "name=value")
  --auth-file <path>         Use a custom Playwright storageState JSON file
  --ai-help                  Output structured JSON metadata for AI agents to understand CLI capabilities
  --screenshots              Capture element-level screenshots of all detected overflows
  --visual-buffer <number>   Vertical overflow buffer in pixels (default: 0)
  --persist-reports          Keep the responsive-report folder between runs
  -h, --help                 display help for command
```

## How It Works

1. **Port Scanning**: Connects to `localhost` on common ports using the `net` module.
2. **Startup**: If none are active, it checks `package.json` for known scripts (`dev`, `start`, `serve`).
3. **Route Discovery**: (If `--crawl` is passed) Uses Playwright to extract all `<a>` tags with the same origin to build a queue of routes to test.
4. **Analysis**: Evaluates the DOM in 6 different orientations and screen sizes to detect:
   - Elements overflowing the right or bottom of the screen bounds.
   - Elements overflowing the bounds of their parent container.
5. **Teardown**: Gracefully closes Chrome out, and if it started a dev server, kills the dev server process.

## License
MIT