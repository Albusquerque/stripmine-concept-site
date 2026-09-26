import React from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import * as JSX from "react/jsx-runtime";

window.SP_REACT = React;
window.SP_REACTDOM = ReactDOM;
window.SP_JSX = JSX;

// The concept site keeps its iframes alive while visitors compare surfaces.
// Track every Web Audio context created by the full-game preview so hiding the
// tab can silence all of them, including a stale context from a rapid switch.
const NativeAudioContext = window.AudioContext;
const previewAudioContexts = new Set();
Object.defineProperty(window, "__stripminePreviewAudioCount", {
  configurable: false,
  get: () => previewAudioContexts.size,
});
if (NativeAudioContext && location.hash !== "#panel") {
  window.AudioContext = class PreviewAudioContext extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      previewAudioContexts.add(this);
    }
    close() {
      previewAudioContexts.delete(this);
      return super.close();
    }
  };
}

function stopAllPreviewAudio() {
  for (const context of previewAudioContexts) void context.close().catch(() => undefined);
  previewAudioContexts.clear();
}

const stripProps = ({ navEntryPreferPosition, preferredFocus, onGamepadFocus, onGamepadBlur, ...props }) => props;
const Button = (props) => React.createElement("button", stripProps(props));
const Focusable = (props) => React.createElement("div", stripProps(props));
const PanelSection = ({ title, children }) => React.createElement("section", { className: "mock-panel", "aria-label": title }, children);
const SliderField = ({ label, value, min, max, step, onChange }) => React.createElement("label", { className: "mock-slider" },
  React.createElement("span", null, label),
  React.createElement("input", { type: "range", value, min, max, step, onChange: (event) => onChange?.(Number(event.target.value)) }));

window.DFL = {
  Button, Focusable, PanelSection, SliderField,
  Navigation: { NavigateBack() {}, CloseSideMenus() {}, Navigate(path) { if (path === "/stripmine/play" && registeredGame && previewRoot) previewRoot.render(React.createElement(registeredGame)); } },
  NavEntryPositionPreferences: { PREFERRED_CHILD: 0 },
  staticClasses: { Title: "mock-title" },
};

const blue = [5, 66, 176];
const yellow = [255, 205, 55];
const BASE_WORKER_CYCLE_SECONDS = 22;
const deposits = [
  { name: "Red Ferrite", short: "FERRITE", color: [237, 68, 61], secondary: [255, 115, 40], light: [255, 161, 126], center: 10, icon: "shard", pattern: "GROW", story: "A tiny ember inside the factory-blue rock." },
  { name: "Branching Emerald", short: "EMERALD", color: [20, 183, 101], secondary: [74, 220, 154], light: [116, 255, 181], center: 9, icon: "branch", pattern: "BRANCH", story: "Green rock forks into two pockets and divides the crew." },
  { name: "Thermal Amber", short: "AMBER", color: [240, 157, 30], secondary: [237, 85, 52], light: [255, 224, 137], center: 11, icon: "flame", pattern: "COOLDOWN", story: "A hot core pulses underground and demands a patient rhythm." },
  { name: "Twin Amethyst", short: "AMETHYST", color: [160, 82, 233], secondary: [232, 75, 174], light: [225, 168, 255], center: 8, icon: "twin", pattern: "RELAY", story: "Two geodes answer each other across the centre of the mine." },
  { name: "Living Prism", short: "PRISM", color: [30, 195, 211], secondary: [255, 190, 54], light: [255, 244, 165], center: 10, icon: "prism", pattern: "SPECTRUM", story: "Every strike changes its frequency; no fragment keeps one colour." },
  { name: "Ancient Core", short: "CORE", color: [225, 233, 247], secondary: [247, 72, 153], light: [255, 255, 255], center: 8, icon: "core", pattern: "JACKPOT", story: "Blue light dies around a white core. The whole crew climbs together." },
];
const city = [null, null, null];
let previewStarted = performance.now();
let lastSimulationTick = previewStarted;
let simulationSeconds = 0;
let lastCycle = -1;
let registeredGame = null;
let previewRoot = null;
let simTempo = 2;
let opticalBar = false;
let previewIntroSeen = false;
const LIGHT_PROFILE_MESSAGE = "stripmine:light-profile";
let convoyHeld = false;
const previewHeldWorkers = new Set();
let overchargeStarted = -Infinity;
let previewProgress = 0;
let previewDeposit = 0;
let previewCompletedVeins = 0;
let previewRewardUntil = 0;
let previewRewardSeq = 0;
let previewRewardKind = "";
let previewStrikes = 0;
let previewStrikeReadyAt = 0;
let actionCue = null;
let actionCueSeq = 1000;
let previewOre = 0;
let previewCashoutSeq = 0;
const emptyCashout = () => ({ seq: 0, workers: [], side: "left", payload: 0, steps: [], total: 0, ore: 0, label: "FERRITE", at: 0 });
let previewLastCashout = emptyCashout();

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== LIGHT_PROFILE_MESSAGE) return;
  if (event.data.style === "luminous" || event.data.style === "contrasted") {
    opticalBar = event.data.style === "contrasted";
  }
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== "stripmine:preview-screen-active") return;
  if (location.hash === "#panel" || !previewRoot || !registeredGame) return;
  if (!event.data.active) stopAllPreviewAudio();
  ReactDOM.flushSync(() => previewRoot.render(event.data.active ? React.createElement(registeredGame) : null));
});

