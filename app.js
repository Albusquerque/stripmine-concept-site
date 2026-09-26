const LED_COUNT = 17;
const logical = document.querySelector("#logical-strip");
const canvas = document.querySelector("#led-canvas");
const opticalLab = document.querySelector("#optical-lab");
const tvBezel = document.querySelector(".tv-bezel");
const tvScreen = document.querySelector(".tv-screen-scale");
const gameFrame = document.querySelector("#game-frame");
const deckyFrame = document.querySelector("#decky-frame");
const TV_VIEWPORT = { width: 1920, height: 1080 };
const LIGHT_PROFILE_MESSAGE = "stripmine:light-profile";

function fitTelevision() {
  const scale = Math.min(tvBezel.clientWidth / TV_VIEWPORT.width, tvBezel.clientHeight / TV_VIEWPORT.height);
  tvScreen.style.setProperty("--tv-scale", String(scale));
}

new ResizeObserver(fitTelevision).observe(tvBezel);
fitTelevision();

for (let index = 0; index < LED_COUNT; index += 1) {
  const cell = document.createElement("i");
  cell.className = "led";
  cell.dataset.index = String(index);
  cell.setAttribute("aria-hidden", "true");
  logical.append(cell);
}

const state = {
  view: "game",
  style: "luminous",
  tempo: 2,
  progress: 18,
  event: "mining",
  eventStarted: performance.now(),
};

const viewCopy = {
  game: {
    kicker: "01 · PRIMARY VIEW",
    title: "BUILD THE CITY. FEEL EVERY DELIVERY.",
    description: "The full 16:9 world carries the drama: workers cross the mine, buildings climb floor by floor and every score becomes architecture.",
  },
  decky: {
    kicker: "02 · COMPANION VIEW",
    title: "OPEN DECKY. THE SHIFT CONTINUES.",
    description: "The 4:3 Dot Matrix cycles through five legible story cards while tempo, audio, display profile and reset remain within reach.",
  },
  physical: {
    kicker: "03 · AMBIENT VIEW",
    title: "THE SMALLEST POSSIBLE GAME SCREEN.",
    description: "Cities anchor both ends. Orange workers move through blue terrain, enter the open cave and return carrying the mineral colour.",
  },
};

const palettes = {
  luminous: {
    void: [5, 95, 214],
    dark: [1, 35, 83],
    worker: [255, 208, 62],
    workerAccent: [255, 241, 164],
    vein: [21, 190, 101],
    veinLight: [119, 255, 183],
    west: [221, 59, 50],
    east: [247, 105, 39],
    finale: [232, 242, 255],
  },
  contrasted: {
    void: [0, 8, 38],
    dark: [0, 0, 0],
    worker: [108, 24, 0],
    workerAccent: [212, 54, 4],
    vein: [0, 62, 8],
    veinLight: [0, 106, 18],
    west: [41, 7, 0],
    east: [45, 13, 0],
    finale: [94, 116, 139],
  },
};

function broadcastLightProfile(source = null) {
  [gameFrame, deckyFrame].forEach((frame) => {
    if (!frame?.contentWindow || frame.contentWindow === source) return;
    frame.contentWindow.postMessage({ type: LIGHT_PROFILE_MESSAGE, style: state.style }, window.location.origin);
  });
}

function applyLightProfile(style, { broadcast = true, source = null, animate = true } = {}) {
  if (style !== "luminous" && style !== "contrasted") return;
  state.style = style;
  document.querySelectorAll(".style-button").forEach((node) => {
    const active = node.dataset.style === style;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-pressed", String(active));
  });
  document.querySelector("#style-note").textContent = style === "contrasted"
    ? "Dark gaps preserve orange workers when light spills between LEDs."
    : "Maximum colour and glow for a bright room or a less aggressive diffuser.";
  if (animate) flashLogical();
  if (broadcast) broadcastLightProfile(source);
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== LIGHT_PROFILE_MESSAGE) return;
  applyLightProfile(event.data.style, { source: event.source });
});

gameFrame.addEventListener("load", () => broadcastLightProfile());
deckyFrame.addEventListener("load", () => broadcastLightProfile());
window.addEventListener("load", () => broadcastLightProfile());

function setView(view) {
  state.view = view;
  document.querySelector(".page-shell").dataset.currentView = view;
  document.querySelectorAll("[data-preview]").forEach((node) => node.classList.toggle("is-active", node.dataset.preview === view));
  document.querySelectorAll(".view-tab").forEach((node) => node.classList.toggle("is-active", node.dataset.view === view));
  const copy = viewCopy[view];
  document.querySelector("#signal-kicker").textContent = copy.kicker;
  document.querySelector("#signal-title").textContent = copy.title;
  document.querySelector("#signal-description").textContent = copy.description;
  opticalLab.hidden = view !== "physical";
  if (view === "decky") {
    if (!deckyFrame.hasAttribute("src")) deckyFrame.src = deckyFrame.dataset.src;
    else broadcastLightProfile();
  }
}

