import * as THREE from "./vendor/three.module.js";
import { PALETTE, createSpace, sprite, disposeObject, reducedMotion } from "./space_renderer.js";
import {
  buildGalaxyArms,
  galaxyArmPointInto,
  centerlineDeviation,
  patternAngle,
  commitsFor,
  armSigma,
  nearestArm,
} from "./galaxy_arm_layout.mjs";
import { createArmGalaxy, createArmCommitStars } from "./galaxy_gpu.js";

const $ = (id) => document.getElementById(id);
// Data source: the local server's API, or a static snapshot published next to the page (GitHub Pages).
const STATIC = document.querySelector('meta[name="galaxy-source"]')?.content === "static";
const snapshotVersion = document.querySelector('meta[name="galaxy-snapshot-version"]')?.content;
const staticPath = (path) => snapshotVersion ? `${path}?v=${snapshotVersion}` : path;
const endpoints = {
  summary: () => (STATIC ? staticPath("data/galaxy.json") : "/api/github-galaxy"),
  repo: (name) => (STATIC ? staticPath(`data/repos/${encodeURIComponent(name)}.json`) : "/api/github-galaxy/repo?name=" + encodeURIComponent(name)),
  head: (name) => (STATIC ? staticPath(`data/heads/${encodeURIComponent(name)}.json`) : "/api/github-galaxy/head?name=" + encodeURIComponent(name)),
};
const host = $("galaxyCanvasHost"),
  stage = $("galaxyStage"),
  tip = $("galaxyTooltip"),
  info = $("galaxyInspect");