function publishLightProfile() {
  if (window.parent === window) return;
  window.parent.postMessage({
    type: LIGHT_PROFILE_MESSAGE,
    style: opticalBar ? "contrasted" : "luminous",
  }, window.location.origin);
}

function bankPreview(count, convoy = false) {
  if (count <= 0) return 0;
  const payload = 22 * count;
  const factor = convoy && count > 1 ? 1 + .5 * (count - 1) : 1;
  const total = Math.round(payload * factor);
  const steps = [
    { label: "PAYLOAD", multiplier: 1, before: 0, after: payload },
    { label: "YELLOW WORKER", multiplier: 1, before: payload, after: payload },
  ];
  if (factor > 1) steps.push({ label: count === 2 ? "TWIN DELIVERY" : "CONVOY", multiplier: factor, before: payload, after: total });
  previewOre += total;
  previewCashoutSeq += 1;
  previewLastCashout = { seq: previewCashoutSeq, workers: Array.from({ length: count }, (_, index) => index), side: count > 1 ? "both" : "left", payload, steps, total, ore: previewOre, label: deposits[previewDeposit].short, at: performance.now() / 1000 };
  return total;
}

function beginPreviewReward(now) {
  if (previewRewardUntil) return;
  const deposit = deposits[previewDeposit];
  city[previewDeposit % city.length] = {
    left: [...deposit.color],
    right: [...deposit.secondary],
    level: previewDeposit >= 3 ? 2 : 1,
    name: deposit.short,
  };
  previewProgress = 1;
  previewRewardUntil = now + 3000 / simTempo;
  previewRewardKind = previewCompletedVeins < 3 ? "recruit" : "city";
  previewRewardSeq += 1;
  actionCue = { seq: ++actionCueSeq, at: now, kind: previewRewardKind, label: previewCompletedVeins < 3 ? "NEW MINER" : "TWIN CITY UPGRADE" };
}

function ensurePreviewCompletion(now) {
  // Mirror the game engine's recovery path: an exact 100% state must always
  // enter its reward sequence, even after a burst of Signal Strike calls.
  if (!previewRewardUntil && previewProgress >= 1) beginPreviewReward(now);
}

function addPreviewProgress(amount, now) {
  if (previewRewardUntil) return;
  previewProgress = Math.max(0, Math.min(1, previewProgress + amount));
  ensurePreviewCompletion(now);
}

function finishPreviewReward(now) {
  if (!previewRewardUntil || now < previewRewardUntil) return;
  previewOre += Math.round(320 * (1 + previewDeposit * .22));
  previewCompletedVeins += 1;
  previewDeposit = (previewDeposit + 1) % deposits.length;
  previewProgress = 0;
  previewRewardUntil = 0;
  previewHeldWorkers.clear();
  convoyHeld = false;
  actionCue = { seq: ++actionCueSeq, at: now, kind: "travel", label: `NEW SIGNAL · ${deposits[previewDeposit].short}` };
}

