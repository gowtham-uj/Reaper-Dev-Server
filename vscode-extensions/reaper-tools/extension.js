const path = require("path");
const vscode = require("vscode");

const BACKEND_URL = (process.env.REAPER_BACKEND_URL || "http://backend:4000").replace(/\/$/, "");
const INTERNAL_TOKEN = process.env.REAPER_INTERNAL_TOKEN || "development-internal-token";

function nonce() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function headers(actor) {
  return {
    "Content-Type": "application/json",
    "x-internal-token": INTERNAL_TOKEN,
    "x-reaper-actor": actor
  };
}

async function requestJson(path, options, actor) {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      ...(options && options.headers ? options.headers : {}),
      ...headers(actor)
    }
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { error: await response.text() };

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  return payload;
}

function resolveProjectPath() {
  const envProject = String(process.env.REAPER_PROJECT || "").trim();
  if (envProject) {
    return envProject;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return ".";
  }

  const folderPath = String(workspaceFolder.uri.fsPath || "").replace(/\\/g, "/");
  if (folderPath === "/workspace" || folderPath.endsWith("/workspace")) {
    return ".";
  }

  return path.basename(workspaceFolder.uri.fsPath);
}

function baseStyles() {
  return `
    :root {
      color-scheme: dark;
      --bg: #0a0a0a;
      --panel: rgba(10, 15, 20, 0.95);
      --line: rgba(0, 255, 204, 0.16);
      --muted: #90a1bb;
      --text: #ecf8ff;
      --green: #00ffcc;
      --purple: #bd00ff;
      font-family: ui-monospace, "IBM Plex Mono", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      background:
        radial-gradient(circle at top left, rgba(0, 255, 204, 0.08), transparent 28%),
        radial-gradient(circle at top right, rgba(189, 0, 255, 0.09), transparent 24%),
        var(--bg);
      color: var(--text);
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 12px;
      box-shadow: inset 0 0 0 1px rgba(189, 0, 255, 0.06);
    }
    .eyebrow {
      color: var(--green);
      letter-spacing: 0.22em;
      font-size: 11px;
      text-transform: uppercase;
    }
    h2 {
      margin: 8px 0 10px;
      font-size: 18px;
    }
    p {
      color: var(--muted);
      line-height: 1.45;
    }
    input, textarea, button {
      width: 100%;
      font: inherit;
      color: var(--text);
      border-radius: 12px;
      border: 1px solid rgba(0, 255, 204, 0.18);
      background: rgba(5, 8, 12, 0.88);
      padding: 10px;
      outline: none;
    }
    textarea {
      min-height: 120px;
      resize: vertical;
    }
    button {
      cursor: pointer;
      background: linear-gradient(135deg, rgba(0, 255, 204, 0.18), rgba(189, 0, 255, 0.16));
      margin-top: 10px;
    }
    .output, .list {
      margin-top: 12px;
      padding: 10px;
      background: rgba(5, 8, 12, 0.9);
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.04);
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .list {
      display: grid;
      gap: 8px;
      max-height: 240px;
      overflow: auto;
    }
    .item {
      padding: 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.025);
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .status {
      margin-top: 8px;
      color: var(--green);
    }
    .error {
      color: #ff8ba1;
      margin-top: 10px;
    }
    .grid {
      display: grid;
      gap: 10px;
    }
    .mini-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .metric {
      padding: 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }
    .metric .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .metric .value {
      font-size: 18px;
    }
    svg {
      width: 100%;
      height: 80px;
      margin-top: 8px;
      overflow: visible;
    }
  `;
}