document.querySelectorAll(".view-tab").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));

document.querySelectorAll(".style-button").forEach((button) => {
  button.addEventListener("click", () => applyLightProfile(button.dataset.style));
});

document.querySelectorAll("[data-tempo]").forEach((button) => {
  button.addEventListener("click", () => {
    state.tempo = Number(button.dataset.tempo);
    document.querySelectorAll("[data-tempo]").forEach((node) => node.classList.toggle("is-active", node === button));
    const names = ["CHILL", "NORMAL", "NERVOUS", "COCAINE"];
    document.querySelector("#stage-badge").textContent = `${names[state.tempo - 1]} · ×${state.tempo}`;
  });
});

const progressInput = document.querySelector("#progress-range");
progressInput.addEventListener("input", () => {
  state.progress = Number(progressInput.value);
  progressInput.style.setProperty("--fill", `${state.progress}%`);
  document.querySelector("#progress-output").textContent = `${state.progress}%`;
  updatePhysicalCopy();
});

document.querySelectorAll(".event-button").forEach((button) => {
  button.addEventListener("click", () => startEvent(button.dataset.event));
});

function startEvent(event) {
  state.event = event;
  state.eventStarted = performance.now();
  document.querySelectorAll(".event-button").forEach((node) => node.classList.toggle("is-active", node.dataset.event === event));
  const copy = {
    mining: ["AGE I · EXTRACTING", "SHUTTLE → STRIKE → RETURN", "Orange workers cross the open cave. The emerald vein shrinks as it is mined; loaded workers briefly inherit its green."],
    delivery: ["DELIVERY · CITY VALUE", "ORE → WEST + EAST", "Two green cargo pulses travel to the permanent city caps before the score lands on television and Decky."],
    promotion: ["CREW · PROMOTION", "YELLOW → ORANGE", "One worker changes rank with a short saturated pulse. The surrounding blue stays dark enough to protect the silhouette."],
    finale: ["THE LAST SHIFT", "DARK → BEACON → CITY", "The bar blacks out, the Ancient Core ignites at the centre, then a cool-white Beacon expands toward both cities."],
  }[event];
  document.querySelector("#stage-context").textContent = copy[0];
  document.querySelector("#signal-name").textContent = copy[1];
  document.querySelector("#strip-caption").textContent = copy[2];
  flashLogical();
}

function activeVeinCells() {
  if (state.progress >= 86) return [8];
  if (state.progress >= 62) return [8, 9];
  if (state.progress >= 35) return [7, 8, 9];
  return [7, 8, 9, 10];
}

function updatePhysicalCopy() {
  const count = activeVeinCells().length;
  document.querySelector("#route-label").textContent = `2 WORKERS · ${count}-CELL EMERALD`;
}

function workerPositions(time) {
  const period = 6.6 / state.tempo;
  const phase = (time / 1000 % period) / period;
  const outward = phase < .5;
  const local = outward ? phase * 2 : (phase - .5) * 2;
  const eased = .5 - Math.cos(local * Math.PI) / 2;
  return {
    outward,
    left: Math.round(outward ? 2 + eased * 4 : 6 - eased * 4),
    right: Math.round(outward ? 14 - eased * 3 : 11 + eased * 3),
  };
}

function miningFrame(time) {
  const palette = palettes[state.style];
  const cells = Array.from({ length: LED_COUNT }, () => [...palette.void]);
  const vein = activeVeinCells();
  const sparkle = vein[Math.floor(time / (state.style === "contrasted" ? 118 : 150)) % vein.length];
  cells[0] = palette.west;
  cells[16] = palette.east;
  vein.forEach((index) => { cells[index] = index === sparkle ? palette.veinLight : palette.vein; });
  const workers = workerPositions(time);

  if (state.style === "contrasted") {
    [Math.min(...vein) - 1, Math.max(...vein) + 1].forEach((index) => { if (index > 0 && index < 16) cells[index] = palette.dark; });
    [workers.left, workers.right].forEach((index) => {
      if (index - 1 > 0 && !vein.includes(index - 1)) cells[index - 1] = palette.dark;
      if (index + 1 < 16 && !vein.includes(index + 1)) cells[index + 1] = palette.dark;
    });
  }

  const loaded = !workers.outward;
  cells[workers.left] = loaded && Math.floor(time / 120) % 4 === 0 ? palette.veinLight : palette.worker;
  cells[workers.right] = loaded && Math.floor(time / 120 + 1) % 4 === 0 ? palette.veinLight : palette.worker;
  return { cells, workerCells: [workers.left, workers.right] };
}