function liveStatus() {
  const now = performance.now();
  ensurePreviewCompletion(now);
  finishPreviewReward(now);
  const deposit = deposits[previewDeposit];
  const rewardPending = previewRewardUntil > 0;
  const realElapsed = (now - previewStarted) / 1000;
  simulationSeconds += Math.max(0, Math.min(.25, (now - lastSimulationTick) / 1000)) * simTempo;
  lastSimulationTick = now;
  const elapsed = simulationSeconds;
  const journey = (elapsed % BASE_WORKER_CYCLE_SECONDS) / BASE_WORKER_CYCLE_SECONDS;
  const outbound = journey < .5;
  const smooth = (value) => .5 - .5 * Math.cos(Math.PI * Math.max(0, Math.min(1, value)));
  const local = journey < .46 ? smooth(journey / .46) : journey <= .54 ? 1 : smooth(1 - (journey - .54) / .46);
  const leftPosition = 3 + local * (deposit.center - 3);
  const rightPosition = 13 - local * (13 - deposit.center);
  const cycle = Math.floor(elapsed / BASE_WORKER_CYCLE_SECONDS);
  const impactSeq = Math.floor(elapsed / BASE_WORKER_CYCLE_SECONDS + .5);
  const workerCount = Math.min(4, 1 + previewCompletedVeins);
  if (convoyHeld && !outbound && local > .72) {
    for (let workerId = 0; workerId < workerCount; workerId += 1) previewHeldWorkers.add(workerId);
  }
  if (!convoyHeld) previewHeldWorkers.clear();
  if (lastCycle < 0) lastCycle = cycle;
  else if (cycle > lastCycle) {
    if (!convoyHeld) {
      const total = bankPreview(cycle - lastCycle);
      actionCue = { seq: ++actionCueSeq, at: performance.now(), kind: "cashout", label: `${deposit.short} · +${total}` };
    }
    lastCycle = cycle;
  }
  const workers = Array.from({ length: workerCount }, (_, id) => {
    const side = id % 2 === 0 ? "left" : "right";
    const held = previewHeldWorkers.has(id);
    const home = side === "left" ? 3 : 13;
    const position = held ? home : side === "left" ? leftPosition : rightPosition;
    return { id, side, rank: 0, position, home, target: deposit.center, outbound: outbound && !held, rank_name: "Apprentice", power: 1, loaded: !outbound || held, held, payload: 17, trips: cycle, boost: 1, impact_seq: impactSeq, impact_age: 0 };
  });
  const mineralOrder = [deposit.center, deposit.center - 1, deposit.center + 1, deposit.center - 2];
  const mineralCells = mineralOrder.slice(0, Math.max(1, Math.ceil((1 - previewProgress) * 4))).sort((a, b) => a - b);
  const opticalDeposits = [[[70,2,0],[112,8,0]],[[0,62,8],[0,106,18]],[[76,25,0],[118,43,0]],[[42,0,64],[72,0,108]],[[0,62,34],[0,103,59]],[[30,34,43],[70,76,90]]];
  const rawColors = Array.from({ length: 17 }, (_, index) => index === 0 ? (city[0]?.left ?? blue) : index === 16 ? (city[0]?.right ?? blue) : mineralCells.includes(index) ? (index === mineralCells[Math.floor(elapsed * 5.2) % mineralCells.length] ? deposit.light : deposit.color) : blue);
  workers.forEach((worker) => { rawColors[Math.max(0, Math.min(16, Math.round(worker.position)))] = worker.held ? [255, 174, 48] : yellow; });
  const colors = opticalBar ? Array.from({ length: 17 }, () => [0, 8, 38]) : rawColors;
  if (opticalBar) {
    const [oreBase, oreLight] = opticalDeposits[previewDeposit];
    mineralCells.forEach((index) => { colors[index] = index === mineralCells[Math.floor(elapsed * 8.4) % mineralCells.length] ? oreLight : oreBase; });
    [Math.min(...mineralCells) - 1, Math.max(...mineralCells) + 1].forEach((index) => { if (index > 3 && index < 13) colors[index] = [0,0,0]; });
    workers.forEach((worker) => { const index = Math.max(0, Math.min(16, Math.round(worker.position))); [index - 1, index + 1].forEach((near) => { if (near >= 0 && near < 17) colors[near] = [0,0,0]; }); colors[index] = worker.loaded && Math.floor(elapsed * 8 + worker.id * 1.7) % 4 === 0 ? oreLight : [108,24,0]; });
    colors[0] = [41,7,0]; colors[16] = [45,13,0];
  }
  const cueAge = actionCue ? performance.now() - actionCue.at : Infinity;
  const actionActive = cueAge < 2200;
  return {
    version: "0.1.0-demo", age: 0, age_name: "Foundation", rank_name: "Apprentice", rank_color: yellow,
    deposit: previewDeposit, deposit_name: deposit.name, deposit_short: deposit.short, deposit_color: deposit.color, deposit_light: deposit.light,
    deposit_icon: deposit.icon, deposit_pattern: deposit.pattern, deposit_story: deposit.story,
    progress: previewProgress, campaign_progress: (previewCompletedVeins + previewProgress) / 30, remaining_seconds: 111600, active_seconds: realElapsed, shift_seconds: elapsed,
    tempo: simTempo, tempo_name: ["CHILL", "NORMAL", "NERVOUS", "COCAINE"][simTempo - 1], campaign_estimate_hours: [63, 31.5, 21, 15.75][simTempo - 1], score_presentation_ms: [900, 650, 475, 320][simTempo - 1],
    ore: previewOre, city_value: previewOre, production_per_minute: 29, best_delivery: previewLastCashout.total, completed_veins: previewCompletedVeins,
    workers, worker_count: workerCount, city, paused: false, convoy_held: convoyHeld, pending_convoy: workers.filter((worker) => worker.held).length,
    upgrades: { crew: 0, logistics: 0, industry: 0 }, upgrade_costs: { crew: 240, logistics: 360, industry: 520 }, max_upgrade_level: 5,
    complete: false, finale_elapsed: 0, reward_pending: rewardPending, reward_remaining: rewardPending ? Math.max(0, (previewRewardUntil - now) / 1000) : 0,
    overcharge_remaining: Math.max(0, 30 - (performance.now() / 1000 - overchargeStarted)), overcharge_cooldown: Math.max(0, 480 - (performance.now() / 1000 - overchargeStarted)),
    cue_seq: actionActive ? actionCue.seq : actionCueSeq, cue_kind: actionActive ? actionCue.kind : "travel", cue_label: actionActive ? actionCue.label : `W1 → ${deposit.short}`, cue_active: actionActive,
    reward_seq: previewRewardSeq, reward_kind: previewRewardKind,
    cashout_seq: previewCashoutSeq, last_cashout: previewLastCashout, delivery_log: [{ seq: previewCashoutSeq, label: previewLastCashout.label, total: previewLastCashout.total, workers: previewLastCashout.workers.length }],
    total_strikes: previewStrikes, message: actionActive ? actionCue.label : convoyHeld ? "City gates closed. Returning miners will wait for a convoy." : `Follow the crew · strike at ${deposit.short}.`, colors, visible_cells: mineralCells, led_enabled: true,
    optical_bar: opticalBar, reverse_led_order: false, intro_seen: previewIntroSeen, hardware_available: false, hardware_owner: "free", hardware_error: "",
  };
}

