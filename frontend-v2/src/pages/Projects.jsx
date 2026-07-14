import { createResource, createSignal, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import { api } from "../api.js";

export default function Projects() {
  const [list, { refetch }] = createResource(async () => {
    const response = await api("/api/projects");
    if (!Array.isArray(response.projects)) throw new Error("The project list response was invalid.");
    return response.projects;
  });
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [formError, setFormError] = createSignal(null);
  const [actionError, setActionError] = createSignal(null);
  const [notice, setNotice] = createSignal(null);
  const [deleting, setDeleting] = createSignal(null);
  let newProjectButton;
  let nameInput;

  function openCreate() {
    setCreating(true);
    setFormError(null);
    queueMicrotask(() => nameInput?.focus());
  }

  function closeCreate({ restoreFocus = true } = {}) {
    setCreating(false);
    setFormError(null);
    if (restoreFocus) queueMicrotask(() => newProjectButton?.focus());
  }

  async function create(e) {
    e.preventDefault();
    setFormError(null);
    setActionError(null);
    setNotice(null);
    setBusy(true);
    const projectName = name();
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: projectName })
      });
      setName("");
      closeCreate();
      setNotice(`Project ${projectName} was created.`);
      refetch();
    } catch (error) {
      setFormError(error.message || "The project could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function del(projectName) {
    if (!confirm(`Delete project '${projectName}'? Its files and settings will be removed.`)) return;
    setActionError(null);
    setNotice(null);
    setDeleting(projectName);
    try {
      await api("/api/projects/" + encodeURIComponent(projectName), { method: "DELETE" });
      setNotice(`Project ${projectName} was deleted.`);
      refetch();
      queueMicrotask(() => newProjectButton?.focus());
    } catch (error) {
      setActionError(error.message || `Project ${projectName} could not be deleted.`);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div class="page" aria-busy={list.loading}>
      <div class="row" style="margin-bottom: 16px;">
        <div>
          <div class="page__eyebrow">Workspace</div>
          <h1 class="page__title">Projects</h1>
          <p class="page__lede">Each project is an isolated working directory with its own files, environment, and terminal sessions.</p>
        </div>
        <div class="spacer" />
        <button ref={newProjectButton} class="btn btn--primary" type="button" onClick={openCreate} aria-expanded={creating()}>
          New project
        </button>
      </div>

      <Show when={creating()}>
        <form class="card project-create" onSubmit={create} style="margin-bottom: 16px;" aria-describedby="project-name-hint">
          <div class="field">
            <label class="field__label" for="project-name">Project name</label>
            <input
              ref={nameInput}
              id="project-name"
              name="project-name"
              class="input mono"
              required
              pattern="[a-zA-Z0-9_.\-]+"
              maxlength="64"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              aria-describedby="project-name-hint"
              style="max-width: 360px;"
            />
            <span id="project-name-hint" class="muted" style="font-size: var(--t-xs);">
              Use up to 64 letters, digits, periods, underscores, or hyphens.
            </span>
          </div>
          <div class="row">
            <button class="btn btn--primary" type="submit" disabled={busy()}>
              {busy() ? "Creating…" : "Create project"}
            </button>
            <button class="btn btn--ghost" type="button" onClick={() => closeCreate()} disabled={busy()}>
              Cancel
            </button>
          </div>
          <Show when={formError()}>
            <p role="alert" style="color: var(--danger); font-size: var(--t-sm);">{formError()}</p>
          </Show>
        </form>
      </Show>

      <Show when={notice()}>
        <p class="muted" role="status" aria-live="polite" aria-atomic="true">{notice()}</p>
      </Show>
      <Show when={actionError()}>
        <div class="card" role="alert">
          <div class="empty__title">Project action failed</div>
          <p>{actionError()}</p>
        </div>
      </Show>

      <Show when={list.loading}>
        <div class="muted" role="status">Loading projects…</div>
      </Show>
      <Show when={list.error}>
        <div class="card empty" role="alert">
          <div class="empty__title">Projects could not be loaded</div>
          <p>{list.error?.message || "The project list request failed."}</p>
          <button class="btn btn--outline btn--sm" type="button" onClick={() => refetch()}>Retry</button>
        </div>
      </Show>
      <Show when={!list.loading && !list.error && list()}>
        <Show when={list().length > 0} fallback={
          <div class="card empty">
            <div class="empty__title">No projects yet</div>
            <p>Create a project to get a working directory, environment settings, files, and terminal access.</p>
          </div>
        }>
          <div class="grid grid--2">
            <For each={list()}>{(projectName) => (
              <article class="card">
                <div class="card__head">
                  <h2 style="margin: 0; font-size: inherit;">
                    <A
                      href={"/projects/" + encodeURIComponent(projectName)}
                      class="card__title"
                      style="text-transform: none; letter-spacing: 0; color: var(--text-1); font-size: var(--t-md);"
                    >
                      {projectName}
                    </A>
                  </h2>
                  <button
                    class="btn btn--ghost btn--sm"
                    type="button"
                    onClick={() => del(projectName)}
                    disabled={deleting() === projectName}
                    title={`Delete project ${projectName}`}
                    aria-label={`Delete project ${projectName}`}
                  >
                    {deleting() === projectName ? "Deleting…" : "Delete"}
                  </button>
                </div>
                <div class="card__body">
                  <div class="row" style="margin-top: 12px; flex-wrap: wrap;">
                    <A class="btn btn--outline btn--sm" href={"/projects/" + encodeURIComponent(projectName) + "/files"}>Files</A>
                    <A class="btn btn--outline btn--sm" href={"/projects/" + encodeURIComponent(projectName) + "/terminal"}>Terminal</A>
                    <A class="btn btn--outline btn--sm" href={"/projects/" + encodeURIComponent(projectName) + "/settings"}>Settings</A>
                  </div>
                </div>
              </article>
            )}</For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
