import { createResource, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { api, authFetch, downloadUrl } from "../api.js";
import {
  cancelResumableUpload,
  formatBytes,
  formatDuration,
  formatRate,
  getResumableUpload,
  listPendingUploads,
  uploadFileResumably,
  uploadPercent,
  uploadResumeKey
} from "../upload-client.js";

const LARGE_EDIT_WARN_BYTES = 8 * 1024 * 1024;
let nextWorkspaceId = 0;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function errorMessage(error, fallback) {
  return error?.message || fallback;
}
function mergeDirectoryEntries(current, incoming) {
  const byPath = new Map([...(current || []), ...(incoming || [])].map((entry) => [entry.path, entry]));
  return [...byPath.values()].sort((a, b) =>
    a.type !== b.type
      ? (a.type === "directory" ? -1 : 1)
      : a.name.localeCompare(b.name)
  );
}

// Lazy, streaming file browser built for massive repositories. The tree loads
// one directory level at a time (never a recursive walk), uploads and downloads
// stream raw bytes, and the editor opens text files on demand.
export function ProjectFiles(props) {
  const workspaceId = "file-workspace-" + ++nextWorkspaceId;
  const openingFiles = new Map();
  let nextTabId = 0;
  let workspaceElement;
  let uploadInput;
  let reloadButton;
  let fullscreenTrigger;
  let outsideState = [];
  let keyHandler;
  let focusHandler;
  let toastTimer;
  let uploadPumpActive = false;
  let uploadSequence = 0;
  let activeUploadController = null;
  let activeUploadLocalId = null;
  let resumeTargetLocalId = null;

  const resourceBase = () => "/api/projects/" + encodeURIComponent(props.name);

  async function listDir(rel, cursor = null) {
    const query = new URLSearchParams();
    if (rel) query.set("path", rel);
    if (cursor) query.set("cursor", cursor);
    const q = query.size ? "?" + query.toString() : "";
    const response = await api(resourceBase() + "/files" + q);
    return { entries: response.entries || [], nextCursor: response.nextCursor || null };
  }

  const [root, { refetch: refetchRoot, mutate: mutateRoot }] = createResource(resourceBase, () => listDir(""));
  const [activePath, setActivePath] = createSignal(null);
  const [tabs, setTabs] = createSignal([]);
  const [toast, setToast] = createSignal(null);
  const [expanded, setExpanded] = createSignal(false);
  const [uploadItems, setUploadItems] = createSignal([]);

  const activeTab = () => tabs().find((tab) => tab.path === activePath());
  const tabId = (tab) => `${workspaceId}-tab-${tab.id}`;
  const panelId = (tab) => `${workspaceId}-panel-${tab.id}`;

  function flash(msg, kind) {
    clearTimeout(toastTimer);
    setToast({ msg, kind });
    toastTimer = setTimeout(() => setToast(null), 3000);
  }
  async function loadMoreRoot() {
    const current = root();
    if (!current?.nextCursor) return;
    try {
      const page = await listDir("", current.nextCursor);
      mutateRoot({
        entries: mergeDirectoryEntries(current.entries, page.entries),
        nextCursor: page.nextCursor
      });
    } catch (error) {
      flash(errorMessage(error, "Unable to load more files"), "err");
    }
  }

  function langFor(path) {
    const ext = path.split(".").pop().toLowerCase();
    return {
      js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
      py: "python", json: "json", md: "markdown", html: "html", css: "css",
      sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml", toml: "ini",
      rs: "rust", go: "go", c: "c", h: "c", cpp: "cpp", java: "java"
    }[ext] || "plaintext";
  }

  function createEditorTab(path, content) {
    const [draft, setDraft] = createSignal(content);
    const [saved, setSaved] = createSignal(content);
    return {
      id: ++nextTabId,
      path,
      lang: langFor(path),
      content: draft,
      setContent: setDraft,
      saved,
      setSaved,
      dirty: () => draft() !== saved()
    };
  }

  async function downloadFile(path, binaryOnly = false) {
    const requestPath = resourceBase() + "/download?path=" + encodeURIComponent(path);
    try {
      const preflight = await authFetch(requestPath, { method: "HEAD" });
      if (!preflight.ok) {
        throw new Error("Download unavailable (" + preflight.status + ")");
      }

      // HEAD surfaces authorization and missing-file errors. The subsequent GET
      // remains a native browser download, so the file is never buffered in JS.
      const anchor = document.createElement("a");
      anchor.href = downloadUrl(requestPath);
      anchor.download = path.split("/").pop();
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      flash(
        binaryOnly
          ? "Binary file; downloading " + path.split("/").pop() + " instead"
          : "Downloading " + path.split("/").pop(),
        "ok"
      );
      return true;
    } catch (error) {
      flash(errorMessage(error, "Download failed"), "err");
      return false;
    }
  }

  async function openFile(path, size) {
    const existing = tabs().find((tab) => tab.path === path);
    if (existing) {
      setActivePath(path);
      return;
    }

    let request = openingFiles.get(path);
    if (!request) {
      if (size != null && size > LARGE_EDIT_WARN_BYTES) {
        const megabytes = (size / 1024 / 1024).toFixed(1);
        if (!confirm(`${path} is ${megabytes} MB. Open it in the editor anyway?`)) return;
      }

      request = (async () => {
        try {
          const response = await api(resourceBase() + "/file?path=" + encodeURIComponent(path));
          if (response?.binary) {
            await downloadFile(path, true);
            return null;
          }
          if (typeof response?.content !== "string") {
            throw new Error("The file response did not contain editable text");
          }

          const alreadyOpen = tabs().find((tab) => tab.path === path);
          if (alreadyOpen) return alreadyOpen;
          const opened = createEditorTab(path, response.content);
          setTabs((current) => current.some((tab) => tab.path === path) ? current : [...current, opened]);
          return tabs().find((tab) => tab.path === path) || opened;
        } catch (error) {
          if (error?.status === 415) {
            await downloadFile(path, true);
          } else if (error?.status === 413) {
            await downloadFile(path);
          } else {
            flash(errorMessage(error, "Unable to open " + path), "err");
          }
          return null;
        }
      })();
      openingFiles.set(path, request);
      request.then(
        () => { if (openingFiles.get(path) === request) openingFiles.delete(path); },
        () => { if (openingFiles.get(path) === request) openingFiles.delete(path); }
      );
    }

    const opened = await request;
    if (opened && tabs().includes(opened)) setActivePath(opened.path);
  }

  async function save() {
    const tab = activeTab();
    if (!tab) return;
    const submittedContent = tab.content();
    try {
      await api(resourceBase() + "/file", {
        method: "PUT",
        body: JSON.stringify({ path: tab.path, content: submittedContent })
      });
      if (tabs().includes(tab)) {
        tab.setSaved(submittedContent);
        flash(
          tab.dirty()
            ? "Saved " + tab.path.split("/").pop() + "; newer changes remain unsaved"
            : "Saved " + tab.path.split("/").pop(),
          "ok"
        );
      }
    } catch (error) {
      flash(errorMessage(error, "Save failed"), "err");
    }
  }

  function focusTab(tab) {
    if (!tab) return;
    queueMicrotask(() => workspaceElement?.querySelector("#" + tabId(tab))?.focus());
  }

  function closeTab(path, restoreTabFocus = false) {
    const current = tabs();
    const index = current.findIndex((tab) => tab.path === path);
    if (index < 0) return;
    const tab = current[index];
    if (tab.dirty() && !confirm("Discard unsaved changes to " + path + "?")) return;

    const next = current.filter((item) => item !== tab);
    const nextActive = next[Math.min(index, next.length - 1)] || null;
    setTabs(next);
    if (activePath() === path) setActivePath(nextActive?.path || null);
    if (restoreTabFocus) {
      if (nextActive) focusTab(nextActive);
      else queueMicrotask(() => reloadButton?.focus());
    }
  }

  function onTabKeyDown(event, id) {
    const current = tabs();
    const index = current.findIndex((tab) => tab.id === id);
    if (index < 0) return;

    let next;
    if (event.key === "ArrowRight") next = current[(index + 1) % current.length];
    else if (event.key === "ArrowLeft") next = current[(index - 1 + current.length) % current.length];
    else if (event.key === "Home") next = current[0];
    else if (event.key === "End") next = current[current.length - 1];
    else if (event.key === "Delete") {
      event.preventDefault();
      closeTab(current[index].path, true);
      return;
    } else {
      return;
    }

    event.preventDefault();
    setActivePath(next.path);
    focusTab(next);
  }

  function visibleFilePaths() {
    return Array.from(workspaceElement?.querySelectorAll("[data-file-path]") || [])
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.dataset.filePath);
  }

  function deleteFocusCandidates(path) {
    const visible = visibleFilePaths();
    const index = visible.indexOf(path);
    const candidates = [];
    if (index >= 0) {
      if (visible[index + 1]) candidates.push(visible[index + 1]);
      if (visible[index - 1]) candidates.push(visible[index - 1]);
    }
    let parent = path.split("/").slice(0, -1).join("/");
    while (parent) {
      candidates.push(parent);
      parent = parent.split("/").slice(0, -1).join("/");
    }
    return [...new Set(candidates)];
  }

  function restoreDeleteFocus(candidates) {
    queueMicrotask(() => {
      const buttons = Array.from(workspaceElement?.querySelectorAll("[data-file-path]") || []);
      for (const path of candidates) {
        const match = buttons.find((button) => button.dataset.filePath === path);
        if (match) {
          match.focus();
          return;
        }
      }
      reloadButton?.focus();
    });
  }

  async function del(path) {
    if (!confirm("Delete " + path + "?")) return;
    const focusCandidates = deleteFocusCandidates(path);
    try {
      await api(resourceBase() + "/file", {
        method: "DELETE",
        body: JSON.stringify({ path })
      });
      setTabs((current) => {
        const next = current.filter((tab) => tab.path !== path);
        if (activePath() === path) setActivePath(next[0]?.path || null);
        return next;
      });
      flash("Deleted " + path, "ok");
      try {
        await refetchRoot();
      } catch {
        // The resource retains the reload error and renders its retry action.
      }
      restoreDeleteFocus(focusCandidates);
    } catch (error) {
      flash(errorMessage(error, "Delete failed"), "err");
    }
  }

  function updateUploadItem(localId, patch) {
    setUploadItems((items) => items.map((item) => {
      if (item.localId !== localId) return item;
      const changes = typeof patch === "function" ? patch(item) : patch;
      return { ...item, ...changes };
    }));
  }

  function uploadItemFor(localId) {
    return uploadItems().find((item) => item.localId === localId);
  }

  function statusForUpload(item) {
    if (item.status === "needs-file") return "Select the same file to resume";
    if (item.status === "preparing") return "Preparing upload…";
    if (item.status === "queued") return "Queued";
    if (item.status === "uploading") return item.resumed ? "Uploading from saved progress" : "Uploading";
    if (item.status === "pausing") return "Pausing and saving progress…";
    if (item.status === "retrying") {
      const seconds = Math.max(1, Math.ceil(Number(item.retryIn || 0) / 1000));
      return `Connection interrupted — retrying${item.retryIn ? ` in ${seconds}s` : ""}`;
    }
    if (item.status === "finalizing") return "Saving file…";
    if (item.status === "paused") return "Paused — progress is saved";
    if (item.status === "cancelling") return "Cancelling…";
    if (item.status === "error") return item.error || "Upload failed";
    if (item.status === "complete") return "Upload complete";
    return "Waiting";
  }

  function uploadSummary() {
    const items = uploadItems();
    const total = items.reduce((sum, item) => sum + Number(item.size || 0), 0);
    const uploaded = items.reduce((sum, item) => sum + Math.min(Number(item.uploaded || 0), Number(item.size || 0)), 0);
    return { total, uploaded, percent: uploadPercent(uploaded, total) };
  }

  async function restorePendingUploads() {
    try {
      const pending = await listPendingUploads(props.name);
      setUploadItems((items) => {
        const known = new Set(items.map((item) => item.uploadId).filter(Boolean));
        return [
          ...items,
          ...pending
            .filter((upload) => !known.has(upload.id))
            .map((upload) => ({
              localId: `server-${upload.id}`,
              uploadId: upload.id,
              file: null,
              path: upload.path,
              name: upload.path.split("/").pop(),
              size: upload.size,
              lastModified: upload.lastModified,
              resumeKey: upload.resumeKey,
              uploaded: upload.offset,
              confirmed: upload.offset,
              speed: 0,
              eta: null,
              status: "needs-file"
            }))
        ];
      });
    } catch {
      // File browsing still works when the resumable-upload status check fails.
    }
  }

  function enqueueFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const target = resumeTargetLocalId ? uploadItemFor(resumeTargetLocalId) : null;
    resumeTargetLocalId = null;

    if (target) {
      const file = files[0];
      const key = uploadResumeKey(file, target.path);
      if (key !== target.resumeKey) {
        flash(`Select the original ${target.name} file to resume this upload`, "err");
        return;
      }
      updateUploadItem(target.localId, { file, status: "queued", error: null });
      void pumpUploadQueue();
      return;
    }

    setUploadItems((items) => {
      const next = [...items];
      for (const file of files) {
        const relativePath = file.name;
        const resumeKey = uploadResumeKey(file, relativePath);
        const pending = next.find((item) =>
          item.status === "needs-file" &&
          item.resumeKey === resumeKey &&
          item.path === relativePath
        );
        if (pending) {
          Object.assign(pending, { file, status: "queued", error: null });
          continue;
        }
        next.push({
          localId: `local-${++uploadSequence}`,
          uploadId: null,
          file,
          path: relativePath,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified || 0,
          resumeKey,
          uploaded: 0,
          confirmed: 0,
          speed: 0,
          eta: null,
          status: "queued"
        });
      }
      return next;
    });
    void pumpUploadQueue();
  }

  async function pumpUploadQueue() {
    if (uploadPumpActive) return;
    uploadPumpActive = true;
    try {
      while (true) {
        const item = uploadItems().find((candidate) => candidate.status === "queued" && candidate.file);
        if (!item) break;
        const controller = new AbortController();
        activeUploadController = controller;
        activeUploadLocalId = item.localId;
        updateUploadItem(item.localId, { status: "preparing", error: null });
        try {
          const upload = await uploadFileResumably({
            project: props.name,
            file: item.file,
            relativePath: item.path,
            signal: controller.signal,
            onProgress: (progress) => {
              updateUploadItem(item.localId, {
                uploadId: progress.uploadId || uploadItemFor(item.localId)?.uploadId,
                status: progress.phase,
                uploaded: progress.uploaded,
                confirmed: progress.confirmed,
                speed: progress.speed,
                eta: progress.eta,
                retryIn: progress.retryIn,
                resumed: progress.resumed
              });
            }
          });
          updateUploadItem(item.localId, {
            uploadId: upload.id,
            status: "complete",
            uploaded: upload.size,
            confirmed: upload.size,
            speed: 0,
            eta: 0
          });
          try { await refetchRoot(); } catch {}
        } catch (error) {
          const current = uploadItemFor(item.localId);
          if (error?.name === "AbortError") {
            if (current && !["paused", "pausing", "cancelling"].includes(current.status)) {
              updateUploadItem(item.localId, { status: "paused" });
            }
          } else {
            updateUploadItem(item.localId, {
              status: "error",
              error: errorMessage(error, "Upload failed")
            });
          }
        } finally {
          if (activeUploadLocalId === item.localId) {
            activeUploadController = null;
            activeUploadLocalId = null;
          }
        }
      }
    } finally {
      uploadPumpActive = false;
    }
  }

  async function pauseUpload(item) {
    updateUploadItem(item.localId, { status: "pausing" });
    if (item.localId === activeUploadLocalId) activeUploadController?.abort();
    const uploadId = uploadItemFor(item.localId)?.uploadId;
    if (uploadId) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const upload = await getResumableUpload(props.name, uploadId);
        updateUploadItem(item.localId, {
          status: "paused",
          uploaded: upload.offset,
          confirmed: upload.offset,
          resumed: upload.offset > 0
        });
        return;
      } catch {}
    }
    updateUploadItem(item.localId, { status: "paused" });
  }

  function resumeUpload(item) {
    if (!item.file) {
      resumeTargetLocalId = item.localId;
      uploadInput?.click();
      return;
    }
    updateUploadItem(item.localId, { status: "queued", error: null });
    void pumpUploadQueue();
  }

  async function cancelUpload(item) {
    updateUploadItem(item.localId, { status: "cancelling", error: null });
    if (item.localId === activeUploadLocalId) activeUploadController?.abort();
    try {
      let uploadId = item.uploadId;
      if (!uploadId) {
        const pending = await listPendingUploads(props.name);
        uploadId = pending.find((upload) =>
          upload.resumeKey === item.resumeKey && upload.path === item.path
        )?.id;
      }
      if (uploadId) await cancelResumableUpload(props.name, uploadId);
      setUploadItems((items) => items.filter((candidate) => candidate.localId !== item.localId));
    } catch (error) {
      updateUploadItem(item.localId, {
        status: "error",
        error: errorMessage(error, "Could not cancel upload")
      });
    }
  }

  function dismissUpload(item) {
    setUploadItems((items) => items.filter((candidate) => candidate.localId !== item.localId));
  }

  function hideOutsideWorkspace() {
    outsideState = [];
    let branch = workspaceElement;
    while (branch && branch !== document.body) {
      const parent = branch.parentElement;
      if (!parent) break;
      for (const sibling of parent.children) {
        if (sibling === branch) continue;
        outsideState.push({
          element: sibling,
          inert: sibling.hasAttribute("inert"),
          ariaHidden: sibling.getAttribute("aria-hidden")
        });
        sibling.setAttribute("inert", "");
        sibling.setAttribute("aria-hidden", "true");
      }
      branch = parent;
    }
  }

  function restoreOutsideWorkspace() {
    for (const state of outsideState.reverse()) {
      if (!state.inert) state.element.removeAttribute("inert");
      if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
      else state.element.setAttribute("aria-hidden", state.ariaHidden);
    }
    outsideState = [];
  }

  function focusableWorkspaceElements() {
    return Array.from(workspaceElement?.querySelectorAll(FOCUSABLE_SELECTOR) || [])
      .filter((element) =>
        element.tabIndex >= 0 &&
        element.getClientRects().length > 0 &&
        !element.closest("[hidden], [inert], [aria-hidden='true']")
      );
  }

  function focusInsideWorkspace(preferLast = false) {
    const focusable = focusableWorkspaceElements();
    const target = preferLast ? focusable[focusable.length - 1] : focusable[0];
    (target || workspaceElement)?.focus();
  }

  function trapFullscreenTab(event) {
    const focusable = focusableWorkspaceElements();
    if (!focusable.length) {
      event.preventDefault();
      workspaceElement?.focus();
      return;
    }

    const active = document.activeElement;
    if (!workspaceElement?.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
    } else if (event.shiftKey && active === focusable[0]) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    } else if (!event.shiftKey && active === focusable[focusable.length - 1]) {
      event.preventDefault();
      focusable[0].focus();
    }
  }

  function enterFullscreen(trigger) {
    if (expanded()) return;
    fullscreenTrigger = trigger;
    hideOutsideWorkspace();
    setExpanded(true);
    queueMicrotask(() => fullscreenTrigger?.focus());
  }

  function exitFullscreen() {
    if (!expanded()) return;
    setExpanded(false);
    restoreOutsideWorkspace();
    const trigger = fullscreenTrigger;
    fullscreenTrigger = null;
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }

  onMount(() => {
    void restorePendingUploads();
    keyHandler = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
        return;
      }
      if (event.key === "Escape" && expanded()) {
        event.preventDefault();
        exitFullscreen();
        return;
      }
      if (event.key === "Tab" && expanded()) trapFullscreenTab(event);
    };
    focusHandler = (event) => {
      if (expanded() && workspaceElement && !workspaceElement.contains(event.target)) {
        focusInsideWorkspace();
      }
    };
    document.addEventListener("keydown", keyHandler);
    document.addEventListener("focusin", focusHandler);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", keyHandler);
    document.removeEventListener("focusin", focusHandler);
    clearTimeout(toastTimer);
    activeUploadController?.abort();
    restoreOutsideWorkspace();
  });

  return (
    <div
      ref={workspaceElement}
      class="file-workspace"
      classList={{ "file-workspace--fullscreen": expanded() }}
      tabindex="-1"
    >
      <aside
        class="file-workspace__tree"
        aria-label="Project files"
      >
        <div class="row file-workspace__tree-head">
          <div class="muted file-workspace__label">Files</div>
          <div class="spacer" />
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            aria-label={"Upload files to " + props.name}
            onClick={() => uploadInput?.click()}
          >
            Upload
          </button>
          <input
            ref={uploadInput}
            type="file"
            multiple
            class="sr-only"
            tabindex="-1"
            aria-label={"Choose files to upload to " + props.name}
            onChange={(event) => {
              enqueueFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <button
            ref={reloadButton}
            type="button"
            class="btn btn--ghost btn--sm"
            aria-label={"Reload files for " + props.name}
            onClick={() => refetchRoot()}
          >
            Reload
          </button>
        </div>
        <Show when={uploadItems().length}>
          <section class="upload-queue" aria-label="File uploads">
            <div class="upload-queue__summary">
              <div class="row">
                <strong>Uploads</strong>
                <span class="spacer" />
                <span class="muted">{uploadSummary().percent.toFixed(uploadSummary().percent < 1 ? 2 : 0)}%</span>
              </div>
              <progress
                class="upload-progress upload-progress--overall"
                max={uploadSummary().total || 1}
                value={uploadSummary().total ? uploadSummary().uploaded : 1}
                aria-label="Overall upload progress"
              />
            </div>
            <ul class="upload-queue__list">
              <For each={uploadItems()}>
                {(item) => (
                  <li class="upload-item">
                    <div class="upload-item__title-row">
                      <span class="upload-item__name" title={item.path}>{item.name}</span>
                      <span class="upload-item__percent">
                        {uploadPercent(item.uploaded, item.size).toFixed(uploadPercent(item.uploaded, item.size) < 1 ? 2 : 0)}%
                      </span>
                    </div>
                    <progress
                      class="upload-progress"
                      max={item.size || 1}
                      value={item.size ? Math.min(item.uploaded || 0, item.size) : 1}
                      aria-label={`Upload progress for ${item.name}`}
                      aria-valuetext={`${formatBytes(item.uploaded)} sent, ${formatBytes(item.confirmed)} saved, of ${formatBytes(item.size)}`}
                    />
                    <div class="upload-item__status">{statusForUpload(item)}</div>
                    <Show when={["uploading", "retrying", "finalizing", "paused"].includes(item.status)}>
                      <div class="upload-item__metrics">
                        <span>{formatBytes(item.uploaded)} of {formatBytes(item.size)}</span>
                        <Show when={item.status === "uploading" && item.speed > 0}>
                          <span>{formatRate(item.speed)}</span>
                          <span>{formatDuration(item.eta)}</span>
                        </Show>
                        <Show when={item.confirmed < item.uploaded}>
                          <span>{formatBytes(item.confirmed)} saved</span>
                        </Show>
                      </div>
                    </Show>
                    <div class="upload-item__actions">
                      <Show when={["uploading", "retrying", "preparing", "queued"].includes(item.status)}>
                        <button type="button" class="btn btn--ghost btn--sm" onClick={() => pauseUpload(item)}>
                          Pause
                        </button>
                      </Show>
                      <Show when={["paused", "needs-file", "error"].includes(item.status)}>
                        <button type="button" class="btn btn--ghost btn--sm" onClick={() => resumeUpload(item)}>
                          {item.file ? "Resume" : "Select file"}
                        </button>
                      </Show>
                      <Show when={item.status === "complete"}>
                        <button type="button" class="btn btn--ghost btn--sm" onClick={() => dismissUpload(item)}>
                          Dismiss
                        </button>
                      </Show>
                      <Show when={item.status !== "complete"}>
                        <button
                          type="button"
                          class="btn btn--ghost btn--sm upload-item__cancel"
                          disabled={item.status === "cancelling"}
                          onClick={() => cancelUpload(item)}
                        >
                          Cancel
                        </button>
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <div class="file-workspace__tree-body">
          <Show
            when={!root.loading}
            fallback={
              <div class="muted file-workspace__hint" role="status">
                Loading files for {props.name}…
              </div>
            }
          >
            <Show
              when={!root.error}
              fallback={
                <div class="file-workspace__hint" role="alert">
                  <div>Could not load files: {errorMessage(root.error, "Unknown error")}</div>
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    aria-label={"Retry loading files for " + props.name}
                    onClick={() => refetchRoot()}
                  >
                    Retry
                  </button>
                </div>
              }
            >
              <Show
                when={root()?.entries?.length}
                fallback={<div class="muted file-workspace__hint">No files</div>}
              >
                <ul class="tree" aria-label={"Files in " + props.name}>
                  <For each={root().entries}>
                    {(entry) => (
                      <TreeNode
                        entry={entry}
                        depth={0}
                        load={listDir}
                        active={activePath()}
                        onOpen={openFile}
                        onDelete={del}
                        onDownload={downloadFile}
                      />
                    )}
                  </For>
                  <Show when={root()?.nextCursor}>
                    <li class="tree__item file-workspace__hint">
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        onClick={loadMoreRoot}
                      >
                        Load more files
                      </button>
                    </li>
                  </Show>
                </ul>
              </Show>
            </Show>
          </Show>
        </div>
      </aside>

      <section class="file-workspace__editor" aria-label="File editor">
        <div class="edtabs">
          <div
            role="tablist"
            aria-label="Open files"
            aria-orientation="horizontal"
            style={{ display: "flex", "flex-shrink": 0 }}
          >
            <For each={tabs()}>
              {(tab) => (
                <button
                  type="button"
                  id={tabId(tab)}
                  class="edtab"
                  classList={{ "edtab--active": activePath() === tab.path }}
                  role="tab"
                  aria-label={tab.path + (tab.dirty() ? ", unsaved changes" : "")}
                  aria-selected={activePath() === tab.path}
                  aria-controls={panelId(tab)}
                  tabindex={activePath() === tab.path ? 0 : -1}
                  onClick={() => setActivePath(tab.path)}
                  onKeyDown={(event) => onTabKeyDown(event, tab.id)}
                >
                  <span class="edtab__name">{tab.path.split("/").pop()}</span>
                  <Show when={tab.dirty()}>
                    <span class="edtab__dirty" aria-hidden="true" title="Unsaved changes">●</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <div class="spacer" />
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            disabled={!activeTab()}
            aria-label={activeTab() ? "Close " + activeTab().path : "Close file"}
            onClick={() => activePath() && closeTab(activePath(), true)}
          >
            Close
          </button>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            aria-pressed={expanded()}
            aria-label={
              (expanded() ? "Exit full screen file workspace for " : "Open full screen file workspace for ") +
              props.name
            }
            title="Toggle full screen (Esc to exit)"
            onClick={(event) =>
              expanded() ? exitFullscreen() : enterFullscreen(event.currentTarget)
            }
          >
            {expanded() ? "Exit full screen" : "Full screen"}
          </button>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            onClick={save}
            disabled={!activeTab()?.dirty()}
            aria-label={activeTab() ? "Save " + activeTab().path : "Save file"}
          >
            Save
          </button>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            onClick={() => activePath() && downloadFile(activePath())}
            disabled={!activePath()}
            aria-label={activePath() ? "Download " + activePath() : "Download file"}
          >
            Download
          </button>
        </div>

        <Show
          when={tabs().length}
          fallback={
            <div class="empty">
              <div class="empty__title">No file open</div>
              <p>
                Select a file from the list. Directories load on demand, so even huge
                repositories open instantly.
              </p>
            </div>
          }
        >
          <For each={tabs()}>
            {(tab) => (
              <Editor
                tab={tab}
                active={activePath() === tab.path}
                tabId={tabId(tab)}
                panelId={panelId(tab)}
              />
            )}
          </For>
        </Show>
      </section>

      <Show when={toast()}>
        {(notice) => (
          <div
            class={"toast" + (notice().kind === "err" ? " toast--err" : "")}
            role={notice().kind === "err" ? "alert" : "status"}
          >
            {notice().msg}
          </div>
        )}
      </Show>
    </div>
  );
}

function TreeNode(props) {
  const [open, setOpen] = createSignal(false);
  const [children, setChildren] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [nextCursor, setNextCursor] = createSignal(null);
  const [loadError, setLoadError] = createSignal(null);
  const isDir = () => props.entry.type === "directory";

  async function loadChildren() {
    if (!isDir() || loading()) return;
    setLoading(true);
    setLoadError(null);
    try {
      const cursor = children() === null ? null : nextCursor();
      const page = await props.load(props.entry.path, cursor);
      setChildren(mergeDirectoryEntries(children(), page.entries));
      setNextCursor(page.nextCursor);
    } catch (error) {
      setLoadError(errorMessage(error, "Unknown error"));
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    if (!isDir()) {
      props.onOpen(props.entry.path, props.entry.size);
      return;
    }
    const next = !open();
    setOpen(next);
    if (next && children() === null) await loadChildren();
  }

  return (
    <li class="tree__item">
      <div
        class="tree__node"
        classList={{
          "tree__node--active": !isDir() && props.active === props.entry.path,
          "tree__node--dir": isDir()
        }}
        style={{ "padding-left": (props.depth * 12 + 6) + "px" }}
      >
        <button
          type="button"
          data-file-path={props.entry.path}
          aria-label={
            isDir()
              ? (open() ? "Collapse folder " : "Expand folder ") + props.entry.path
              : "Open file " + props.entry.path
          }
          aria-expanded={isDir() ? open() : undefined}
          aria-current={!isDir() && props.active === props.entry.path ? "true" : undefined}
          onClick={toggle}
          style={{
            display: "flex",
            "align-items": "center",
            gap: "6px",
            flex: 1,
            "min-width": 0,
            "text-align": "left"
          }}
        >
          <span class="tree__disclosure" aria-hidden="true">
            {isDir() ? (open() ? "▾" : "▸") : ""}
          </span>
          <span class="tree__name">{props.entry.name}</span>
        </button>
        <Show when={!isDir()}>
          <button
            type="button"
            class="tree__action"
            style={{ opacity: 1 }}
            aria-label={"Download " + props.entry.path}
            title={"Download " + props.entry.path}
            onClick={() => props.onDownload(props.entry.path)}
          >
            ↓
          </button>
          <button
            type="button"
            class="tree__action"
            style={{ opacity: 1 }}
            aria-label={"Delete " + props.entry.path}
            title={"Delete " + props.entry.path}
            onClick={() => props.onDelete(props.entry.path)}
          >
            ×
          </button>
        </Show>
      </div>
      <Show when={isDir() && open()}>
        <Show
          when={!loading()}
          fallback={
            <div
              class="muted tree__loading"
              role="status"
              style={{ "padding-left": ((props.depth + 1) * 12 + 6) + "px" }}
            >
              Loading {props.entry.name}…
            </div>
          }
        >
          <Show
            when={!loadError()}
            fallback={
              <div
                class="tree__loading"
                role="alert"
                style={{ "padding-left": ((props.depth + 1) * 12 + 6) + "px" }}
              >
                Could not load {props.entry.name}: {loadError()}{" "}
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  aria-label={"Retry loading folder " + props.entry.path}
                  onClick={loadChildren}
                >
                  Retry
                </button>
              </div>
            }
          >
            <Show
              when={children()?.length}
              fallback={
                <div
                  class="muted tree__loading"
                  style={{ "padding-left": ((props.depth + 1) * 12 + 6) + "px" }}
                >
                  Empty
                </div>
              }
            >
              <ul class="tree" aria-label={"Contents of " + props.entry.path}>
                <For each={children()}>
                  {(child) => (
                    <TreeNode
                      entry={child}
                      depth={props.depth + 1}
                      load={props.load}
                      active={props.active}
                      onOpen={props.onOpen}
                      onDelete={props.onDelete}
                      onDownload={props.onDownload}
                    />
                  )}
                </For>
                <Show when={nextCursor()}>
                  <li
                    class="tree__item"
                    style={{ "padding-left": ((props.depth + 1) * 12 + 6) + "px" }}
                  >
                    <button
                      type="button"
                      class="btn btn--ghost btn--sm"
                      onClick={loadChildren}
                    >
                      Load more
                    </button>
                  </li>
                </Show>
              </ul>
            </Show>
          </Show>
        </Show>
      </Show>
    </li>
  );
}

function Editor(props) {
  return (
    <div
      id={props.panelId}
      class="editor-pane"
      role="tabpanel"
      aria-labelledby={props.tabId}
      hidden={!props.active}
      tabindex="0"
    >
      <div class="row editor-pane__meta">
        <span class="muted mono">{props.tab.path}</span>
        <div class="spacer" />
        <span class="muted">
          {props.tab.dirty() ? "Unsaved" : "Saved"} ·{" "}
          {props.tab.content().length.toLocaleString()} chars · {props.tab.lang}
        </span>
      </div>
      <textarea
        class="editor-pane__input mono"
        spellcheck={false}
        wrap="off"
        value={props.tab.content()}
        aria-label={"Editing " + props.tab.path}
        onInput={(event) => props.tab.setContent(event.currentTarget.value)}
      />
    </div>
  );
}