const result = (name, args) => {
  if (name === "set_tempo") simTempo = Number(args[0]);
  if (name === "set_setting" && args[0] === "intro_seen") previewIntroSeen = Boolean(args[1]);
  if (name === "set_setting" && args[0] === "optical_bar") {
    opticalBar = Boolean(args[1]);
    publishLightProfile();
  }
  if (name === "reset_campaign") {
    previewIntroSeen = false;
    previewProgress = 0;
    previewDeposit = 0;
    previewCompletedVeins = 0;
    previewRewardSeq = 0;
    previewRewardKind = "";
    previewRewardUntil = 0;
    previewOre = 0;
    previewCashoutSeq = 0;
    previewLastCashout = emptyCashout();
    previewStrikes = 0;
    previewStrikeReadyAt = 0;
    previewStarted = performance.now();
    lastSimulationTick = previewStarted;
    simulationSeconds = 0;
    lastCycle = -1;
    overchargeStarted = -Infinity;
    actionCue = null;
    city.fill(null);
    convoyHeld = false;
    previewHeldWorkers.clear();
  }
  if (name === "toggle_convoy") {
    const releasing = convoyHeld;
    const waiting = previewHeldWorkers.size;
    convoyHeld = !convoyHeld;
    if (releasing && waiting) {
      const total = bankPreview(waiting, true);
      actionCue = { seq: ++actionCueSeq, at: performance.now(), kind: "cashout_big", label: `CONVOY BANK · +${total}` };
    } else actionCue = { seq: ++actionCueSeq, at: performance.now(), kind: convoyHeld ? "convoy_hold" : "convoy_release", label: convoyHeld ? "CITY GATES CLOSED · BUILD THE CONVOY" : "CONVOY RELEASED · NOTHING BANKED" };
  }
  if (name === "activate_overcharge" && performance.now() / 1000 - overchargeStarted >= 480) overchargeStarted = performance.now() / 1000;
  if (name === "strike") {
    const now = performance.now();
    const snapshot = liveStatus();
    if (snapshot.reward_pending) return { result: "unavailable", status: snapshot };
    if (now < previewStrikeReadyAt) return { result: "cooldown", status: snapshot };
    previewStrikeReadyAt = now + 320;
    const nearest = Math.min(...snapshot.workers.map((worker) => Math.abs(worker.position - worker.target)));
    const kind = nearest <= .72 ? "critical" : nearest <= 1.65 ? "strike" : "miss";
    const gain = kind === "critical" ? .018 : kind === "strike" ? .008 : .0025;
    const label = kind === "critical" ? "PERFECT SIGNAL · NEXT LOAD ×3" : kind === "strike" ? "SIGNAL LOCKED · NEXT LOAD ×1.5" : "DISTANT ECHO · SMALL GAIN";
    previewStrikes += 1;
    addPreviewProgress(gain, now);
    if (!previewRewardUntil) actionCue = { seq: ++actionCueSeq, at: now, kind, label };
    return { result: kind, status: liveStatus() };
  }
  const status = liveStatus();
  if (name === "activate_overcharge" || name === "buy_upgrade") return { activated: true, purchased: true, status };
  return status;
};