class MonitorViewProvider {
  resolveWebviewView(webviewView) {
    const panelNonce = nonce();
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = `
      <!doctype html>
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${panelNonce}';">
          <style>${baseStyles()}</style>
        </head>
        <body>
          <div class="card">
            <div class="eyebrow">REAPER // MONITOR</div>
            <h2>Live host telemetry</h2>
            <div class="mini-grid">
              <div class="metric"><div class="label">CPU</div><div class="value" id="cpu">0%</div></div>
              <div class="metric"><div class="label">Memory</div><div class="value" id="memory">0%</div></div>
              <div class="metric"><div class="label">Disk</div><div class="value" id="disk">0%</div></div>
              <div class="metric"><div class="label">Net RX/TX</div><div class="value" id="network">0 / 0</div></div>
            </div>
            <svg id="cpuChart"></svg>
            <svg id="memoryChart"></svg>
            <svg id="networkChart"></svg>
            <div class="error" id="error"></div>
          </div>
          <script nonce="${panelNonce}">
            const vscode = acquireVsCodeApi();
            const points = { cpu: [], memory: [], network: [] };

            function setText(id, value) {
              document.getElementById(id).textContent = value;
            }

            function formatRate(value) {
              if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(2) + " MB/s";
              if (value >= 1024) return (value / 1024).toFixed(2) + " KB/s";
              return Math.round(value) + " B/s";
            }

            function renderChart(id, values, stroke) {
              const svg = document.getElementById(id);
              const width = svg.clientWidth || 260;
              const height = 80;
              const max = Math.max(...values, 1);
              const step = values.length > 1 ? width / (values.length - 1) : width;
              const polyline = values
                .map((value, index) => {
                  const x = index * step;
                  const y = height - (value / max) * (height - 8) - 4;
                  return x + "," + y;
                })
                .join(" ");
              svg.innerHTML = "<polyline fill='none' stroke='" + stroke + "' stroke-width='3' points='" + polyline + "' />";
            }

            window.addEventListener("message", (event) => {
              const snapshot = event.data.snapshot;
              if (!snapshot) return;

              points.cpu.push(snapshot.cpu.usagePercent);
              points.memory.push(snapshot.memory.usagePercent);
              points.network.push((snapshot.network.rxBytesPerSecond + snapshot.network.txBytesPerSecond) / 1024);
              Object.keys(points).forEach((key) => {
                points[key] = points[key].slice(-24);
              });

              setText("cpu", snapshot.cpu.usagePercent + "%");
              setText("memory", snapshot.memory.usagePercent + "%");
              setText("disk", snapshot.disk.usagePercent + "%");
              setText(
                "network",
                formatRate(snapshot.network.rxBytesPerSecond) + " / " + formatRate(snapshot.network.txBytesPerSecond)
              );

              renderChart("cpuChart", points.cpu, "#00ffcc");
              renderChart("memoryChart", points.memory, "#bd00ff");
              renderChart("networkChart", points.network, "#78ff46");
            });

            vscode.postMessage({ type: "startMonitor" });
          </script>
        </body>
      </html>
    `;

    let interval = null;

    const sendSnapshot = async () => {
      try {
        const payload = await requestJson("/api/monitor/snapshot", {}, "vscode-monitor");
        const snapshot = payload.current || payload.samples?.[payload.samples.length - 1];
        if (snapshot) {
          webviewView.webview.postMessage({ snapshot });
        }
      } catch (error) {
        webviewView.webview.postMessage({
          snapshot: null,
          error: error.message
        });
      }
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type !== "startMonitor") {
        return;
      }

      await sendSnapshot();
      if (!interval) {
        interval = setInterval(() => {
          sendSnapshot().catch(() => {});
        }, 2000);
      }
    });

    webviewView.onDidDispose(() => {
      if (interval) {
        clearInterval(interval);
      }
    });
  }
}

class SshViewProvider {
  resolveWebviewView(webviewView) {
    const panelNonce = nonce();
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = `
      <!doctype html>
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${panelNonce}';">
          <style>${baseStyles()}</style>
        </head>
        <body>
          <div class="card">
            <div class="eyebrow">REAPER // SSH</div>
            <h2>Controlled command execution</h2>
            <p>Single-shot SSH exec only. Root logins are blocked by the backend.</p>
            <div class="grid">
              <input id="host" placeholder="Host" />
              <input id="port" placeholder="Port" value="22" />
              <input id="username" placeholder="Username" />
              <input id="password" placeholder="Password" type="password" />
              <textarea id="privateKey" placeholder="Optional private key"></textarea>
              <textarea id="command">uname -a && whoami</textarea>
              <button id="run">Execute SSH command</button>
              <div class="error" id="error"></div>
              <div class="output" id="output">No command executed yet.</div>
            </div>
          </div>
          <script nonce="${panelNonce}">
            const vscode = acquireVsCodeApi();
            document.getElementById("run").addEventListener("click", () => {
              document.getElementById("error").textContent = "";
              vscode.postMessage({
                type: "executeSsh",
                payload: {
                  host: document.getElementById("host").value,
                  port: Number(document.getElementById("port").value || 22),
                  username: document.getElementById("username").value,
                  password: document.getElementById("password").value,
                  privateKey: document.getElementById("privateKey").value,
                  command: document.getElementById("command").value
                }
              });
            });

            window.addEventListener("message", (event) => {
              const message = event.data;
              if (message.type === "sshOutput") {
                document.getElementById("output").textContent = message.value;
              }
              if (message.type === "sshError") {
                document.getElementById("error").textContent = message.value;
              }
            });
          </script>
        </body>
      </html>
    `;

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type !== "executeSsh") {
        return;
      }

