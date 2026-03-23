#!/usr/bin/env node
/**
 * Cross-platform daemon manager for wechat-claude-code
 * Supports: Windows (node-persist), macOS (launchd), Linux (systemd user service)
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const DATA_DIR = join(process.env.HOME || process.env.USERPROFILE || '', '.wechat-claude-code');
const PLATFORM = process.platform;

// Helper to get node binary path
function getNodeBin() {
  try {
    return execSync('node -e "console.log(process.execPath)"', { encoding: 'utf-8' }).trim();
  } catch {
    return 'node';
  }
}

const NODE_BIN = getNodeBin();

// -----------------------------------------------------------------------------
// Windows Daemon Management (using node-persist / background process)
// -----------------------------------------------------------------------------

class WindowsDaemon {
  getPidFilePath() {
    return join(DATA_DIR, 'daemon.pid');
  }

  getLogPath() {
    return join(DATA_DIR, 'logs', 'daemon.log');
  }

  // Run in foreground (directly show console output)
  run() {
    console.log('Running wechat-claude-code in foreground mode...');
    console.log('Press Ctrl+C to stop\n');

    // Spawn child without detached, inherit stdio to show output
    const child = spawn(NODE_BIN, [join(PROJECT_DIR, 'dist', 'main.js'), 'start'], {
      stdio: 'inherit',
      windowsHide: false,
    });

    child.on('exit', (code) => {
      console.log(`\nProcess exited with code ${code}`);
      process.exit(code || 0);
    });

    // Forward signals to child
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  }

  isRunning() {
    const pidFile = this.getPidFilePath();
    if (!existsSync(pidFile)) return false;

    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());
      // Try to send signal 0 to check if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      // Process doesn't exist, clean up stale pid file
      try { unlinkSync(pidFile); } catch {}
      return false;
    }
  }

  start() {
    if (this.isRunning()) {
      console.log('Already running');
      return;
    }

    mkdirSync(join(DATA_DIR, 'logs'), { recursive: true });

    // Use node's built-in daemon capability on Windows
    const logPath = this.getLogPath();
    const child = spawn(NODE_BIN, [join(PROJECT_DIR, 'dist', 'main.js'), 'start'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Redirect output to log file
    const logStream = createWriteStream(logPath, { flags: 'a' });
    if (child.stdout) child.stdout.pipe(logStream);
    if (child.stderr) child.stderr.pipe(logStream);

    child.unref();
    writeFileSync(this.getPidFilePath(), String(child.pid));

    console.log('Started wechat-claude-code daemon');
  }

  stop() {
    const pidFile = this.getPidFilePath();
    if (!existsSync(pidFile)) {
      console.log('Not running');
      return;
    }

    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());

      // Windows: use taskkill to kill process tree
      execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: 'ignore', shell: true });
      unlinkSync(pidFile);
      console.log('Stopped wechat-claude-code daemon');
    } catch (err) {
      console.log('Failed to stop daemon:', err.message);
    }
  }

  status() {
    if (this.isRunning()) {
      const pid = parseInt(readFileSync(this.getPidFilePath(), 'utf-8').trim());
      console.log(`Running (PID: ${pid})`);
    } else {
      console.log('Not running');
    }
  }

  logs() {
    const logPath = this.getLogPath();
    if (existsSync(logPath)) {
      try {
        const content = readFileSync(logPath, 'utf-8');
        const lines = content.split('\n');
        const lastLines = lines.slice(-100);
        console.log(lastLines.join('\n'));
      } catch (err) {
        console.log('Error reading logs:', err.message);
      }
    } else {
      console.log('No logs found');
    }
  }

  restart() {
    this.stop();
    setTimeout(() => this.start(), 1000);
  }
}

// -----------------------------------------------------------------------------
// macOS Daemon Management (using launchd)
// -----------------------------------------------------------------------------

class MacOSDaemon {
  getLabel() {
    return 'com.wechat-claude-code.bridge';
  }

  getPlistPath() {
    return join(process.env.HOME, 'Library', 'LaunchAgents', `${this.getLabel()}.plist`);
  }

  // Run in foreground
  run() {
    console.log('Running wechat-claude-code in foreground mode...');
    console.log('Press Ctrl+C to stop\n');

    const child = spawn(NODE_BIN, [join(PROJECT_DIR, 'dist', 'main.js'), 'start'], {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      console.log(`\nProcess exited with code ${code}`);
      process.exit(code || 0);
    });

    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  }

  isLoaded() {
    try {
      execSync(`launchctl print gui/${process.getuid()}/${this.getLabel()} 2>/dev/null`, {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  getPid() {
    try {
      const result = execSync('pgrep -f "dist/main.js start" 2>/dev/null | head -1', {
        encoding: 'utf-8',
      });
      return result.trim();
    } catch {
      return null;
    }
  }

  start() {
    if (this.isLoaded()) {
      console.log('Already running (or plist loaded)');
      return;
    }

    mkdirSync(join(DATA_DIR, 'logs'), { recursive: true });

    const plistPath = this.getPlistPath();
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${this.getLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROJECT_DIR}/dist/main.js</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DATA_DIR}/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${DATA_DIR}/logs/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_BIN}/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

    writeFileSync(plistPath, plistContent);
    execSync(`launchctl load "${plistPath}"`);
    console.log('Started wechat-claude-code daemon');
  }

  stop() {
    try {
      execSync(`launchctl bootout "gui/${process.getuid()}/${this.getLabel()}" 2>/dev/null`, {
        stdio: 'ignore',
      });
    } catch {}
    unlinkSync(this.getPlistPath());
    console.log('Stopped wechat-claude-code daemon');
  }

  status() {
    if (this.isLoaded()) {
      const pid = this.getPid();
      if (pid) {
        console.log(`Running (PID: ${pid})`);
      } else {
        console.log('Loaded but not running');
      }
    } else {
      console.log('Not running');
    }
  }

  logs() {
    const logDir = join(DATA_DIR, 'logs');
    if (existsSync(logDir)) {
      try {
        const result = execSync(`ls -t "${logDir}"/bridge-*.log 2>/dev/null | head -1`, {
          encoding: 'utf-8',
          shell: true,
        });
        const latest = result.trim();
        if (latest) {
          execSync(`tail -100 "${latest}"`, { stdio: 'inherit' });
          return;
        }
      } catch {}

      console.log('No bridge logs found. Checking stdout/stderr:');
      for (const f of ['stdout.log', 'stderr.log']) {
        const logPath = join(logDir, f);
        if (existsSync(logPath)) {
          console.log(`\n=== ${f} ===`);
          execSync(`tail -30 "${logPath}"`, { stdio: 'inherit' });
        }
      }
    } else {
      console.log('No logs found');
    }
  }

  restart() {
    this.stop();
    setTimeout(() => this.start(), 1000);
  }
}

// -----------------------------------------------------------------------------
// Linux Daemon Management (using systemd user service)
// -----------------------------------------------------------------------------

class LinuxDaemon {
  getServiceName() {
    return 'wechat-claude-code.service';
  }

  getUnitPath() {
    const systemdDir = join(process.env.HOME, '.config', 'systemd', 'user');
    return join(systemdDir, this.getServiceName());
  }

  // Run in foreground
  run() {
    console.log('Running wechat-claude-code in foreground mode...');
    console.log('Press Ctrl+C to stop\n');

    const child = spawn(NODE_BIN, [join(PROJECT_DIR, 'dist', 'main.js'), 'start'], {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      console.log(`\nProcess exited with code ${code}`);
      process.exit(code || 0);
    });

    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  }

  start() {
    try {
      execSync(`systemctl --user start ${this.getServiceName()}`, { stdio: 'inherit' });
    } catch (err) {
      // Service might not be installed yet
      this.install();
      execSync(`systemctl --user start ${this.getServiceName()}`, { stdio: 'inherit' });
    }
    console.log('Started wechat-claude-code daemon');
  }

  stop() {
    execSync(`systemctl --user stop ${this.getServiceName()}`, { stdio: 'inherit' });
    console.log('Stopped wechat-claude-code daemon');
  }

  status() {
    try {
      execSync(`systemctl --user status ${this.getServiceName()}`, { stdio: 'inherit' });
    } catch {
      console.log('Not running');
    }
  }

  logs() {
    execSync(`journalctl --user -u ${this.getServiceName()} -n 100 --no-pager`, { stdio: 'inherit' });
  }

  restart() {
    execSync(`systemctl --user restart ${this.getServiceName()}`, { stdio: 'inherit' });
  }

  install() {
    const systemdDir = join(process.env.HOME, '.config', 'systemd', 'user');
    mkdirSync(systemdDir, { recursive: true });

    const unitPath = this.getUnitPath();
    const unitContent = `[Unit]
Description=WeChat Claude Code Bridge
After=network.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${join(PROJECT_DIR, 'dist', 'main.js')} start
WorkingDirectory=${PROJECT_DIR}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;

    writeFileSync(unitPath, unitContent);
    execSync(`systemctl --user daemon-reload`, { stdio: 'inherit' });
    console.log('Installed systemd user service');
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function getDaemon() {
  switch (PLATFORM) {
    case 'win32':
      return new WindowsDaemon();
    case 'darwin':
      return new MacOSDaemon();
    default:
      return new LinuxDaemon();
  }
}

const daemon = getDaemon();
const command = process.argv[2];

switch (command) {
  case 'run':
    daemon.run();
    break;
  case 'start':
    daemon.start();
    break;
  case 'stop':
    daemon.stop();
    break;
  case 'restart':
    daemon.restart();
    break;
  case 'status':
    daemon.status();
    break;
  case 'logs':
    daemon.logs();
    break;
  default:
    console.log(`Usage: daemon {run|start|stop|restart|status|logs}`);
    console.log(`Platform: ${PLATFORM}`);
    console.log('');
    console.log('  run     - Run in foreground (shows console output)');
    console.log('  start   - Start as daemon (background)');
    console.log('  stop    - Stop daemon');
    console.log('  restart - Restart daemon');
    console.log('  status  - Show running status');
    console.log('  logs    - Show daemon logs');
    break;
}