if (new URLSearchParams(window.location.search).has("diagnostics")) {
  window.__stripminePreviewDiagnostics = {
    setProgress(value) {
      previewProgress = Math.max(0, Math.min(1, Number(value)));
      previewRewardUntil = 0;
      previewStrikeReadyAt = 0;
    },
    status: liveStatus,
  };
}

window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit = {
  connect() {
    return {
      _version: 2,
      callable: (name) => (...args) => Promise.resolve(result(name, args)),
      routerHook: { addRoute(path, component) { if (path === "/stripmine/play") registeredGame = component; }, removeRoute() {} },
    };
  },
};

window.__STRIPMINE_PREVIEW_LOGO__ = new URL("../assets/stripmine-logo.png", window.location.href).href;

const pluginModule = await import("../dist/index.js?v=43");
const plugin = pluginModule.default();
if (!registeredGame) throw new Error("StripMine route was not registered");
previewRoot = createRoot(document.getElementById("root"));
previewRoot.render(location.hash === "#panel" ? plugin.content : React.createElement(registeredGame));

if (location.hash === "#panel" && window.parent !== window) {
  const publishPanelHeight = () => {
    const panel = document.querySelector(".sm-qam");
    if (!panel) return;
    window.parent.postMessage({
      type: "stripmine:decky-panel-size",
      height: Math.ceil(Math.max(panel.scrollHeight, panel.getBoundingClientRect().height)),
    }, window.location.origin);
  };
  requestAnimationFrame(() => {
    const panel = document.querySelector(".sm-qam");
    if (!panel) return;
    new ResizeObserver(publishPanelHeight).observe(panel);
    publishPanelHeight();
  });
}
