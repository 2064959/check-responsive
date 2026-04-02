# Check-Responsive 🚀

An automated pixel-precise responsive UI testing tool built with Playwright. This tool helps you quickly identify horizontal and internal content overflows across multiple viewports (Mobile, Tablet, Desktop) and intelligently crawls your application to test all linked pages.

## Key Features

- **🕸️ Intelligent Web Crawler**: Pass the `--crawl` flag to discover and test all linked pages inside your app automatically.
- **🔍 Auto-Detection**: Scans common development ports (3000, 5173, 5174, 8080) to find your running project if no URL is provided.
- **🚀 Auto-Startup**: If no server is running, it analyzes your `package.json` for a `dev` or `start` command and launches it.
- **⏳ Robust Waiting**: Monitors the port to wait for the server, and automatically waits for web fonts (`document.fonts.ready`) and animations to settle before evaluating the layout.
- **🎨 Expanded Viewport Support**: Tests everything from Mobile Portrait to Large Desktop (6 total viewports).
- **🔐 Interactive Authentication**: Automatically detects when a test gets redirected to a login wall. Pauses the background scan, opens a visible browser for you to log in manually, saves your session tokens, and securely resumes the headless scan.
- **🧹 Clean Teardown**: Automatically shuts down any dev servers it spawned after testing completes.

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