      try {
        const payload = await requestJson(
          "/api/ssh/execute",
          {
            method: "POST",
            body: JSON.stringify(message.payload)
          },
          "vscode-ssh"
        );
        const output = [
          `exitCode=${payload.exitCode}`,
          payload.stdout ? `\nSTDOUT\n${payload.stdout}` : "",
          payload.stderr ? `\nSTDERR\n${payload.stderr}` : ""
        ]
          .join("\n")
          .trim();
        webviewView.webview.postMessage({ type: "sshOutput", value: output });
      } catch (error) {
        webviewView.webview.postMessage({
          type: "sshError",
          value: error.message || "SSH request failed"
        });
      }
    });
  }
}

class ProjectShellTerminalPty {
  constructor({ projectPath, session, actor, onClose }) {
    this.projectPath = projectPath;
    this.session = session;
    this.actor = actor;
    this.onCloseCallback = onClose;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    this.connectionId = null;
    this.closed = false;
    this.dimensions = null;
    this.streamPromise = null;
  }

  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  async open(initialDimensions) {
    this.dimensions = initialDimensions || null;
    try {
      const payload = await requestJson(
        "/api/internal/ide-terminals",
        {
          method: "POST",
          body: JSON.stringify({
            path: this.projectPath,
            sessionId: this.session.sessionId
          })
        },
        this.actor
      );
      this.connectionId = payload.connectionId || null;

      if (this.connectionId && this.dimensions) {
        await this.resize(this.dimensions.columns, this.dimensions.rows);
      }

      if (this.connectionId) {
        this.streamPromise = this.readStream().catch((error) => {
          if (!this.closed) {
            this.writeEmitter.fire(`\r\n[Reaper] ${error.message || "Terminal session ended"}\r\n`);
            void this.close();
          }
        });
      }
    } catch (error) {
      this.writeEmitter.fire(`\r\n[Reaper] ${error.message || "Unable to open terminal session"}\r\n`);
      void this.close();
    }
  }

  async readStream() {
    const response = await fetch(
      `${BACKEND_URL}/api/internal/ide-terminals/${encodeURIComponent(this.connectionId)}/stream`,
      {
        headers: headers(this.actor)
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to attach terminal session (${response.status})`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Terminal stream unavailable");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (!this.closed) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const rawLine = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (rawLine) {
          this.handleEvent(JSON.parse(rawLine));
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    if (!this.closed) {
      await this.close();
    }
  }

  handleEvent(event) {
    if (!event || this.closed) {
      return;
    }

    if (event.type === "output") {
      this.writeEmitter.fire(Buffer.from(String(event.data || ""), "base64").toString("utf8"));
      return;
    }

    if (event.type === "error") {
      this.writeEmitter.fire(`\r\n[Reaper] ${event.message || "Terminal session error"}\r\n`);
      void this.close();
      return;
    }

    if (event.type === "close") {
      void this.close();
    }
  }

  async resize(cols, rows) {
    if (!this.connectionId || this.closed) {
      return;
    }

    await requestJson(
      `/api/internal/ide-terminals/${encodeURIComponent(this.connectionId)}/resize`,
      {
        method: "POST",
        body: JSON.stringify({
          cols,
          rows
        })
      },
      this.actor
    ).catch(() => {});
  }

  handleInput(data) {
    if (!this.connectionId || this.closed || !data) {
      return;
    }

    void requestJson(
      `/api/internal/ide-terminals/${encodeURIComponent(this.connectionId)}/input`,
      {
        method: "POST",
        body: JSON.stringify({ data })
      },
      this.actor
    ).catch(() => {});
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.connectionId) {
      await requestJson(
        `/api/internal/ide-terminals/${encodeURIComponent(this.connectionId)}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            destroySession: false
          })
        },
        this.actor
      ).catch(() => {});
    }

    this.closeEmitter.fire();
    this.onCloseCallback?.();
  }

  dispose() {
    return this.close();
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("reaper.monitorView", new MonitorViewProvider())
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("reaper.sshView", new SshViewProvider())
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
