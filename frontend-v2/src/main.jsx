import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import { lazy } from "solid-js";
import { App } from "./App.jsx";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

const Login     = lazy(() => import("./pages/Login.jsx"));
const Projects  = lazy(() => import("./pages/Projects.jsx"));
const Project   = lazy(() => import("./pages/Project.jsx"));
const Settings  = lazy(() => import("./pages/Settings.jsx"));
const Audit     = lazy(() => import("./pages/Audit.jsx"));

render(
  () => (
    <Router root={App}>
      <Route path="/login" component={Login} />
      <Route path="/" component={Projects} />
      <Route path="/projects" component={Projects} />
      <Route path="/projects/:name/*" component={Project} />
      <Route path="/settings" component={Settings} />
      <Route path="/audit" component={Audit} />
    </Router>
  ),
  document.getElementById("root")
);
