# Check-Responsive 🚀

An automated responsive UI testing tool built with Playwright. This tool helps you quickly identify horizontal and internal content overflows across multiple viewports (Mobile, Tablet, Desktop).

## Key Features

- **🔍 Auto-Detection**: Scans common development ports (3000, 5173, 5174, 8080) to find your running project.
- **🚀 Auto-Startup**: If no server is running, it analyzes your `package.json` for a `dev` or `start` command and launches it.
- **⏳ Wait for Ready**: Monitors the port and waits for the server to be responsive before running tests.
- **🎨 Multi-Viewport Support**: Automatically tests for:
  - Mobile Portrait (375x667)
  - Tablet Portrait (768x1024)
  - Small Desktop (1024x768)
  - Large Desktop (1440x900)
- **🌍 Global Command**: Once linked, run it from any repository on your machine.

## Installation

1. **Install Dependencies**:
   ```bash
   npm install
   npx playwright install
   ```

2. **Make it Global**:
   ```bash
   npm link
   ```

## Usage

From **any** repository with a dev server, simply run:
```bash
check-responsive
```

Or target a specific URL:
```bash
check-responsive http://localhost:1234
```

## How It Works

1. **Port Scanning**: Connects to `localhost` on common ports using the `net` module.
2. **Startup**: If none are active, it checks `package.json` for known scripts (`dev`, `start`, `serve`).
3. **Analysis**: Injects a custom JavaScript snippet into each viewport to detect elements with:
   - `rect.right > clientWidth` (Horizontal overflow)
   - `scrollWidth > clientWidth` (Internal content overflow)

## License
MIT