function frameForEvent(time) {
  const palette = palettes[state.style];
  const elapsed = time - state.eventStarted;
  const base = miningFrame(time);
  if (state.event === "mining") return base;

  if (state.event === "delivery") {
    const phase = (elapsed % 2400) / 2400;
    const travel = Math.min(7, Math.floor(phase * 9));
    const left = Math.max(0, 7 - travel);
    const right = Math.min(16, 9 + travel);
    base.cells[left] = palette.veinLight;
    base.cells[right] = palette.veinLight;
    return { cells: base.cells, workerCells: [left, right] };
  }

  if (state.event === "promotion") {
    const phase = (elapsed % 3000) / 3000;
    const worker = phase < .5 ? 5 : 11;
    const radius = Math.floor((phase % .5) * 8);
    base.cells[worker] = phase > .45 ? [240, 101, 30] : palette.workerAccent;
    if (worker - radius >= 0) base.cells[worker - radius] = palette.workerAccent;
    if (worker + radius < LED_COUNT) base.cells[worker + radius] = palette.workerAccent;
    return { cells: base.cells, workerCells: [worker] };
  }

  const phase = (elapsed % 5000) / 5000;
  const cells = Array.from({ length: LED_COUNT }, () => [...palette.dark]);
  if (phase > .16) {
    const reach = Math.min(8, Math.floor((phase - .16) * 12));
    for (let offset = 0; offset <= reach; offset += 1) {
      const strength = 1 - offset / 11;
      const color = palette.finale.map((channel) => Math.round(channel * strength));
      cells[8 - offset] = color;
      cells[8 + offset] = color;
    }
    cells[8] = phase > .72 ? [255, 255, 244] : palette.finale;
  }
  if (phase > .8) { cells[0] = palette.west; cells[16] = palette.east; }
  return { cells, workerCells: [] };
}

function renderLogical(frame) {
  Array.from(logical.children).forEach((cell, index) => {
    const [r, g, b] = frame.cells[index];
    cell.style.setProperty("--r", r);
    cell.style.setProperty("--g", g);
    cell.style.setProperty("--b", b);
    cell.style.setProperty("--halo", state.style === "luminous" ? "8px" : "5px");
    cell.style.setProperty("--glow", state.style === "luminous" ? ".42" : ".5");
    cell.classList.toggle("is-worker", frame.workerCells.includes(index));
  });
}

function sizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  return { width, height };
}

function renderPhysical(frame) {
  if (state.view !== "physical") return;
  const { width, height } = sizeCanvas();
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  const cellWidth = width / LED_COUNT;
  const centreY = height * .48;
  const glowAlpha = state.style === "luminous" ? .42 : .34;
  const spread = state.style === "luminous" ? 1.32 : 1.18;

  context.globalCompositeOperation = "screen";
  frame.cells.forEach((color, index) => {
    const x = (index + .5) * cellWidth;
    const radius = cellWidth * spread;
    const gradient = context.createRadialGradient(x, centreY, 0, x, centreY, radius);
    const rgb = color.join(",");
    gradient.addColorStop(0, `rgba(${rgb},${glowAlpha})`);
    gradient.addColorStop(.4, `rgba(${rgb},${glowAlpha * .38})`);
    gradient.addColorStop(1, `rgba(${rgb},0)`);
    context.fillStyle = gradient;
    context.fillRect(x - radius, centreY - radius, radius * 2, radius * 2);
  });

  context.globalCompositeOperation = "source-over";
  const diffuser = context.createLinearGradient(0, 0, width, 0);
  frame.cells.forEach((color, index) => diffuser.addColorStop((index + .5) / LED_COUNT, `rgba(${color.join(",")},${state.style === "luminous" ? .91 : .84})`));
  context.fillStyle = diffuser;
  context.fillRect(0, centreY - height * .045, width, height * .09);
}

function flashLogical() {
  logical.querySelectorAll(".led").forEach((cell) => {
    cell.classList.remove("is-hit");
    void cell.offsetWidth;
    cell.classList.add("is-hit");
  });
}

let lastWorkerKey = "";
function render(time) {
  const frame = frameForEvent(time);
  renderLogical(frame);
  renderPhysical(frame);
  const workerKey = frame.workerCells.join("-");
  if (workerKey !== lastWorkerKey && state.event !== "finale") {
    frame.workerCells.forEach((index) => {
      logical.children[index]?.classList.add("is-hit");
      setTimeout(() => logical.children[index]?.classList.remove("is-hit"), 350);
    });
    lastWorkerKey = workerKey;
  }
  requestAnimationFrame(render);
}

progressInput.style.setProperty("--fill", `${state.progress}%`);
updatePhysicalCopy();
requestAnimationFrame(render);
