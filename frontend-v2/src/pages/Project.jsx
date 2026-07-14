import { createEffect, createResource, createSignal, Show } from "solid-js";
import { useParams, useLocation, A } from "@solidjs/router";
import { api } from "../api.js";
import { ProjectFiles } from "../components/ProjectFiles.jsx";
import { ProjectTerminal } from "../components/ProjectTerminal.jsx";
import { ProjectSettings } from "../components/ProjectSettings.jsx";
import { ProjectSessions } from "../components/ProjectSessions.jsx";

export default function Project() {
  const params = useParams();
  const loc = useLocation();
  const name = () => { try { return decodeURIComponent(params.name); } catch { return params.name; } };
  const base = () => "/projects/" + encodeURIComponent(name());
  const [meta, { refetch: refetchMeta }] = createResource(name, async (projectName) => {
    const response = await api("/api/projects/" + encodeURIComponent(projectName));
    return response.project || null;
  });
  let sessionResourceGeneration = 0;
  let sessionResourceSnapshot = [];
  const [sessions, { refetch: refetchSessions, mutate: mutateSessions }] = createResource(name, async (projectName) => {
    const generation = ++sessionResourceGeneration;
    try {
      const response = await api("/api/projects/" + encodeURIComponent(projectName) + "/sessions");
      if (!Array.isArray(response.sessions)) throw new Error("The session status response was invalid.");
      if (generation !== sessionResourceGeneration) return sessionResourceSnapshot;
      sessionResourceSnapshot = response.sessions;
      return response.sessions;
    } catch (error) {
      if (generation !== sessionResourceGeneration) return sessionResourceSnapshot;
      throw error;
    }
  });

  function synchronizeSessions(next) {
    if (!Array.isArray(next)) {
      void refetchSessions();
      return;
    }
    sessionResourceGeneration += 1;
    sessionResourceSnapshot = next;
    mutateSessions(next);
    if (sessions.error) void refetchSessions();
  }

  const relativeSection = () => {
    const pathname = loc.pathname.replace(/\/+$/, "");
    const root = base().replace(/\/+$/, "");
    if (pathname === root || !pathname.startsWith(root + "/")) return "";
    return pathname.slice(root.length + 1).split("/")[0];
  };
  const tab = () => {
    const section = relativeSection();
    if (section === "terminal") return "terminal";
    if (section === "sessions") return "sessions";
    if (section === "settings") return "settings";
    return "files";
  };
  const sessionStatus = () => {
    if (sessions.loading) return "Terminal status: checking";
    if (sessions.error) return "Terminal status unavailable";
    const listed = sessions() || [];
    if (!listed.length) return "No terminals";
    const running = listed.filter((session) => session.state === "running").length;
    if (running > 0) return `${running} terminal${running === 1 ? "" : "s"} running`;
    return `${listed.length} terminal${listed.length === 1 ? "" : "s"} ready`;
  };
  const sessionAvailable = () =>
    !sessions.error && (sessions() || []).some((session) => session.state === "running");
  const [terminalMounted, setTerminalMounted] = createSignal(tab() === "terminal");

  createEffect(() => {
    if (tab() === "terminal") setTerminalMounted(true);
  });

  return (
    <div
      class="page page--wide project-page"
      classList={{ "project-page--terminal": tab() === "terminal" }}
      aria-busy={meta.loading || sessions.loading}
    >
      <div class="page__head-wrap">
        <div class="row project-header">
          <div>
            <div class="page__eyebrow">Project</div>
            <h1 class="page__title">{name()}</h1>
            <Show when={meta.loading}>
              <p class="page__lede" role="status">Loading project metadata…</p>
            </Show>
            <Show when={meta.error}>
              <div role="alert">
                <p class="page__lede">Project metadata could not be loaded: {meta.error?.message || "Request failed."}</p>
                <button class="btn btn--outline btn--sm" type="button" onClick={() => refetchMeta()}>Retry metadata</button>
              </div>
            </Show>
            <Show when={!meta.loading && !meta.error && !meta()}>
              <div role="alert">
                <p class="page__lede">No project metadata was returned.</p>
                <button class="btn btn--outline btn--sm" type="button" onClick={() => refetchMeta()}>Retry metadata</button>
              </div>
            </Show>
            <Show when={meta()}>
              <p class="page__lede">
                {meta().mode === "temporary" ? "Temporary" : "Persistent"} workspace
                <Show when={meta().owner}> · owner {meta().owner}</Show>
              </p>
            </Show>
          </div>
          <div class="spacer" />
          <div class="row project-header__status">
            <span role="status" aria-live="polite" class="row" style="gap: 6px;">
              <span
                class={"status-dot " + (sessionAvailable() ? "status-dot--ok" : "status-dot--err")}
                aria-hidden="true"
              ></span>
              <span class="muted" style="font-size: var(--t-sm);">{sessionStatus()}</span>
            </span>
            <Show when={sessions.error}>
              <button class="btn btn--ghost btn--sm" type="button" onClick={() => refetchSessions()}>Retry status</button>
            </Show>
          </div>
        </div>
        <nav class="tabs" aria-label="Project sections">
          <A
            href={base() + "/files"}
            class="tabs__item"
            classList={{ "tabs__item--active": tab() === "files" }}
            aria-current={tab() === "files" ? "page" : undefined}
          >Files</A>
          <A
            href={base() + "/terminal"}
            class="tabs__item"
            classList={{ "tabs__item--active": tab() === "terminal" }}
            aria-current={tab() === "terminal" ? "page" : undefined}
          >Terminal</A>
          <A
            href={base() + "/sessions"}
            class="tabs__item"
            classList={{ "tabs__item--active": tab() === "sessions" }}
            aria-current={tab() === "sessions" ? "page" : undefined}
          >Sessions</A>
          <A
            href={base() + "/settings"}
            class="tabs__item"
            classList={{ "tabs__item--active": tab() === "settings" }}
            aria-current={tab() === "settings" ? "page" : undefined}
          >Settings</A>
        </nav>
      </div>

      <Show when={tab() === "files"}><ProjectFiles name={name()} /></Show>
      <Show when={terminalMounted() ? name() : null} keyed>
        {(projectName) => (
          <div
            class="project-panel"
            classList={{ "project-panel--hidden": tab() !== "terminal" }}
            aria-hidden={tab() !== "terminal" ? "true" : undefined}
          >
            <ProjectTerminal
              name={projectName}
              active={tab() === "terminal"}
              onSessionsChange={(next) => {
                if (name() === projectName) synchronizeSessions(next);
              }}
            />
          </div>
        )}
      </Show>
      <Show when={tab() === "sessions"}>
        <ProjectSessions name={name()} onSessionsChange={() => refetchSessions()} />
      </Show>
      <Show when={tab() === "settings"}><ProjectSettings name={name()} /></Show>
    </div>
  );
}
