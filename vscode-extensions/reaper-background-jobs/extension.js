const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");

function nonce() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function resolveProjectPath() {
  const envProject = String(process.env.REAPER_PROJECT || "").trim();
  if (envProject) {
    return envProject;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return "";
  }

  return path.basename(workspaceFolder.uri.fsPath);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function detectPackageManager(workspacePath) {
  if (await pathExists(path.join(workspacePath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (await pathExists(path.join(workspacePath, "yarn.lock"))) {
    return "yarn";
  }

  if (
    (await pathExists(path.join(workspacePath, "bun.lockb"))) ||
    (await pathExists(path.join(workspacePath, "bun.lock")))
  ) {
    return "bun";
  }

  return "npm";
}

function buildScriptCommand(packageManager, scriptName) {
  if (packageManager === "yarn") {
    return `yarn ${scriptName}`;
  }

  if (packageManager === "pnpm") {
    return `pnpm run ${scriptName}`;
  }

  if (packageManager === "bun") {
    return `bun run ${scriptName}`;
  }

  return `npm run ${scriptName}`;
}

function inferDevServerPort(scriptValue) {
  const normalized = String(scriptValue || "").toLowerCase();
  if (normalized.includes("vite")) {
    return 5173;
  }

  if (normalized.includes("next")) {
    return 3000;
  }

  if (normalized.includes("storybook")) {
    return 6006;
  }

  if (normalized.includes("gatsby")) {
    return 8000;
  }

  return null;
}

async function detectCommandPresets() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return [];
  }

  const workspacePath = workspaceFolder.uri.fsPath;
  const packageJsonPath = path.join(workspacePath, "package.json");

  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  } catch (error) {
    return [];
  }

  const scripts = manifest?.scripts || {};
  const packageManager = await detectPackageManager(workspacePath);
  const installCommand =
    packageManager === "yarn"
      ? "yarn install"
      : packageManager === "pnpm"
        ? "pnpm install"
        : packageManager === "bun"
          ? "bun install"
          : "npm install";

  const presets = [
    {
      label: "Install",
      name: "Install dependencies",
      command: installCommand,
      servicePort: null
    }
  ];

  if (typeof scripts.build === "string" && scripts.build.trim()) {
    presets.push({
      label: "Build",
      name: "Build project",
      command: buildScriptCommand(packageManager, "build"),
      servicePort: null
    });
  }

  if (typeof scripts.dev === "string" && scripts.dev.trim()) {
    presets.push({
      label: "Dev Server",
      name: "Start dev server",
      command: buildScriptCommand(packageManager, "dev"),
      servicePort: inferDevServerPort(scripts.dev)
    });
  }

  return presets;
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
      --danger: #ff647c;
      font-family: "SFMono-Regular", "Cascadia Mono", Consolas, monospace;
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
      display: grid;
      gap: 12px;
    }
    .eyebrow {
      color: var(--green);
      letter-spacing: 0.22em;
      font-size: 11px;
      text-transform: uppercase;
    }
    h2 {
      margin: 8px 0 0;
      font-size: 18px;
    }
    p, .meta, .hint {
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
      min-height: 132px;
      resize: vertical;
    }
    button {
      cursor: pointer;
      background: linear-gradient(135deg, rgba(0, 255, 204, 0.18), rgba(189, 0, 255, 0.16));
    }
    button.secondary {
      background: rgba(255, 255, 255, 0.04);
      color: var(--muted);
    }
    button.danger {
      background: rgba(255, 100, 124, 0.1);
      border-color: rgba(255, 100, 124, 0.22);
      color: #ffb4c1;
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .grid {
      display: grid;
      gap: 10px;
    }
    .preset-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .preset-strip button {
      width: auto;
      padding: 8px 12px;
    }
    .row {
      display: flex;
      gap: 8px;
    }
    .row > * {
      flex: 1 1 0;
    }
    .status, .error {
      border-radius: 12px;
      padding: 10px;
      font-size: 12px;
    }
    .status {
      background: rgba(0, 255, 204, 0.08);
      border: 1px solid rgba(0, 255, 204, 0.14);
      color: var(--green);
    }
    .error {
      background: rgba(255, 100, 124, 0.08);
      border: 1px solid rgba(255, 100, 124, 0.14);
      color: #ff9fb0;
    }
    .jobs {
      display: grid;
      gap: 8px;
      max-height: 240px;
      overflow: auto;
    }
    .job-item {
      display: grid;
      gap: 4px;
      padding: 10px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.04);
      cursor: pointer;
    }
    .job-item.active {
      border-color: rgba(0, 255, 204, 0.32);
      box-shadow: 0 0 0 1px rgba(0, 255, 204, 0.14);
    }
    .job-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .job-name {
      font-size: 13px;
      color: var(--text);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: rgba(255, 255, 255, 0.04);
      color: var(--muted);
    }
    .pill.running {
      color: var(--green);
      border: 1px solid rgba(0, 255, 204, 0.18);
    }
    .pill.exited {
      color: #ffd88c;
      border: 1px solid rgba(255, 216, 140, 0.18);
    }
    .log {
      white-space: pre-wrap;
      min-height: 220px;
      max-height: 320px;
      overflow: auto;
      padding: 10px;
      border-radius: 14px;
      background: rgba(5, 8, 12, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 12px;
      line-height: 1.45;
    }
  `;
}

class BackgroundJobsViewProvider {
  async resolveWebviewView(webviewView) {
    const panelNonce = nonce();
    const projectPath = resolveProjectPath();
    const commandPresets = await detectCommandPresets();

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = `
      <!doctype html>
      <html>
        <head>
          <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${panelNonce}';"
          >
          <style>${baseStyles()}</style>
        </head>
        <body>
          <div class="card">
            <div>
              <div class="eyebrow">REAPER // BACKGROUND</div>
              <h2>Background Jobs</h2>
              <p>Run heavy commands in a separate project container so the IDE stays responsive.</p>
            </div>
            <div class="hint">Project: <code id="projectPath"></code></div>
            <div class="grid">
              <input id="jobName" placeholder="Optional job name" />
              <textarea id="jobCommand" placeholder="npm install && npm run build"></textarea>
              <div class="preset-strip" id="presetStrip"></div>
              <input id="jobPort" type="number" min="1" max="65535" placeholder="Optional dev server port, for example 3000 or 5173" />
              <div class="hint">Set a port only when the command starts a web server that listens on 0.0.0.0.</div>
              <div class="row">
                <button id="runJob">Run In Background</button>
                <button id="refreshJobs" class="secondary">Refresh</button>
              </div>
            </div>
            <div id="status" class="status" hidden></div>
            <div id="error" class="error" hidden></div>
            <div class="jobs" id="jobs"></div>
            <div class="row">
              <button id="openDevServer" class="secondary" disabled>Open Dev Server</button>
              <button id="stopJob" class="danger" disabled>Stop Selected Job</button>
            </div>
            <div class="meta" id="jobMeta">No background job selected.</div>
            <div class="log" id="jobLog">Select a job to inspect its live output.</div>
          </div>
          <script nonce="${panelNonce}">
            const state = {
              projectPath: ${JSON.stringify(projectPath)},
              commandPresets: ${JSON.stringify(commandPresets)},
              selectedJobId: "",
              jobs: []
            };

            const projectPathNode = document.getElementById("projectPath");
            const jobsNode = document.getElementById("jobs");
            const jobMetaNode = document.getElementById("jobMeta");
            const jobLogNode = document.getElementById("jobLog");
            const stopButton = document.getElementById("stopJob");
            const openDevServerButton = document.getElementById("openDevServer");
            const runButton = document.getElementById("runJob");
            const refreshButton = document.getElementById("refreshJobs");
            const jobNameInput = document.getElementById("jobName");
            const jobCommandInput = document.getElementById("jobCommand");
            const jobPortInput = document.getElementById("jobPort");
            const presetStripNode = document.getElementById("presetStrip");
            const statusNode = document.getElementById("status");
            const errorNode = document.getElementById("error");

            projectPathNode.textContent = state.projectPath || "unavailable";

            function setStatus(message) {
              statusNode.hidden = !message;
              statusNode.textContent = message || "";
            }

            function setError(message) {
              errorNode.hidden = !message;
              errorNode.textContent = message || "";
            }

            function escapeHtml(value) {
              return String(value || "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
            }

            async function requestJson(requestPath, options = {}) {
              const response = await fetch(requestPath, {
                credentials: "include",
                headers: {
                  "Content-Type": "application/json",
                  ...(options.headers || {})
                },
                ...options
              });
              const contentType = response.headers.get("content-type") || "";
              const payload = contentType.includes("application/json")
                ? await response.json()
                : { error: await response.text() };

              if (!response.ok) {
                throw new Error(payload.error || "Request failed");
              }

              return payload;
            }

            function selectedJob() {
              return state.jobs.find((job) => job.jobId === state.selectedJobId) || null;
            }

            function renderPresets() {
              if (!state.commandPresets.length) {
                presetStripNode.innerHTML = "";
                return;
              }

              presetStripNode.innerHTML = state.commandPresets
                .map((preset, index) => {
                  return \`<button class="secondary" type="button" data-preset-index="\${index}">\${escapeHtml(preset.label)}</button>\`;
                })
                .join("");

              Array.from(presetStripNode.querySelectorAll("[data-preset-index]")).forEach((button) => {
                button.addEventListener("click", () => {
                  const presetIndex = Number.parseInt(button.getAttribute("data-preset-index") || "-1", 10);
                  const preset = state.commandPresets[presetIndex];
                  if (!preset) {
                    return;
                  }

                  jobNameInput.value = preset.name || "";
                  jobCommandInput.value = preset.command || "";
                  jobPortInput.value =
                    preset.servicePort === null || preset.servicePort === undefined
                      ? ""
                      : String(preset.servicePort);
                  setStatus(\`Loaded \${preset.label.toLowerCase()} preset.\`);
                  window.setTimeout(() => setStatus(""), 1800);
                });
              });
            }

            function renderJobs() {
              if (!state.jobs.length) {
                jobsNode.innerHTML = "<div class=\\"meta\\">No background jobs yet.</div>";
                stopButton.disabled = true;
                openDevServerButton.disabled = true;
                return;
              }

              jobsNode.innerHTML = state.jobs
                .map((job) => {
                  const active = job.jobId === state.selectedJobId ? " active" : "";
                  const statusClass = job.running ? "running" : "exited";
                  const exitCode =
                    job.exitCode === null || job.exitCode === undefined ? "" : " | exit " + job.exitCode;
                  return \`
                    <button class="job-item\${active}" type="button" data-job-id="\${escapeHtml(job.jobId)}">
                      <div class="job-head">
                        <div class="job-name">\${escapeHtml(job.name || job.commandPreview || "Background job")}</div>
                        <span class="pill \${statusClass}">\${escapeHtml(job.state || "unknown")}\${escapeHtml(exitCode)}</span>
                      </div>
                      <div class="meta">\${escapeHtml(job.commandPreview || "")}</div>
                    </button>
                  \`;
                })
                .join("");

              Array.from(jobsNode.querySelectorAll("[data-job-id]")).forEach((button) => {
                button.addEventListener("click", () => {
                  state.selectedJobId = button.getAttribute("data-job-id") || "";
                  renderJobs();
                  void loadLogs();
                });
              });

              const job = selectedJob();
              stopButton.disabled = !(job && job.running);
              openDevServerButton.disabled = !(job && job.devServerUrl);
            }

            async function loadJobs({ preserveSelection = true } = {}) {
              if (!state.projectPath) {
                setError("Project path is not available for background jobs.");
                return;
              }

              try {
                const payload = await requestJson(
                  \`/api/projects/background-jobs?path=\${encodeURIComponent(state.projectPath)}\`
                );
                state.jobs = payload.items || [];
                if (!preserveSelection || !state.jobs.some((job) => job.jobId === state.selectedJobId)) {
                  state.selectedJobId = state.jobs[0]?.jobId || "";
                }
                renderJobs();
              } catch (error) {
                setError(error.message);
              }
            }

            async function loadLogs() {
              const job = selectedJob();
              if (!job) {
                jobMetaNode.textContent = "No background job selected.";
                jobLogNode.textContent = "Select a job to inspect its live output.";
                stopButton.disabled = true;
                openDevServerButton.disabled = true;
                return;
              }

              try {
                const payload = await requestJson(
                  \`/api/projects/background-jobs/\${encodeURIComponent(job.jobId)}/logs\`
                );
                const currentJob = payload.job || job;
                jobMetaNode.textContent =
                  \`\${currentJob.name} | \${currentJob.state}\` +
                  (currentJob.exitCode === null || currentJob.exitCode === undefined
                    ? ""
                    : \` | exit \${currentJob.exitCode}\`) +
                  (currentJob.servicePort ? \` | dev server :\${currentJob.servicePort}\` : "") +
                  \` | created \${new Date(currentJob.createdAt).toLocaleString()}\`;
                jobLogNode.textContent = payload.text || "No output yet.";
                stopButton.disabled = !currentJob.running;
                openDevServerButton.disabled = !currentJob.devServerUrl;
              } catch (error) {
                setError(error.message);
              }
            }

            async function createJob() {
              const command = jobCommandInput.value.trim();
              if (!command) {
                setError("Enter a command to run in the background.");
                return;
              }

              const rawServicePort = jobPortInput.value.trim();
              const servicePort = rawServicePort ? Number.parseInt(rawServicePort, 10) : null;
              if (
                rawServicePort &&
                (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535)
              ) {
                setError("Enter a valid dev server port between 1 and 65535.");
                return;
              }

              runButton.disabled = true;
              setError("");
              setStatus("Starting background job...");
              try {
                const payload = await requestJson("/api/projects/background-jobs", {
                  method: "POST",
                  body: JSON.stringify({
                    path: state.projectPath,
                    name: jobNameInput.value.trim() || undefined,
                    command,
                    servicePort: servicePort || undefined
                  })
                });
                jobCommandInput.value = "";
                state.selectedJobId = payload.job?.jobId || "";
                setStatus("Background job started.");
                await loadJobs({ preserveSelection: false });
                await loadLogs();
              } catch (error) {
                setError(error.message);
              } finally {
                runButton.disabled = false;
                window.setTimeout(() => setStatus(""), 2400);
              }
            }

            async function stopJob() {
              const job = selectedJob();
              if (!job || !job.running) {
                return;
              }

              stopButton.disabled = true;
              setError("");
              setStatus("Stopping background job...");
              try {
                await requestJson(
                  \`/api/projects/background-jobs/\${encodeURIComponent(job.jobId)}/stop\`,
                  {
                    method: "POST",
                    body: "{}"
                  }
                );
                await loadJobs();
                await loadLogs();
                setStatus("Background job stopped.");
              } catch (error) {
                setError(error.message);
              } finally {
                window.setTimeout(() => setStatus(""), 2400);
              }
            }

            runButton.addEventListener("click", () => {
              void createJob();
            });
            refreshButton.addEventListener("click", () => {
              setError("");
              void loadJobs().then(loadLogs);
            });
            stopButton.addEventListener("click", () => {
              void stopJob();
            });
            openDevServerButton.addEventListener("click", () => {
              const job = selectedJob();
              if (!job || !job.devServerUrl) {
                return;
              }

              window.open(job.devServerUrl, "_blank", "noopener");
            });

            renderPresets();
            void loadJobs({ preserveSelection: false }).then(loadLogs);
            window.setInterval(() => {
              void loadJobs().then(loadLogs);
            }, 3000);
          </script>
        </body>
      </html>
    `;
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "reaper.backgroundJobsView",
      new BackgroundJobsViewProvider()
    )
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