const reduced = reducedMotion;
const state = {
  space: null,
  group: null,
  detail: null,
  detailData: null,
  detailItem: null,
  detailLabels: [],
  overviewLabels: [],
  items: [],
  nodes: null,
  halo: null,
  overview: null,
  light: null,
  data: null,
  selected: null,
  hovered: null,
  headCache: new Map(),
  headTimer: 0,
  filter: "",
  frame: 0,
  last: 0,
  sampleStart: 0,
  sampleFrames: 0,
  visible: true,
  disposed: false,
  orbit: {
    theta: Math.PI - 0.08,
    phi: Math.PI - (52 * Math.PI) / 180,
    distance: 40,
    target: new THREE.Vector3(),
    thetaGoal: Math.PI - 0.08,
    phiGoal: Math.PI - (52 * Math.PI) / 180,
    distanceGoal: 36,
    targetGoal: new THREE.Vector3(),
    shift: 0,
    shiftGoal: 0,
  },
  selectedCommit: null,
  dim: { value: 1, goal: 1, applied: 1 },
  detailCache: new Map(),
  detailRequests: new Map(),
  prefetchTimer: 0,
  drag: null,
  moved: false,
  overviewDummy: null,
  syncMarkers: null,
};
const languageColors = [PALETTE.blue, 0xb8dcff, 0xe4f2ff, PALETTE.blue, PALETTE.violet, 0xc7ddff, PALETTE.blue, 0xe4f2ff, PALETTE.amber];
const debugTime = Number(new URLSearchParams(location.search).get("debugTime") || 0);
const ARM_HUES = [0x7fb2ff, 0x5fe0d2, 0xb48cff, 0xffb36b, 0x8fe38a, 0xff86b3, 0x6fd0ff, 0xf2d872, 0x9aa6ff, 0xff9d7a, 0x63c7a8, 0xd9a2ff];
function colorFor(language) {
  let n = 0;
  for (const char of language || "") n = (n * 31 + char.charCodeAt(0)) | 0;
  return languageColors[Math.abs(n) % languageColors.length];
}
function text(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function empty(message) {
  $("galaxyEmpty").textContent = message;
  $("galaxyEmpty").hidden = false;
}
function clearEmpty() {
  $("galaxyEmpty").hidden = true;
}
function clearGroup(group) {
  if (!group) return;
  state.space.scene.remove(group);
  disposeObject(group);
  if (group === state.group) state.overview?.gpu.dispose();
}
function camera() {
  const o = state.orbit;
  const smoothing = reduced.matches ? 1 : 0.065;
  o.theta += (o.thetaGoal - o.theta) * smoothing;
  o.phi += (o.phiGoal - o.phi) * smoothing;
  o.distance += (o.distanceGoal - o.distance) * smoothing;
  o.target.lerp(o.targetGoal, smoothing);
  o.phi = Math.max(0.14, Math.min(Math.PI - 0.14, o.phi));
  o.distance = Math.max(4, Math.min(100, o.distance));
  state.space.camera.position.set(
    o.target.x + Math.sin(o.phi) * Math.sin(o.theta) * o.distance,
    o.target.y + Math.cos(o.phi) * o.distance,
    o.target.z + Math.sin(o.phi) * Math.cos(o.theta) * o.distance,
  );
  state.space.camera.lookAt(o.target);
  state.space.camera.rotateZ(0.2);
  // Screen-space framing: lift the galaxy a little and slide it clear of the open repository panel.
  o.shift += (o.shiftGoal - o.shift) * smoothing;
  const w = host.clientWidth,
    h = host.clientHeight;
  if (w && h) state.space.camera.setViewOffset(w, h, o.shift, h * 0.045, w, h);
  state.space.camera.updateMatrixWorld();
}
function updateOverviewMotion() {
  if (!state.overview) return;
  const seconds = performance.now() * 0.001 + debugTime;
  state.overview.gpu.update(seconds, patternAngle(seconds), state.space.renderer.getDrawingBufferSize(state.overview.viewport).y);
  const labelCandidates = [];
  for (const item of state.items) {
    galaxyArmPointInto(item.position, item.focus, seconds, 0);
    for (let index = 0; index < item.pickSources.length; index++)
      galaxyArmPointInto(item.pickPoints[index], item.pickSources[index], seconds, 0);
    galaxyArmPointInto(item.labelPosition, item.label, seconds, 0);
    item.screen.copy(item.labelPosition).project(state.space.camera);
    if (item.labelElement) labelCandidates.push({ item, screen: item.screen });
  }
  // The core badge hangs under the projected core, just outside its glow.
  const core = coreScreen.set(0, 0, 0).project(state.space.camera),
    edge = coreEdge.setFromMatrixColumn(state.space.camera.matrixWorld, 1).multiplyScalar(1.15).project(state.space.camera);
  const cx = (core.x * 0.5 + 0.5) * host.clientWidth,
    cy = (-core.y * 0.5 + 0.5) * host.clientHeight,
    lift = Math.min(90, Math.max(10, Math.abs(edge.y - core.y) * 0.5 * host.clientHeight));
  if (state.coreLabel) state.coreLabel.style.transform = `translate3d(${cx.toFixed(1)}px,${(cy + lift).toFixed(1)}px,0) translate(-50%,0)`;
  const occupied = [{ left: cx - 70, right: cx + 70, top: cy + lift, bottom: cy + lift + 52 }];
  for (const candidate of labelCandidates.sort(
    (a, b) => (b.item.repo.name === state.selected) - (a.item.repo.name === state.selected) || a.item.index - b.item.index,
  )) {
    const { item, screen } = candidate,
      label = item.labelElement,
      x = (screen.x * 0.5 + 0.5) * host.clientWidth,
      y = (-screen.y * 0.5 + 0.5) * host.clientHeight,
      width = Math.max(36, label.textContent.length * 4.7),
      box = { left: x - width / 2, right: x + width / 2, top: y - 5, bottom: y + 5 };
    const blocked =
      screen.z > 1 ||
      item.visible === false ||
      box.left < 8 ||
      box.right > host.clientWidth - 8 ||
      box.top < 8 ||
      box.bottom > host.clientHeight - 54 ||
      occupied.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top);
    label.classList.toggle("off", blocked);
    label.classList.toggle("hot", item === state.hovered || item.repo.name === state.selected);
    label.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-50%)`;
    if (!blocked) occupied.push(box);
  }
  if (state.syncMarkers) {
    const attr = state.syncMarkers.geometry.attributes.position;
    for (const item of state.items) attr.setXYZ(item.index, item.position.x, item.position.y, item.position.z);
    attr.needsUpdate = true;
  }
}
function render(now) {
  state.frame = 0;
  if (!state.space || document.hidden || state.disposed) return;
  const delta = state.last ? Math.min(80, now - state.last) : 16;
  state.last = now;
  try {
    camera();
    applyDim();
    updateOverviewMotion(now);
    if (state.detail) updateDetailMotion(now);
    state.space.render(now, delta);
  } catch (error) {
    console.error("Galaxy renderer error", error);
    empty(`Galaxy renderer error: ${error.message}`);
    stop();
    return;
  }
  if (location.search.includes("debug=1")) {
    if (!state.sampleStart) state.sampleStart = now;
    if (++state.sampleFrames >= 120) {
      const fps = Math.round((state.sampleFrames * 1000) / Math.max(1, now - state.sampleStart));
      $("galaxyStatus").dataset.fps = String(fps);
      $("galaxyStatus").title = `${fps} FPS · ${state.space.bloom ? "BLOOM" : "REDUCED GLOW"}`;
      state.sampleStart = now;
      state.sampleFrames = 0;
    }
  }
  if (!reduced.matches) state.frame = requestAnimationFrame(render);
}
function requestFrame() {
  if (!state.space || document.hidden) return;
  if (state.frame && performance.now() - state.last < 250) return;
  cancelAnimationFrame(state.frame);
  state.frame = 0;
  render(performance.now());
}
function stop() {
  cancelAnimationFrame(state.frame);
  state.frame = 0;
  state.last = 0;
}
function init() {
  try {
    state.space = createSpace(host, { radius: 22, dust: 1800, seed: 154, shape: "ambient" });
  } catch (error) {
    empty(`WebGL unavailable: ${error.message}`);
    return false;
  }
  state.space.renderer.domElement.setAttribute("aria-label", "Interactive GitHub repository galaxy");
  if (location.search.includes("debug=sync"))
    window.__galaxyDebug = () => ({
      visible: state.visible,
      frame: state.frame,
      items: state.items.length,
      camera: state.space.camera.position.toArray(),
      target: state.orbit.target.toArray(),
      targetGoal: state.orbit.targetGoal.toArray(),
      calls: state.space.renderer.info.render.calls,
      triangles: state.space.renderer.info.render.triangles,
    });
  state.space.renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    stop();
    empty("WebGL context lost. Reload to restore the galaxy.");
  });
  state.space.stars.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  const core = sprite(PALETTE.core, 2.6, true, 0.95);
  core.position.set(0, 0, 0);
  core.renderOrder = 7;
  state.space.scene.add(core);
  state.light = core;
  state.coreSprites = [core];
  for (const [color, size, opacity] of [
    [0xffe2b0, 4.2, 0.42],
    [0xffb877, 9, 0.2],
    [0x6f8fd8, 19, 0.07],
  ]) {
    const halo = sprite(color, size, false, opacity);
    halo.renderOrder = 7;
    state.space.scene.add(halo);
    state.coreSprites.push(halo);
  }
  const name = document.createElement("span");
  name.className = "galaxy-core-label";
  name.innerHTML = "<i></i><b></b><small>CORE</small>";
  $("galaxyLabels").appendChild(name);
  state.coreLabel = name;
  if (location.search.includes("debug=exposure")) {
    const exposure = document.createElement("span");
    exposure.id = "galaxyExposure";
    exposure.className = "galaxy-exposure";
    $("galaxyLabels").appendChild(exposure);
  }
  installInteraction();
  requestFrame();
  return true;
}
function build(data) {
  if (!state.space && !init()) return;
  state.headCache.clear();
  for (const label of state.overviewLabels) label.remove();
  state.overviewLabels = [];
  clearGroup(state.group);
  state.syncMarkers = null;
  state.group = new THREE.Group();
  state.space.scene.add(state.group);
  state.overview = null;
  const repos = data.repositories || [];
  state.items = buildGalaxyArms(repos).map((arm) => {
    const pickSources = Array.from({ length: 12 }, (_, step) => ({
      ...arm.label,
      radius: arm.innerRadius + 1 + ((arm.outerRadius - arm.innerRadius - 1) * step) / 11,
    }));
    return {
      ...arm,
      position: new THREE.Vector3(),
      visible: true,
      focus: { ...arm.label, radius: 10 },
      pickSources,
      pickPoints: pickSources.map(() => new THREE.Vector3()),
      labelPosition: new THREE.Vector3(),
      screen: new THREE.Vector3(),
    };
  });
  if (!repos.length) {
    empty("No repositories returned by GitHub.");
    $("galaxyCount").textContent = "0 REPOSITORIES";
    return;
  }
  clearEmpty();
  for (const item of state.items) {
    item.languageColor = ARM_HUES[item.index % ARM_HUES.length];
    {
      const label = document.createElement("span");
      label.className = "galaxy-arm-label";
      label.textContent = item.repo.name;
      $("galaxyLabels").appendChild(label);
      item.labelElement = label;
      state.overviewLabels.push(label);
    }
  }
  state.dim.applied = null;
  const gpu = createArmGalaxy(state.items);
  state.group.add(gpu.group);
  state.nodes = gpu;
  state.overview = { gpu, viewport: new THREE.Vector2() };
  if (location.search.includes("debug=sync")) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        state.items.flatMap((item) => [item.position.x, item.position.y, item.position.z]),
        3,
      ),
    );
    state.syncMarkers = new THREE.Points(geometry, new THREE.PointsMaterial({ color: PALETTE.amber, size: 0.12, depthWrite: false }));
    state.group.add(state.syncMarkers);
    const deviation = centerlineDeviation(state.items.map((item) => ({ arm: item.index, count: item.count, radius: item.outerRadius })));
    console.info("Galaxy arm sync", deviation);
  }
  const summary = data.simulated
    ? "SIMULATED / API UNAVAILABLE"
    : data.snapshot
      ? `SNAPSHOT / ${new Date(data.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }).toUpperCase()}`
      : data.source === "github-graphql"
        ? "LIVE / GITHUB GRAPHQL"
        : "LIVE / GITHUB PUBLIC API";
  $("galaxyStatus").textContent = summary;
  $("galaxyStatus").title = data.reason || `Updated ${data.updatedAt}`;
  $("galaxyStatus").classList.toggle("galaxy-simulated", !!data.simulated);
  if (data.simulated)
    $("galaxyStatus").textContent = `SIMULATED DATA, NOT YOUR REPOSITORIES${data.reason ? " · " + data.reason.toUpperCase() : ""}`;
  $("galaxyCount").textContent = `${repos.length} REPOSITORIES · ${data.owner.toUpperCase()}`;
  $("galaxyOwner").textContent = (data.displayName || data.owner).toUpperCase();
  if (state.coreLabel)
    state.coreLabel.innerHTML = `<i></i><b>${text((data.displayName || data.owner).toUpperCase())}</b><small>CORE · ${repos.length} REPOSITORIES</small>`;
  $("galaxyLanguages").innerHTML =
    '<option value="">ALL LANGUAGES</option>' +
    [...new Set(repos.map((r) => r.language))]
      .sort()
      .map((l) => `<option value="${text(l)}">${text(l.toUpperCase())}</option>`)
      .join("");
  $("galaxyLanguages").value = state.filter;
  state.orbit.distanceGoal = repos.length > 80 ? 39 : 36;
  filter();
  if (state.selected) {
    const active = state.items.find((i) => i.repo.name === state.selected);
    if (active) select(active);
    else back();
  }
  requestFrame();
}
function cacheChip(data) {
  let chip = document.getElementById("galaxyCacheChip");
  if (!data.stale) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "galaxyCacheChip";
    chip.className = "galaxy-cache-chip";
    $("galaxyStatus").after(chip);
  }
  const age = data.cacheAgeSeconds || 0;
  chip.textContent = `CACHED ${age < 3600 ? Math.max(1, Math.floor(age / 60)) + "M" : Math.floor(age / 3600) + "H"} AGO`;
}
function filter() {
  const q = $("galaxySearch").value.trim().toLowerCase(),
    language = $("galaxyLanguages").value;
  state.filter = language;
  for (const item of state.items) {
    item.visible =
      (!q || item.repo.name.toLowerCase().includes(q)) &&
      (!language || item.repo.language === language) &&
      ($("galaxyForks").checked || !item.repo.fork) &&
      ($("galaxyArchived").checked || !item.repo.archived);
  }
  armStates();
  const matching = state.items.filter((item) => item.visible);
  $("galaxyCount").textContent = `${matching.length} / ${state.items.length} REPOSITORIES · ${state.data.owner.toUpperCase()}`;
  $("galaxyResults").innerHTML = q
    ? matching
        .slice(0, 8)
        .map(
          (item) =>
            `<button type="button" data-repo="${text(item.repo.name)}">${text(item.repo.name)} <small>${text(item.repo.language)}</small></button>`,
        )
        .join("") || "<span>NO MATCHES</span>"
    : "";
  $("galaxyResults").hidden = !q;
  if (q && matching.length === 1) highlight(matching[0]);
  requestFrame();
}
const coreScreen = new THREE.Vector3(),
  coreEdge = new THREE.Vector3(),
  pickRay = new THREE.Raycaster(),
  pickPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
  pickPoint = new THREE.Vector3(),
  pickMouse = new THREE.Vector2();
function hit(event) {
  if (!state.nodes) return null;
  const rect = host.getBoundingClientRect();
  // Every point of the disc belongs to the nearest arm, so a repository can be picked anywhere on its band.
  pickMouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, (-(event.clientY - rect.top) / rect.height) * 2 + 1);
  pickRay.setFromCamera(pickMouse, state.space.camera);
  if (Math.abs(pickRay.ray.direction.z) > 0.18 && pickRay.ray.intersectPlane(pickPlane, pickPoint)) {
    const found = nearestArm(
      state.items.filter((item) => item.visible),
      pickPoint.x,
      pickPoint.y,
      performance.now() * 0.001 + debugTime,
    );
    return found && found.distance < Math.max(1.4, found.radius * 0.35) ? found.arm : null;
  }
  let nearest = null,
    distance = 22;
  state.group.updateMatrixWorld(true);
  for (const item of state.items) {
    if (!item.visible) continue;
    for (const source of item.pickPoints || []) {
      const p = source.clone().applyMatrix4(state.group.matrixWorld).project(state.space.camera);
      if (p.z < -1 || p.z > 1) continue;
      const x = (p.x * 0.5 + 0.5) * rect.width,
        y = (-p.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(x - (event.clientX - rect.left), y - (event.clientY - rect.top));
      if (d < distance) {
        distance = d;
        nearest = item;
      }
    }
  }
  return nearest;
}
function armStates() {
  const focus = state.hovered && !state.selected;
  state.overview?.gpu.setArms(
    state.items.map((item) => (!item.visible ? 0.13 : item === state.hovered || item.repo.name === state.selected ? 2 : focus ? 0.38 : 1)),
  );
}
function highlight(item, event) {
  const changed = state.hovered?.repo.name !== item?.repo.name;
  state.hovered = item;
  if (changed) armStates();
  if (changed && item && !state.detailCache.has(item.repo.name)) {
    clearTimeout(state.prefetchTimer);
    state.prefetchTimer = setTimeout(() => {
      if (state.hovered === item) loadDetail(item.repo.name).catch(() => {});
    }, 350);
  }
  if (!item) return;
  const p = item.position.clone().applyMatrix4(state.group.matrixWorld).project(state.space.camera),
    rect = host.getBoundingClientRect();
  const x = event ? event.clientX - rect.left : (p.x * 0.5 + 0.5) * host.clientWidth,
    y = event ? event.clientY - rect.top : (-p.y * 0.5 + 0.5) * host.clientHeight;
  const head = state.headCache.get(item.repo.name);
  const latest = head?.lastCommit
    ? `${head.lastCommit.slice(0, 8)} · ${head.subject || ""} · ${new Date(head.date).toLocaleDateString()}`
    : item.repo.lastCommit
      ? `${item.repo.lastCommit.slice(0, 8)} · ${item.repo.lastCommitSubject || ""}`
      : head
        ? "no commits recorded"
        : "loading latest commit…";
  tip.textContent = `${item.repo.name} · ${item.repo.language} · ${item.repo.private ? "PRIVATE" : "PUBLIC"} · CI ${head?.status || "loading"} · ${latest}`;
  tip.hidden = false;
  tip.style.left = `${Math.min(host.clientWidth - tip.offsetWidth - 10, Math.max(10, x + 15))}px`;
  tip.style.top = `${Math.min(host.clientHeight - tip.offsetHeight - 10, Math.max(10, y + 12))}px`;
  if (changed && !state.headCache.has(item.repo.name) && !item.repo.lastCommit) {
    clearTimeout(state.headTimer);
    state.headTimer = setTimeout(async () => {
      try {
        const response = await fetch(endpoints.head(item.repo.name));
        if (!response.ok) return;
        state.headCache.set(item.repo.name, await response.json());
        if (state.hovered?.repo.name === item.repo.name) highlight(item);
      } catch {
        /* Hover detail is optional when GitHub is unreachable. */
      }
    }, 180);
  }
}
function removeDetailLabels() {
  for (const label of state.detailLabels) label.remove();
  state.detailLabels = [];
}
// Dimming eases toward its goal every frame, so leaving a repository fades the galaxy back instead of snapping.
function setOverviewDim(amount = 1) {
  state.dim.goal = amount;
  requestFrame();
}
function applyDim() {
  const dim = state.dim;
  if (dim.value === dim.goal && dim.applied === dim.value) return;
  dim.value = reduced.matches || Math.abs(dim.goal - dim.value) < 0.004 ? dim.goal : dim.value + (dim.goal - dim.value) * 0.1;
  dim.applied = dim.value;
  const amount = dim.value,
    lit = Math.max(0, Math.min(1, (amount - 0.25) / 0.75));
  for (const glow of state.coreSprites || []) {
    glow.material.userData.base ??= glow.material.opacity;
    glow.material.opacity = glow.material.userData.base * (0.18 + 0.82 * lit);
  }
  if (state.coreLabel) state.coreLabel.style.opacity = String(lit);
  const visited = new Set();
  state.group?.traverse((object) => {
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material || visited.has(material)) continue;
      visited.add(material);
      if (material.uniforms?.uOpacity) {
        material.userData.detailOpacity ??= material.uniforms.uOpacity.value;
        material.uniforms.uOpacity.value = material.userData.detailOpacity * amount;
        continue;
      }
      material.userData.detailOpacity ??= material.opacity;
      material.transparent = true;
      material.opacity = material.userData.detailOpacity * amount;
    }
  });
}
function clearDetail() {
  removeDetailLabels();
  if (state.detail) {
    state.detail.userData.stars?.dispose();
    clearGroup(state.detail);
    state.detail = null;
  }
  state.detailData = null;
  state.detailItem = null;
  state.selectedCommit = null;
  setOverviewDim(1);
}
function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}
function relativeTime(date) {
  const seconds = Math.max(0, (Date.now() - Date.parse(date || Date.now())) / 1000);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 2592000)}mo ago`;
}
function actionTone(run) {
  return run.status !== "completed" ? PALETTE.amber : run.conclusion === "success" ? PALETTE.green : PALETTE.red;
}
function detailTone(item) {
  return new THREE.Color(item.languageColor ?? colorFor(item.repo.language)).lerp(new THREE.Color(PALETTE.core), 0.2);
}
function branchLabel(name, position, color) {
  const label = document.createElement("span");
  label.className = "galaxy-branch-label";
  label.textContent = name;
  label.style.setProperty("--branch-tone", "#" + color.getHexString());
  $("galaxyLabels").appendChild(label);
  state.detailLabels.push(label);
  return { label, position };
}
function drawDetail(data, item) {
  clearDetail();
  if (!data || data.simulated) return;
  const group = new THREE.Group(),
    tone = detailTone(item),
    white = new THREE.Color(PALETTE.core);
  state.space.scene.add(group);
  state.detail = group;
  state.detailData = data;
  state.detailItem = item;
  setOverviewDim(0.25);
  const defaultName = data.repository?.defaultBranch || data.branches[0]?.name || "main",
    heads = new Map(data.branches.map((branch) => [branch.name, branch.head]));
  const lanes = new Map([[defaultName, 0]]);
  for (const branch of data.branches) if (!lanes.has(branch.name)) lanes.set(branch.name, lanes.size);
  const branchStates = new Map(
    [...lanes].map(([name, lane]) => [
      name,
      {
        name,
        lane,
        head: heads.get(name) || null,
        primary: lane === 0,
        satellites: [],
        tone: lane === 0 ? tone.clone() : tone.clone().offsetHSL(0.09 * lane * (lane % 2 ? 1 : -1), 0.08, 0.06),
      },
    ]),
  );
  const sources = commitsFor({ overviewCommits: data.commits }, item.index, item.count, item.innerRadius, item.pitchDegrees);
  const satellites = [],
    satelliteById = new Map(),
    colors = [];
  for (const source of sources) {
    const commit = source.commit,
      branch = branchStates.get(commit.branch) || branchStates.get(defaultName);
    // Side branches run as parallel strands inside the arm, alternating to either side of main.
    if (branch.lane) source.lateral += armSigma(item, source.radius) * 0.9 * Math.ceil(branch.lane / 2) * (branch.lane % 2 ? 1 : -1);
    const merge = commit.parents?.length > 1,
      head = branch.head === commit.oid;
    source.size =
      0.05 +
      Math.min(0.06, Math.log1p((commit.additions || 0) + (commit.deletions || 0)) * 0.008) +
      (head ? 0.02 : 0) +
      (merge ? 0.012 : 0);
    source.head = head;
    const satellite = { commit, branch, index: satellites.length, size: source.size, source, position: new THREE.Vector3() };
    colors.push(merge ? branch.tone.clone().lerp(white, 0.4) : branch.tone);
    satellites.push(satellite);
    satelliteById.set(commit.oid, satellite);
    branch.satellites.push(satellite);
  }
  const stars = createArmCommitStars(item, sources, colors);
  group.add(stars.points);
  const actionRings = [];
  data.actions.slice(0, 18).forEach((run, index) => {
    const satellite = satelliteById.get(run.head) || branchStates.get(run.branch)?.satellites[0];
    if (!satellite) return;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(satellite.size * (2.5 + (index % 3) * 0.24), 0.008, 4, 32),
      new THREE.MeshBasicMaterial({
        color: actionTone(run),
        transparent: true,
        opacity: 0.76,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.rotation.x = 0.74;
    group.add(ring);
    actionRings.push({ ring, satellite, index });
  });
  const branchLabels = [...branchStates.values()]
    .filter((branch) => !branch.primary && branch.satellites.length)
    .map((branch) => branchLabel(branch.name, branch.satellites[0].position, branch.tone));
  state.detail.userData = {
    stars,
    satellites,
    satelliteById,
    branchStates,
    branchLabels,
    actionRings,
    beltOlder: 0,
    born: performance.now(),
  };
  updateDetailMotion(performance.now());
  requestFrame();
}
function updateDetailMotion(now) {
  if (!state.detail) return;
  const d = state.detail.userData,
    t = now || performance.now(),
    seconds = t * 0.001 + debugTime;
  const reveal = reduced.matches
    ? d.closingAt
      ? 0
      : 1
    : d.closingAt
      ? 1 - easeOutCubic(Math.min(1, (t - d.closingAt) / 320))
      : easeOutCubic(Math.min(1, (t - (d.born || t)) / 900));
  for (const satellite of d.satellites) galaxyArmPointInto(satellite.position, satellite.source, seconds);
  const index = (oid) => (oid ? d.satellites.findIndex((s) => s.commit.oid === oid) : -1);
  d.stars.update(
    seconds,
    patternAngle(seconds),
    reveal,
    state.space.renderer.getDrawingBufferSize(d.stars.viewport).y,
    index(state.selectedCommit),
    index(state.hoveredCommit),
  );
  for (const entry of d.actionRings) {
    entry.ring.position.copy(entry.satellite.position);
    const pulse = 1 + 0.17 * Math.sin(t * 0.004 + entry.index);
    entry.ring.scale.setScalar(pulse);
    entry.ring.material.opacity = (0.52 + 0.25 * Math.sin(t * 0.004 + entry.index)) * reveal;
  }
  for (const { label, position } of d.branchLabels) {
    const projected = position.clone().project(state.space.camera),
      x = Math.round((projected.x * 0.5 + 0.5) * host.clientWidth),
      y = Math.round((-projected.y * 0.5 + 0.5) * host.clientHeight);
    label.style.transform = `translate(${x}px,${y}px) translate(-50%,-160%)`;
    label.hidden = projected.z > 1 || reveal < 0.6;
  }
}
function panelContent(data, item) {
  const commits = data.commits.slice(0, 24),
    older = Math.max(0, data.commits.length - commits.length),
    tone = "#" + detailTone(item).getHexString();
  const accordion = (name, open, body) =>
    `<section class="galaxy-accordion ${open ? "open" : ""}"><button type="button" data-accordion aria-expanded="${open}"><b>${name}</b><span>⌄</span></button><div class="galaxy-accordion-body"><div>${body}</div></div></section>`;
  const selected =
    '<div id="galaxyCommitCard" class="galaxy-commit-card"><span class="micro">SELECTED COMMIT</span><b>Select a commit</b><small>Hover a commit star on the arm or a row below.</small></div>';
  const branchRows =
    data.branches
      .map(
        (branch) =>
          `<div class="galaxy-branch-row"><i style="background:${tone}"></i><span>${text(branch.name)}</span><small>${text((branch.head || "").slice(0, 8))}</small></div>`,
      )
      .join("") || '<span class="galaxy-empty-row">No branches</span>';
  const commitRows =
    commits
      .map(
        (commit) =>
          `<button type="button" class="galaxy-commit-row" data-commit="${text(commit.oid)}" title="${text(commit.subject)}"><i style="background:${tone}"></i><span>${text(commit.subject || "Untitled commit")}</span><time>${relativeTime(commit.date)}</time></button>`,
      )
      .join("") + (older ? `<div class="galaxy-older-row">+${older} older commits</div>` : "");
  const prRows =
    data.pullRequests
      .slice(0, 12)
      .map(
        (pr) =>
          `<a class="galaxy-detail-link" href="${text(pr.url)}" target="_blank" rel="noopener noreferrer">#${pr.number} ${text(pr.title)} · ${text(pr.state)}</a>`,
      )
      .join("") || '<span class="galaxy-empty-row">No pull requests</span>';
  const actionRows =
    data.actions
      .slice(0, 12)
      .map(
        (action) =>
          `<a class="galaxy-detail-link" href="${text(action.url)}" target="_blank" rel="noopener noreferrer"><i class="action-${text(action.conclusion || action.status || "unknown").toLowerCase()}"></i>${text(action.name)} · ${text(action.conclusion || action.status)}</a>`,
      )
      .join("") || '<span class="galaxy-empty-row">No Actions runs</span>';
  const unavailable = data.unavailable
    ? '<div class="galaxy-detail-notice">GitHub detail is temporarily unavailable; the overview remains live.</div>'
    : "";
  return `<div class="galaxy-panel-sticky"><span class="micro galaxy-crumb">REPO</span><strong>${text(item.repo.name)}</strong><span class="galaxy-repo-meta">${text(item.repo.language)} · ${item.repo.private ? "PRIVATE" : "PUBLIC"} · ${item.repo.stars} STARS</span><div class="galaxy-stat-grid"><span><b>${data.branches.length}</b>BRANCHES</span><span><b>${data.commits.length}</b>COMMITS</span><span><b>${data.pullRequests.length}</b>PRS</span><span><b>${data.actions.length}</b>ACTIONS</span></div></div>${unavailable}${selected}${accordion("BRANCHES", false, branchRows)}${accordion("COMMITS", true, `<div class="galaxy-commit-list">${commitRows || '<span class="galaxy-empty-row">No commits</span>'}</div>`)}${accordion("PULL REQUESTS", false, prRows)}${accordion("ACTIONS", true, actionRows)}`;
}
function showPanel() {
  info.hidden = false;
  info.classList.remove("open");
  if (reduced.matches) {
    info.classList.add("open");
    return;
  }
  setTimeout(() => info.classList.add("open"), 180);
}
function renderPanel(data, item) {
  const detail = $("galaxyDetail");
  detail.classList.add("switching");
  detail.innerHTML = panelContent(data, item);
  requestAnimationFrame(() => detail.classList.remove("switching"));
  info.onclick = (event) => {
    const accordionButton = event.target.closest("[data-accordion]");
    if (accordionButton) {
      const section = accordionButton.closest(".galaxy-accordion"),
        open = section.classList.toggle("open");
      accordionButton.setAttribute("aria-expanded", String(open));
      return;
    }
    const row = event.target.closest("[data-commit]");
    if (row) {
      const commit = data.commits.find((candidate) => candidate.oid === row.dataset.commit);
      if (commit) selectCommit(commit, true);
    }
  };
  info.onpointerover = (event) => {
    const row = event.target.closest("[data-commit]");
    if (!row) return;
    const satellite = state.detail?.userData.satelliteById.get(row.dataset.commit);
    if (satellite) hoverCommit(satellite, event);
  };
  info.onpointerout = (event) => {
    if (event.target.closest("[data-commit]")) clearCommitHover();
  };
}
function updateCommitCard(commit) {
  const card = $("galaxyCommitCard");
  if (!card || !commit) return;
  card.innerHTML = `<span class="micro">SELECTED COMMIT</span><b title="${text(commit.subject)}">${text(commit.subject || "Untitled commit")}</b><small>${text(commit.oid.slice(0, 10))} · ${text(commit.author)} · ${new Date(commit.date).toLocaleString()} · +${commit.additions || 0}/−${commit.deletions || 0} · ${text(commit.branch)}</small>`;
}
function selectCommit(commit, fly = false) {
  const satellite = state.detail?.userData.satelliteById.get(commit.oid);
  if (!satellite) return;
  state.selectedCommit = commit.oid;
  updateCommitCard(commit);
  info.querySelectorAll("[data-commit]").forEach((row) => row.classList.toggle("selected", row.dataset.commit === commit.oid));
  $("galaxySelection").textContent = `${commit.oid.slice(0, 10)} · ${commit.author} · +${commit.additions || 0}/−${commit.deletions || 0}`;
  if (fly) {
    state.orbit.targetGoal
      .copy(satellite.position)
      .add(state.detail?.position || new THREE.Vector3())
      .add(new THREE.Vector3(0.38, 0, 0));
    state.orbit.distanceGoal = 10;
    state.orbit.thetaGoal = 0.78;
    state.orbit.phiGoal = Math.PI - 1.16;
  }
  requestFrame();
}
function positionTooltip(content, event) {
  tip.textContent = content;
  tip.hidden = false;
  const rect = host.getBoundingClientRect(),
    x = event.clientX - rect.left,
    y = event.clientY - rect.top;
  tip.style.left = `${Math.min(host.clientWidth - tip.offsetWidth - 10, Math.max(10, x + 15))}px`;
  tip.style.top = `${Math.min(host.clientHeight - tip.offsetHeight - 10, Math.max(10, y + 12))}px`;
}
function hoverCommit(satellite, event) {
  state.hoveredCommit = satellite.commit.oid;
  const commit = satellite.commit;
  positionTooltip(
    `${commit.oid.slice(0, 10)} · ${commit.subject || "Untitled commit"} · ${commit.author} · ${new Date(commit.date).toLocaleDateString()}`,
    event,
  );
  info.querySelectorAll("[data-commit]").forEach((row) => row.classList.toggle("hovered", row.dataset.commit === commit.oid));
}
function clearCommitHover() {
  state.hoveredCommit = null;
  info.querySelectorAll("[data-commit]").forEach((row) => row.classList.remove("hovered"));
  tip.hidden = true;
}
function hitSatellite(event) {
  if (!state.detail) return null;
  const rect = host.getBoundingClientRect();
  let hit = null,
    best = 18;
  for (const satellite of state.detail.userData.satellites) {
    const p = satellite.position.clone().add(state.detail.position).project(state.space.camera);
    if (p.z < -1 || p.z > 1) continue;
    const x = (p.x * 0.5 + 0.5) * rect.width,
      y = (-p.y * 0.5 + 0.5) * rect.height,
      d = Math.hypot(x - (event.clientX - rect.left), y - (event.clientY - rect.top));
    if (d < best) {
      best = d;
      hit = satellite;
    }
  }
  return hit;
}
function detailSignature(data) {
  return [
    data.commits?.[0]?.oid,
    data.commits?.length,
    data.branches?.length,
    data.pullRequests?.length,
    data.actions?.map((run) => run.id + run.status + run.conclusion).join(),
  ].join("|");
}
// One request per repository at a time; results stay in the page so reopening a repository is instant.
function loadDetail(name) {
  if (state.detailRequests.has(name)) return state.detailRequests.get(name);
  const request = fetch(endpoints.repo(name), { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      if (!data.unavailable && !data.simulated) state.detailCache.set(name, { data, at: Date.now() });
      return data;
    })
    .finally(() => state.detailRequests.delete(name));
  state.detailRequests.set(name, request);
  return request;
}
async function select(item) {
  if (state.detail?.userData.closing) clearDetail();
  const switching = state.selected && state.selected !== item.repo.name;
  state.selected = item.repo.name;
  tip.hidden = true;
  armStates();
  state.orbit.targetGoal.set(0, 0, 0);
  state.orbit.shiftGoal = Math.min(info.offsetWidth || 400, host.clientWidth * 0.32) * 0.5;
  state.orbit.distanceGoal = 34;
  state.orbit.thetaGoal = Math.PI - 0.08;
  state.orbit.phiGoal = Math.PI - 0.68;
  if (switching) clearDetail();
  showPanel();
  $("galaxyBack").hidden = false;
  $("galaxyDetail").innerHTML =
    `<div class="galaxy-panel-sticky"><span class="micro galaxy-crumb">REPO</span><strong>${text(item.repo.name)}</strong></div><div class="galaxy-panel-loading">Loading branches, commits, pull requests and Actions…</div>`;
  requestFrame();
  const name = item.repo.name,
    cached = state.detailCache.get(name);
  if (cached) {
    drawDetail(cached.data, item);
    renderPanel(cached.data, item);
    if (Date.now() - cached.at < 60000) return;
  }
  try {
    const data = await loadDetail(name);
    if (state.selected !== name) return;
    if (!cached || detailSignature(data) !== detailSignature(cached.data)) {
      drawDetail(data, item);
      renderPanel(data, item);
    }
  } catch (error) {
    if (state.selected === name && !cached)
      $("galaxyDetail").innerHTML = `<div class="galaxy-panel-loading">Detail unavailable: ${text(error.message)}</div>`;
  }
}
function back() {
  state.selected = null;
  armStates();
  const closing = state.detail;
  if (closing) {
    closing.userData.closing = true;
    closing.userData.closingAt = performance.now();
    setTimeout(
      () => {
        if (!state.selected && state.detail === closing) clearDetail();
      },
      reduced.matches ? 0 : 340,
    );
  } else clearDetail();
  info.classList.remove("open");
  tip.hidden = true;
  $("galaxyBack").hidden = true;
  setTimeout(
    () => {
      if (!state.selected) info.hidden = true;
    },
    reduced.matches ? 0 : 280,
  );
  setOverviewDim(1);
  state.orbit.targetGoal.set(0, 0, 0);
  state.orbit.shiftGoal = 0;
  state.orbit.distanceGoal = state.items.length > 80 ? 39 : 36;
  state.orbit.thetaGoal = Math.PI - 0.08;
  state.orbit.phiGoal = Math.PI - (52 * Math.PI) / 180;
  $("galaxySelection").textContent = "SELECT A REPOSITORY";
  requestFrame();
}
function installInteraction() {
  host.addEventListener("pointerdown", (e) => {
    state.drag = { x: e.clientX, y: e.clientY, button: e.button };
    state.moved = false;
    host.setPointerCapture(e.pointerId);
  });
  host.addEventListener("pointermove", (e) => {
    if (state.drag) {
      const dx = e.clientX - state.drag.x,
        dy = e.clientY - state.drag.y;
      state.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
      state.drag.x = e.clientX;
      state.drag.y = e.clientY;
      if (e.shiftKey || state.drag.button === 2) {
        const scale = state.orbit.distance * 0.0016;
        const right = new THREE.Vector3().setFromMatrixColumn(state.space.camera.matrix, 0),
          up = new THREE.Vector3().setFromMatrixColumn(state.space.camera.matrix, 1);
        state.orbit.targetGoal.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
      } else {
        state.orbit.thetaGoal -= dx * 0.006;
        state.orbit.phiGoal -= dy * 0.006;
      }
      tip.hidden = true;
      requestFrame();
      return;
    }
    const satellite = hitSatellite(e);
    if (satellite) {
      host.style.cursor = "pointer";
      hoverCommit(satellite, e);
      return;
    }
    const item = hit(e);
    host.style.cursor = item ? "pointer" : "grab";
    if (item) highlight(item, e);
    else {
      if (state.hovered) {
        state.hovered = null;
        armStates();
      }
      clearTimeout(state.headTimer);
      clearCommitHover();
    }
  });
  host.addEventListener("pointerup", (e) => {
    if (!state.moved) {
      const satellite = hitSatellite(e);
      if (satellite) selectCommit(satellite.commit, true);
      else {
        const item = hit(e);
        if (item) select(item);
      }
    }
    state.drag = null;
    host.releasePointerCapture(e.pointerId);
  });
  host.addEventListener("pointercancel", () => (state.drag = null));
  host.addEventListener(
    "wheel",
    (e) => {
      if (!(e.altKey || e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      state.orbit.distanceGoal *= Math.exp(e.deltaY * 0.001);
      requestFrame();
    },
    { passive: false },
  );
  host.addEventListener("contextmenu", (e) => e.preventDefault());
  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      back();
      return;
    }
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (dirs[e.key]) {
      e.preventDefault();
      e.stopPropagation();
      state.orbit.thetaGoal += dirs[e.key][0] * 0.16;
      state.orbit.phiGoal += dirs[e.key][1] * 0.16;
      requestFrame();
    } else if (e.key === "+" || e.key === "-") {
      e.preventDefault();
      state.orbit.distanceGoal *= e.key === "+" ? 0.9 : 1.1;
      requestFrame();
    }
  });
  $("galaxyBack").addEventListener("click", back);
  $("galaxyClose").addEventListener("click", back);
  $("galaxySearch").addEventListener("input", filter);
  $("galaxyLanguages").addEventListener("change", filter);
  $("galaxyForks").addEventListener("change", filter);
  $("galaxyArchived").addEventListener("change", filter);
  $("galaxySearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const name = $("galaxyResults").querySelector("[data-repo]")?.dataset.repo;
      const item = state.items.find((candidate) => candidate.repo.name === name);
      if (item) {
        select(item);
        $("galaxyResults").hidden = true;
      }
    }
  });
  $("galaxyResults").addEventListener("click", (e) => {
    const name = e.target.closest("[data-repo]")?.dataset.repo;
    const item = state.items.find((candidate) => candidate.repo.name === name);
    if (item) {
      select(item);
      $("galaxyResults").hidden = true;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.selected) back();
  });
}
async function refresh() {
  if (document.hidden || state.disposed) return;
  try {
    const response = await fetch(endpoints.summary(), { cache: "no-store" });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (state.disposed) return;
    const signature = JSON.stringify(data.repositories.map((r) => [r.name, r.pushedAt, r.commits, r.stars])) + data.source;
    if (signature !== state.signature) {
      state.signature = signature;
      state.data = data;
      build(data);
    } else requestFrame();
    cacheChip(data);
  } catch (error) {
    empty(`GitHub source unavailable: ${error.message}`);
    $("galaxyStatus").textContent = "SOURCE UNAVAILABLE";
  }
}
const observer = new IntersectionObserver(
  (entries) => {
    state.visible = entries[0].isIntersecting;
    if (state.visible) requestFrame();
  },
  { threshold: 0.01 },
);
observer.observe(stage);
refresh();
reduced.addEventListener?.("change", requestFrame);
window.addEventListener(
  "scroll",
  () => {
    const box = stage.getBoundingClientRect();
    if (box.bottom > 0 && box.top < innerHeight) {
      state.visible = true;
      stop();
      requestFrame();
    }
  },
  { passive: true },
);
const timer = setInterval(refresh, 60000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
  else {
    refresh();
    requestFrame();
  }
});
window.addEventListener("pagehide", () => {
  state.disposed = true;
  stop();
  clearInterval(timer);
  observer.disconnect();
  clearDetail();
  clearGroup(state.group);
  state.light?.material.dispose();
  state.space?.dispose();
});
