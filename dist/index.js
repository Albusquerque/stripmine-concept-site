const manifest = {"name":"StripMine"};
const API_VERSION = 2;
const internalAPIConnection = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit;
if (!internalAPIConnection) {
    throw new Error('[@decky/api]: Failed to connect to the loader as as the loader API was not initialized. This is likely a bug in Decky Loader.');
}
let api;
try {
    api = internalAPIConnection.connect(API_VERSION, manifest.name);
}
catch {
    api = internalAPIConnection.connect(1, manifest.name);
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version 1. Some features may not work.`);
}
if (api._version != API_VERSION) {
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version ${api._version}. Some features may not work.`);
}
const callable = api.callable;
const routerHook = api.routerHook;
const definePlugin = (fn) => {
    return (...args) => {
        return fn(...args);
    };
};

const getStatus = callable("get_status");
const strike = callable("strike");
const toggleConvoy = callable("toggle_convoy");
const setTempo = callable("set_tempo");
const buyUpgrade = callable("buy_upgrade");
const activateOvercharge = callable("activate_overcharge");
const setPaused = callable("set_paused");
const setSetting = callable("set_setting");
const retryLed = callable("retry_led");
const resetCampaign = callable("reset_campaign");

/** Original, procedural score: no samples, downloads or third-party recording. */
class StripMineAudio {
    context = null;
    master = null;
    music = null;
    sfx = null;
    reverb = null;
    delay = null;
    noise = null;
    timer = 0;
    step = 0;
    nextNote = 0;
    state = { age: 0, progress: 0, worker_count: 1, tempo: 2 };
    lastCue = -1;
    lastCashout = -1;
    lastReward = -1;
    workerImpacts = new Map();
    defaultUnlock = null;
    screenActive = false;
    musicEnabled = this.readEnabled("stripmine.musicEnabled", true);
    effectsEnabled = this.readEnabled("stripmine.effectsEnabled", true);
    musicVolume = this.readVolume("stripmine.musicVolume", 0.8);
    effectsVolume = this.readVolume("stripmine.effectsVolume", 0.65);
    readEnabled(key, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            return raw === null ? fallback : raw === "true";
        }
        catch {
            return fallback;
        }
    }
    writeEnabled(key, enabled) {
        try {
            window.localStorage.setItem(key, String(enabled));
        }
        catch { /* Decky storage may be unavailable during bootstrap. */ }
    }
    readVolume(key, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            if (raw === null)
                return fallback;
            const value = Number(raw);
            return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
        }
        catch {
            return fallback;
        }
    }
    ensure() {
        if (!this.screenActive)
            return null;
        if (this.context) {
            if (this.context.state === "suspended")
                void this.context.resume().catch(() => undefined);
            return this.context;
        }
        try {
            const context = new AudioContext();
            this.context = context;
            this.master = context.createGain();
            this.music = context.createGain();
            this.sfx = context.createGain();
            this.reverb = context.createConvolver();
            this.delay = context.createDelay(1);
            const compressor = context.createDynamicsCompressor();
            compressor.threshold.value = -20;
            compressor.knee.value = 14;
            compressor.ratio.value = 4;
            compressor.attack.value = 0.008;
            compressor.release.value = 0.28;
            this.master.gain.value = 0.50;
            this.music.gain.value = 0.65 * this.musicVolume;
            this.sfx.gain.value = (0.42 / 0.65) * this.effectsVolume;
            this.delay.delayTime.value = 0.27;
            const feedback = context.createGain();
            feedback.gain.value = 0.19;
            this.delay.connect(feedback);
            feedback.connect(this.delay);
            this.delay.connect(this.master);
            const impulse = context.createBuffer(2, Math.floor(context.sampleRate * 2.8), context.sampleRate);
            for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
                const data = impulse.getChannelData(channel);
                for (let i = 0; i < data.length; i += 1)
                    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.7);
            }
            this.reverb.buffer = impulse;
            const reverbLevel = context.createGain();
            reverbLevel.gain.value = 0.23;
            this.reverb.connect(reverbLevel).connect(this.master);
            this.noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
            const noiseData = this.noise.getChannelData(0);
            for (let i = 0; i < noiseData.length; i += 1)
                noiseData[i] = Math.random() * 2 - 1;
            this.music.connect(this.master);
            this.sfx.connect(this.master);
            this.master.connect(compressor).connect(context.destination);
            return context;
        }
        catch {
            return null;
        }
    }
    midi(note) { return 440 * Math.pow(2, (note - 69) / 12); }
    route(node, destination, reverb = true) {
        node.connect(destination);
        if (reverb && this.reverb)
            node.connect(this.reverb);
    }
    synthNote(note, start, duration, gain, options = {}) {
        const context = this.context;
        const destination = options.destination ?? this.music;
        if (!context || !destination || !Number.isFinite(note))
            return;
        const level = context.createGain();
        const filter = context.createBiquadFilter();
        const panner = context.createStereoPanner();
        filter.type = options.filterType ?? "lowpass";
        filter.frequency.setValueAtTime(options.cutoff ?? 2400, start);
        filter.Q.value = options.q ?? 0.7;
        level.gain.setValueAtTime(0.0001, start);
        level.gain.linearRampToValueAtTime(gain, start + (options.attack ?? 0.018));
        level.gain.setValueAtTime(gain * (options.sustain ?? 0.72), start + Math.max(0.03, duration * 0.36));
        level.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        panner.pan.value = options.pan ?? 0;
        filter.connect(panner).connect(level).connect(destination);
        if (options.reverb !== false && this.reverb)
            level.connect(this.reverb);
        if (options.echo && this.delay)
            level.connect(this.delay);
        const waves = options.waves ?? [[options.type ?? "triangle", 0, 1]];
        waves.forEach(([type, cents, volume]) => {
            const oscillator = context.createOscillator();
            const mix = context.createGain();
            oscillator.type = type;
            oscillator.frequency.setValueAtTime(this.midi(note), start);
            oscillator.detune.value = cents;
            if (options.glideTo)
                oscillator.frequency.exponentialRampToValueAtTime(this.midi(options.glideTo), start + duration);
            mix.gain.value = volume;
            oscillator.connect(mix).connect(filter);
            oscillator.start(start);
            oscillator.stop(start + duration + 0.06);
        });
    }
    noiseHit(start, duration, gain, cutoff, destination, pan = 0) {
        const context = this.context;
        if (!context || !this.noise || !destination)
            return;
        const source = context.createBufferSource();
        const filter = context.createBiquadFilter();
        const level = context.createGain();
        const panner = context.createStereoPanner();
        source.buffer = this.noise;
        filter.type = "bandpass";
        filter.frequency.value = cutoff;
        filter.Q.value = 0.8;
        level.gain.setValueAtTime(Math.max(0.0001, gain), start);
        level.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        panner.pan.value = pan;
        source.connect(filter).connect(panner).connect(level).connect(destination);
        source.start(start);
        source.stop(start + duration);
    }
    strings(note, start, duration, gain, pan = 0) {
        const context = this.context;
        if (!context || !this.music)
            return;
        const bus = context.createGain();
        const filter = context.createBiquadFilter();
        const panner = context.createStereoPanner();
        const vibrato = context.createOscillator();
        const vibratoDepth = context.createGain();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(900, start);
        filter.frequency.exponentialRampToValueAtTime(2500, start + Math.min(0.65, duration * 0.3));
        bus.gain.setValueAtTime(0.0001, start);
        bus.gain.linearRampToValueAtTime(gain, start + 0.36);
        bus.gain.setValueAtTime(gain * 0.8, start + duration * 0.68);
        bus.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        panner.pan.value = pan;
        filter.connect(panner).connect(bus);
        this.route(bus, this.music);
        vibrato.frequency.value = 5.1;
        vibratoDepth.gain.value = 7;
        vibrato.connect(vibratoDepth);
        [-13, -5, 5, 13].forEach((detune, index) => {
            const oscillator = context.createOscillator();
            const mix = context.createGain();
            oscillator.type = index % 2 ? "sawtooth" : "triangle";
            oscillator.frequency.value = this.midi(note);
            oscillator.detune.value = detune;
            mix.gain.value = index % 2 ? 0.17 : 0.31;
            vibratoDepth.connect(oscillator.detune);
            oscillator.connect(mix).connect(filter);
            oscillator.start(start);
            oscillator.stop(start + duration + 0.08);
        });
        vibrato.start(start);
        vibrato.stop(start + duration);
    }
    brass(note, start, duration, gain, pan = 0) {
        const context = this.context;
        if (!context || !this.music)
            return;
        const bus = context.createGain();
        const filter = context.createBiquadFilter();
        const panner = context.createStereoPanner();
        filter.type = "lowpass";
        filter.Q.value = 3.2;
        filter.frequency.setValueAtTime(430, start);
        filter.frequency.exponentialRampToValueAtTime(1850, start + 0.16);
        filter.frequency.exponentialRampToValueAtTime(920, start + duration);
        bus.gain.setValueAtTime(0.0001, start);
        bus.gain.linearRampToValueAtTime(gain, start + 0.075);
        bus.gain.setValueAtTime(gain * 0.8, start + duration * 0.58);
        bus.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        panner.pan.value = pan;
        filter.connect(panner).connect(bus);
        this.route(bus, this.music);
        [[-8, 0.48], [8, 0.48], [0, 0.11]].forEach(([detune, volume], index) => {
            const oscillator = context.createOscillator();
            const mix = context.createGain();
            oscillator.type = index === 2 ? "square" : "sawtooth";
            oscillator.frequency.value = this.midi(note);
            oscillator.detune.value = detune;
            mix.gain.value = volume;
            oscillator.connect(mix).connect(filter);
            oscillator.start(start);
            oscillator.stop(start + duration + 0.08);
        });
    }
    choir(note, start, duration, gain, pan = 0) {
        const context = this.context;
        if (!context || !this.music)
            return;
        const source = context.createOscillator();
        const overtone = context.createOscillator();
        const output = context.createGain();
        const panner = context.createStereoPanner();
        source.type = "sawtooth";
        overtone.type = "triangle";
        source.frequency.value = this.midi(note);
        overtone.frequency.value = this.midi(note) * 2;
        [620, 1220, 2700].forEach((frequency, index) => {
            const filter = context.createBiquadFilter();
            const level = context.createGain();
            filter.type = "bandpass";
            filter.frequency.value = frequency;
            filter.Q.value = 7;
            level.gain.value = [1, 0.48, 0.22][index];
            source.connect(filter);
            overtone.connect(filter);
            filter.connect(level).connect(output);
        });
        output.gain.setValueAtTime(0.0001, start);
        output.gain.linearRampToValueAtTime(gain, start + 0.7);
        output.gain.setValueAtTime(gain * 0.74, start + duration * 0.72);
        output.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        panner.pan.value = pan;
        output.connect(panner);
        this.route(panner, this.music);
        source.start(start);
        overtone.start(start);
        source.stop(start + duration + 0.1);
        overtone.stop(start + duration + 0.1);
    }
    pluck(note, start, gain, pan = 0) {
        const context = this.context;
        if (!context || !this.music)
            return;
        const period = Math.max(2, Math.round(context.sampleRate / this.midi(note)));
        const buffer = context.createBuffer(1, period, context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < period; i += 1)
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / period, 0.18);
        const source = context.createBufferSource();
        const filter = context.createBiquadFilter();
        const level = context.createGain();
        const panner = context.createStereoPanner();
        source.buffer = buffer;
        source.loop = true;
        filter.type = "lowpass";
        filter.frequency.value = 4200;
        panner.pan.value = pan;
        level.gain.setValueAtTime(gain, start);
        level.gain.exponentialRampToValueAtTime(0.0001, start + 1.8);
        source.connect(filter).connect(panner).connect(level);
        this.route(level, this.music);
        source.start(start);
        source.stop(start + 1.9);
    }
    celesta(note, start, gain, pan = 0) {
        const context = this.context;
        const music = this.music;
        if (!context || !music || !Number.isFinite(note))
            return;
        [1, 2.01, 3.98, 6.05].forEach((partial, index) => {
            const oscillator = context.createOscillator();
            const level = context.createGain();
            const panner = context.createStereoPanner();
            oscillator.type = "sine";
            oscillator.frequency.value = this.midi(note) * partial;
            level.gain.setValueAtTime(gain / [1, 2.2, 5, 8][index], start);
            level.gain.exponentialRampToValueAtTime(0.0001, start + [1.7, 1.2, 0.8, 0.55][index]);
            panner.pan.value = pan;
            oscillator.connect(level).connect(panner);
            this.route(panner, music);
            oscillator.start(start);
            oscillator.stop(start + 1.8);
        });
    }
    timpani(note, start, gain) {
        const context = this.context;
        if (!context || !this.music)
            return;
        const oscillator = context.createOscillator();
        const level = context.createGain();
        oscillator.frequency.setValueAtTime(this.midi(note) * 1.45, start);
        oscillator.frequency.exponentialRampToValueAtTime(this.midi(note), start + 0.12);
        level.gain.setValueAtTime(gain, start);
        level.gain.exponentialRampToValueAtTime(0.0001, start + 1.05);
        oscillator.connect(level);
        this.route(level, this.music);
        oscillator.start(start);
        oscillator.stop(start + 1.1);
        this.noiseHit(start, 0.13, gain * 0.28, 260, this.music);
    }
    cymbal(start, gain, long = false) {
        if (!this.music)
            return;
        this.noiseHit(start, long ? 2.8 : 0.13, gain, long ? 5900 : 8200, this.music);
    }
    finaleScore(start) {
        if (!this.context || !this.music)
            return;
        window.clearInterval(this.timer);
        this.timer = 0;
        const chords = [[38, 45, 50, 54], [41, 48, 53, 57], [43, 50, 55, 59], [45, 52, 57, 62], [50, 57, 62, 66]];
        [0, 1.65, 3.25].forEach((offset, index) => {
            this.timpani(26 + index * 2, start + offset, 0.09 + index * 0.025);
            this.noiseHit(start + offset, 1.25, 0.035 + index * 0.016, 5200, this.music);
        });
        chords.forEach((chord, chordIndex) => {
            const at = start + 4.8 + chordIndex * 3.45;
            chord.forEach((note, voice) => {
                this.strings(note, at, 5.8, 0.026 + chordIndex * 0.003, (voice - 1.5) * 0.3);
                if (voice > 0)
                    this.choir(note + 12, at + 0.35, 5.1, 0.011 + chordIndex * 0.0025, (voice - 2) * 0.34);
            });
            this.timpani(chord[0] - 12, at, 0.065 + chordIndex * 0.008);
            if (chordIndex >= 2)
                chord.slice(1).forEach((note, voice) => this.brass(note + 12, at + 0.12, 1.7, 0.023 + chordIndex * 0.004, (voice - 1) * 0.34));
        });
        const ostinato = [62, 66, 69, 74, 69, 78, 74, 81];
        for (let step = 0; step < 32; step += 1)
            this.pluck(ostinato[step % ostinato.length], start + 7.2 + step * 0.42, 0.027 + step * 0.0007, step % 2 ? 0.48 : -0.48);
        [50, 57, 62, 66, 69, 74, 78, 81].forEach((note, index) => this.brass(note, start + 20.1 + index * 0.095, 3.2, 0.038 + index * 0.004, (index - 3.5) * 0.15));
        this.noiseHit(start + 20.1, 5.8, 0.1, 6800, this.music);
        this.choir(74, start + 20.3, 7.2, 0.025, -0.25);
        this.choir(81, start + 20.3, 7.2, 0.022, 0.25);
    }
    schedule(step, start) {
        const tonic = [38, 38, 41, 43, 45][this.state.age];
        const scale = [0, 2, 3, 5, 7, 9, 10];
        const chords = [[0, 2, 4], [3, 5, 0], [5, 0, 2], [4, 6, 1]];
        const motif = [0, 2, 4, 2, 5, 4, 2, 1, 0, 2, 5, 4, 6, 5, 3, 2];
        const beat = step % 16;
        const bar = Math.floor(step / 16);
        const chord = chords[bar % chords.length];
        const intensity = Math.min(1, 0.18 + this.state.progress * 0.46 + this.state.worker_count * 0.065 + this.state.age * 0.08);
        if (beat === 0) {
            chord.forEach((degree, index) => this.strings(tonic + 12 + scale[degree], start, 3.7, 0.018 + intensity * 0.012, (index - 1) * 0.42));
            this.strings(tonic + scale[chord[0]], start, 3.7, 0.025 + intensity * 0.011, -0.08);
            if (this.state.age >= 1) {
                this.choir(tonic + 12 + scale[chord[0]], start, 3.6, 0.011 + this.state.age * 0.003, -0.28);
                this.choir(tonic + 12 + scale[chord[2]], start, 3.6, 0.009 + this.state.age * 0.0025, 0.28);
            }
            if (bar % 4 === 0)
                this.cymbal(start, 0.022 + intensity * 0.02, true);
        }
        if (beat % 4 === 0) {
            this.strings(tonic - 12 + scale[chord[0]], start, 0.7, 0.032 + intensity * 0.018, -0.12);
            this.timpani(tonic - 12 + scale[chord[0]], start, 0.035 + intensity * 0.04);
        }
        if (beat === 4 || beat === 12) {
            this.timpani(tonic - 17 + scale[chord[0]], start, 0.025 + intensity * 0.035);
            this.cymbal(start, 0.012 + intensity * 0.008);
        }
        if (intensity > 0.34 && beat % 2 === 0) {
            const degree = chord[(beat / 2) % chord.length];
            this.pluck(tonic + 24 + scale[degree], start, 0.026 + intensity * 0.02, beat % 4 ? 0.42 : -0.42);
        }
        if (intensity > 0.66 && beat % 2 === 1)
            this.cymbal(start, 0.006 + intensity * 0.006);
        if (beat % 4 === 2) {
            const motifDegree = motif[(bar * 4 + Math.floor(beat / 4)) % motif.length];
            this.celesta(tonic + 24 + scale[motifDegree], start, 0.018 + this.state.age * 0.004, Math.sin(step * 0.7) * 0.4);
        }
        if (this.state.age >= 2 && (beat === 0 || beat === 8))
            chord.forEach((degree, index) => this.brass(tonic + 12 + scale[degree], start + 0.03, 0.82, 0.012 + intensity * 0.009, (index - 1) * 0.28));
        if (this.state.age >= 3 && beat === 8)
            this.brass(tonic + 24 + scale[chord[1]], start, 1.55, 0.019 + intensity * 0.008, 0.15);
    }
    scheduler = () => {
        if (!this.musicEnabled || !this.context)
            return;
        const sixteenth = 60 / ([68, 82, 96, 112][this.state.tempo - 1] + this.state.age * 3) / 4;
        while (this.nextNote < this.context.currentTime + 0.18) {
            this.schedule(this.step, this.nextNote);
            this.nextNote += sixteenth;
            this.step = (this.step + 1) % 64;
        }
    };
    startMusicScheduler(context) {
        if (!this.musicEnabled || context !== this.context || context.state !== "running")
            return;
        window.clearInterval(this.timer);
        this.step = 0;
        this.nextNote = context.currentTime + 0.05;
        this.scheduler();
        this.timer = window.setInterval(this.scheduler, 45);
    }
    clearDefaultUnlock() {
        if (!this.defaultUnlock)
            return;
        window.removeEventListener("pointerdown", this.defaultUnlock, true);
        window.removeEventListener("keydown", this.defaultUnlock, true);
        this.defaultUnlock = null;
    }
    startDefaults() {
        if (!this.screenActive)
            return;
        const unlock = () => {
            if (this.musicEnabled)
                this.setMusic(true);
            else if (this.effectsEnabled)
                this.ensure();
            if (this.context?.state === "running")
                this.clearDefaultUnlock();
        };
        unlock();
        if (this.context?.state !== "running" && !this.defaultUnlock) {
            this.defaultUnlock = unlock;
            window.addEventListener("pointerdown", unlock, true);
            window.addEventListener("keydown", unlock, true);
        }
    }
    setMusic(enabled) {
        this.musicEnabled = enabled;
        this.writeEnabled("stripmine.musicEnabled", enabled);
        window.clearInterval(this.timer);
        this.timer = 0;
        if (!enabled || !this.screenActive)
            return true;
        const context = this.ensure();
        if (!context)
            return false;
        if (context.state === "running")
            this.startMusicScheduler(context);
        else
            void context.resume().then(() => this.startMusicScheduler(context)).catch(() => undefined);
        return true;
    }
    setEffects(enabled) {
        this.effectsEnabled = enabled;
        this.writeEnabled("stripmine.effectsEnabled", enabled);
        if (enabled && this.screenActive)
            this.ensure();
    }
    setScreenActive(active) {
        if (this.screenActive === active)
            return;
        this.screenActive = active;
        if (active) {
            this.startDefaults();
            return;
        }
        // Closing rather than merely suspending discards notes already scheduled
        // by the look-ahead sequencer. They must not leak into Steam or replay as
        // a stale burst when the player comes back later.
        this.stopOutput();
    }
    stopOutput() {
        this.clearDefaultUnlock();
        window.clearInterval(this.timer);
        this.timer = 0;
        const context = this.context;
        if (context && this.master) {
            // Silence synchronously. AudioContext.close() is asynchronous and some
            // WebKit/Chromium builds can otherwise emit a short tail while a new
            // full-screen instance is already starting.
            this.master.gain.cancelScheduledValues(context.currentTime);
            this.master.gain.setValueAtTime(0, context.currentTime);
        }
        this.context = null;
        this.master = null;
        this.music = null;
        this.sfx = null;
        this.reverb = null;
        this.delay = null;
        this.noise = null;
        void context?.close().catch(() => undefined);
    }
    setMusicVolume(value) {
        this.musicVolume = Math.max(0, Math.min(1, value));
        if (this.music)
            this.music.gain.value = 0.65 * this.musicVolume;
        try {
            window.localStorage.setItem("stripmine.musicVolume", String(this.musicVolume));
        }
        catch { /* Decky storage may be unavailable during bootstrap. */ }
    }
    setEffectsVolume(value) {
        this.effectsVolume = Math.max(0, Math.min(1, value));
        if (this.sfx)
            this.sfx.gain.value = (0.42 / 0.65) * this.effectsVolume;
        try {
            window.localStorage.setItem("stripmine.effectsVolume", String(this.effectsVolume));
        }
        catch { /* Decky storage may be unavailable during bootstrap. */ }
    }
    play(kind) {
        if (!this.screenActive)
            return;
        const finaleMusic = kind === "finale" && this.musicEnabled;
        if (!this.effectsEnabled && !finaleMusic)
            return;
        const context = this.ensure();
        if (!context || !this.sfx)
            return;
        const start = context.currentTime + 0.008;
        if (kind === "finale") {
            if (this.effectsEnabled)
                this.noiseHit(start, 2.1, 0.13, 2600, this.sfx);
            if (this.musicEnabled)
                this.finaleScore(start);
            return;
        }
        if (kind === "finale_armed") {
            this.timpani(26, start, 0.11);
            this.brass(38, start + 0.18, 2.6, 0.03);
            this.noiseHit(start, 1.4, 0.045, 900, this.sfx);
            return;
        }
        if (kind === "strike" || kind === "miss") {
            this.noiseHit(start, 0.11, kind === "strike" ? 0.24 : 0.12, 820, this.sfx);
            this.synthNote(41, start, 0.18, 0.16, { destination: this.sfx, waves: [["square", 0, 0.5], ["triangle", -1200, 0.8]], cutoff: 950, glideTo: 29, reverb: false });
            this.synthNote(88, start + 0.025, 0.32, 0.035, { destination: this.sfx, type: "sine", cutoff: 5000 });
            return;
        }
        if (kind === "critical") {
            this.noiseHit(start, 0.18, 0.3, 1350, this.sfx);
            [64, 71, 76, 83].forEach((note, index) => this.synthNote(note, start + index * 0.028, 0.72, 0.07, { destination: this.sfx, waves: [["triangle", 0, 1], ["sine", 1200, 0.25]], cutoff: 4600, echo: true, pan: (index - 1.5) * 0.2 }));
            return;
        }
        if (kind === "overcharge") {
            for (let index = 0; index < 9; index += 1)
                this.synthNote(38 + index * 2, start + index * 0.055, 0.38, 0.035, { destination: this.sfx, waves: [["sawtooth", -8, 0.45], ["sawtooth", 8, 0.45]], cutoff: 600 + index * 300, pan: -0.7 + index * 0.175 });
            this.synthNote(74, start + 0.46, 0.9, 0.07, { destination: this.sfx, type: "sine", cutoff: 5000, echo: true });
            return;
        }
        if (kind === "recall") {
            [79, 74, 69, 62].forEach((note, index) => this.synthNote(note, start + index * 0.075, 0.32, 0.055, { destination: this.sfx, type: "sine", cutoff: 3000, echo: true }));
            return;
        }
        if (kind === "tempo") {
            [50, 57, 62, 69].slice(0, this.state.tempo).forEach((note, index) => this.pluck(note, start + index * 0.055, 0.06, -0.4 + index * 0.25));
            return;
        }
        if (kind === "milestone" || kind === "cashout") {
            [62, 69, 74].forEach((note, index) => this.synthNote(note, start + index * 0.09, 0.62, 0.065, { destination: this.sfx, waves: [["triangle", 0, 1], ["sine", 1200, 0.23]], cutoff: 4200, echo: true, pan: (index - 1) * 0.24 }));
            return;
        }
        if (kind === "recruit" || kind === "rank") {
            [62, 66, 69, 74, 78].forEach((note, index) => this.synthNote(note, start + index * 0.075, 0.72, 0.058, { destination: this.sfx, type: "triangle", cutoff: 4500, echo: true, pan: (index - 2) * 0.2 }));
            return;
        }
        if (kind === "city") {
            [50, 57, 62].forEach((note, index) => this.synthNote(note, start + index * 0.045, 1.1, 0.085, { destination: this.sfx, waves: [["sawtooth", -7, 0.34], ["triangle", 7, 0.8]], cutoff: 1700 + index * 500 }));
            this.noiseHit(start, 0.22, 0.14, 520, this.sfx);
            return;
        }
        if (kind === "age") {
            [50, 57, 62, 66, 69, 74, 78, 81].forEach((note, index) => this.synthNote(note, start + index * 0.105, 1.3, 0.075, { destination: this.sfx, waves: [["sawtooth", -9, 0.28], ["triangle", 9, 0.78], ["sine", 1200, 0.13]], cutoff: 3800, echo: true, pan: Math.sin(index) * 0.5 }));
            return;
        }
        if (kind === "cashout_big" || kind === "upgrade" || kind === "reward") {
            this.noiseHit(start, 0.36, 0.18, 2200, this.sfx);
            [50, 57, 62, 65, 69, 74].forEach((note, index) => this.synthNote(note, start + index * 0.095, 1.05, 0.072, { destination: this.sfx, waves: [["sawtooth", -5, 0.34], ["triangle", 5, 0.8]], attack: 0.025, cutoff: 3200, echo: index > 2, pan: (index - 2.5) * 0.14 }));
        }
    }
    playWorkerImpact(worker, simultaneous) {
        if (!this.effectsEnabled)
            return;
        const context = this.ensure();
        if (!context || !this.sfx)
            return;
        // The canvas reaches the rock at 69% of its articulated swing. Both are
        // started from the same impact sequence, so the transient lands on the
        // visible pick head rather than on a later outbound/return poll.
        const contactDelay = (0.72 / this.state.tempo) * 0.69;
        const spread = worker.side === "left" ? -0.56 : 0.56;
        const lane = (worker.id % 4 < 2 ? -0.06 : 0.06) * (worker.side === "left" ? 1 : -1);
        const pan = Math.max(-0.8, Math.min(0.8, spread + lane));
        const start = context.currentTime + contactDelay + Math.min(0.018, simultaneous * 0.006);
        const weight = 0.16 + worker.rank * 0.018;
        this.noiseHit(start, 0.095, weight, 690 + worker.rank * 115, this.sfx, pan);
        this.synthNote(35 + worker.rank * 2 + (worker.id % 2), start, 0.16, 0.105, {
            destination: this.sfx, waves: [["square", 0, 0.34], ["triangle", -1200, 0.9]],
            cutoff: 760 + worker.rank * 130, glideTo: 27 + worker.rank, reverb: false, pan,
        });
        this.synthNote(82 + worker.id * 2, start + 0.018, 0.22, 0.024, {
            destination: this.sfx, type: "sine", cutoff: 4700, pan,
        });
    }
    onStatus(status) {
        this.state = status;
        if (this.lastCue < 0) {
            this.lastCue = status.cue_seq;
            this.lastCashout = status.cashout_seq;
            this.lastReward = status.reward_seq;
            this.workerImpacts = new Map(status.workers.map((worker) => [worker.id, worker.impact_seq]));
            return;
        }
        const impacts = status.workers.filter((worker) => {
            const previous = this.workerImpacts.get(worker.id);
            return previous !== undefined && worker.impact_seq > previous;
        });
        impacts.forEach((worker, index) => this.playWorkerImpact(worker, impacts.length > 1 ? index : 0));
        status.workers.forEach((worker) => this.workerImpacts.set(worker.id, worker.impact_seq));
        const rewardChanged = status.reward_seq > this.lastReward;
        const cashoutChanged = status.cashout_seq > this.lastCashout;
        if (rewardChanged)
            this.play(status.reward_kind || "reward");
        else if (cashoutChanged)
            this.play(status.last_cashout && status.last_cashout.workers.length > 1 ? "cashout_big" : "cashout");
        if (status.cue_seq > this.lastCue) {
            const sequencedElsewhere = status.cue_kind.startsWith("cashout") || ["recruit", "rank", "city", "finale_armed"].includes(status.cue_kind);
            if (!sequencedElsewhere)
                this.play(status.cue_kind);
            this.lastCue = status.cue_seq;
        }
        this.lastCashout = status.cashout_seq;
        this.lastReward = status.reward_seq;
    }
    dispose() {
        this.screenActive = false;
        this.stopOutput();
    }
}

const PAGES = ["SETTLEMENT", "CREW", "TWIN CITY", "DEPOSIT", "PROGRESSION"];
const RANKS$1 = ["#ffd13f", "#35e57d", "#ff8423", "#fa4697", "#f4f7ff"];
const MATRIX_COLS = 512;
const MATRIX_ROWS = 384;
const DESIGN_WIDTH = 256;
const OUTPUT_SCALE = 2;
const MATRIX_DOTS = MATRIX_COLS * MATRIX_ROWS;
const MATRIX_PAGE_MS = 6000;
function DotMatrix({ status }) {
    const canvasRef = SP_REACT.useRef(null);
    const artRef = SP_REACT.useRef(null);
    const statusRef = SP_REACT.useRef(status);
    statusRef.current = status;
    SP_REACT.useEffect(() => {
        const art = document.createElement("canvas");
        art.width = MATRIX_COLS;
        art.height = MATRIX_ROWS;
        artRef.current = art;
        let timer = 0;
        const draw = () => {
            const canvas = canvasRef.current;
            const s = statusRef.current;
            if (!canvas)
                return;
            const ctx = canvas.getContext("2d");
            const a = artRef.current?.getContext("2d", { willReadFrequently: true });
            if (!ctx || !a)
                return;
            const now = performance.now();
            const page = s.reward_pending || s.complete ? -1 : Math.floor(now / MATRIX_PAGE_MS) % PAGES.length;
            const colour = `rgb(${s.deposit_light.join(",")})`;
            const rank = `rgb(${s.rank_color.join(",")})`;
            a.setTransform(1, 0, 0, 1, 0, 0);
            a.clearRect(0, 0, MATRIX_COLS, MATRIX_ROWS);
            const scale = MATRIX_COLS / DESIGN_WIDTH;
            a.setTransform(scale, 0, 0, scale, 0, 0);
            a.textBaseline = "middle";
            a.textAlign = "center";
            a.lineCap = "round";
            a.lineJoin = "round";
            const text = (value, x, y, size, fill = "#fff4bd", weight = 800, max = 240) => { a.font = `${weight} ${size}px ui-monospace,monospace`; a.fillStyle = fill; a.fillText(value, x, y, max); };
            const panel = (x, y, width, height) => { a.strokeStyle = colour; a.lineWidth = 1.5; a.strokeRect(x, y, width, height); a.fillStyle = colour; a.fillRect(x, y, width, 2.5); };
            const skylineFloors = s.city.reduce((sum, plot) => sum + (plot?.level ?? 0) * 2, 0);
            if (s.last_cashout && s.cue_active && s.cue_kind.startsWith("cashout")) {
                panel(8, 8, 240, 176);
                text(s.last_cashout.label, 128, 25, 14, "#ffcf70", 900);
                text(`+${s.last_cashout.total.toLocaleString()}`, 128, 82, 43, "#fff7c7", 900);
                text(s.last_cashout.steps.slice(1).map((step) => `×${step.multiplier} ${step.label}`).join("  "), 128, 124, 10, colour, 900);
                text(`${s.last_cashout.payload} PAYLOAD`, 128, 151, 11, "#ffffff", 900);
                text(`CITY VALUE ${s.city_value.toLocaleString()}`, 128, 174, 10, "#70e2d6", 900);
            }
            else if (s.complete) {
                text("METROPOLIS COMPLETE", 128, 17, 14, "#ffdb83", 900);
                const heights = [66, 92, 124, 151, 124, 92, 66];
                heights.forEach((height, index) => { const x = 9 + index * 35; a.fillStyle = index === 3 ? "#f4f7ff" : RANKS$1[(index + 3) % RANKS$1.length]; a.fillRect(x, 174 - height, 27, height); a.fillStyle = "#fff6b8"; for (let y = 166 - height; y < 164; y += 13) {
                    a.fillRect(x + 5, y, 4, 6);
                    a.fillRect(x + 17, y, 4, 6);
                } });
                text("LIGHT", 128, 83, 38, "#ffffff", 900);
                text("30 VEINS · 4 MASTERS", 128, 184, 10, "#7de8dc", 900);
            }
            else if (s.reward_pending) {
                panel(8, 8, 240, 176);
                text(s.cue_kind === "finale_armed" ? "THE LAST SHIFT" : "VEIN CLEARED", 128, 29, 14, "#ffcf70", 900);
                text(s.cue_kind === "finale_armed" ? "PRESS A" : s.cue_label, 128, 91, s.cue_kind === "finale_armed" ? 41 : 27, "#fff1a8", 900);
                text(s.cue_kind === "finale_armed" ? "FOUR MINERS" : `${s.deposit_short} RECOVERED`, 128, 143, 12, "#70e2d6", 900);
                text(s.cue_kind === "finale_armed" ? "ONE FINAL STRIKE" : "TWIN CITY UPDATED", 128, 166, 10, "#ffffff", 900);
            }
            else if (page === 0) {
                text(`SETTLEMENT · ${s.tempo_name} ×${s.tempo}`, 128, 15, 12, "#ffcf76", 900);
                text("CITY VALUE", 128, 42, 15, colour, 900);
                text(s.city_value.toLocaleString(), 128, 83, 39, "#fff2a8", 900);
                text(`+${s.production_per_minute.toLocaleString()}/MIN · BEST +${s.best_delivery.toLocaleString()}`, 128, 119, 10, "#ffffff");
                a.fillStyle = "#31494f";
                a.fillRect(8, 176, 240, 4);
                s.city.forEach((plot, index) => { const height = 15 + (plot?.level ?? 0) * 4; [24 + index * 35, 232 - index * 35].forEach((x, side) => { a.fillStyle = plot ? (side ? `rgb(${plot.right.join(",")})` : `rgb(${plot.left.join(",")})`) : "#34484e"; a.fillRect(x - 11, 175 - height, 22, height); a.fillStyle = "#fff0a0"; for (let y = 169 - height; plot && y < 169; y += 10) {
                    a.fillRect(x - 6, y, 3, 4);
                    a.fillRect(x + 3, y, 3, 4);
                } }); });
                text(`ORE ${s.ore.toLocaleString()} · ${skylineFloors} FLOORS`, 128, 145, 10, "#70e2d6", 900);
            }
            else if (page === 1) {
                text(`CREW · ${s.worker_count}/4 ACTIVE`, 128, 14, 13, "#ffcf76", 900);
                s.workers.slice(0, 4).forEach((worker, index) => { const col = index % 2; const row = Math.floor(index / 2); const x = 67 + col * 122; const y = 58 + row * 67; panel(x - 48, y - 23, 96, 51); a.fillStyle = RANKS$1[worker.rank]; a.beginPath(); a.arc(x - 25, y - 5, 11, Math.PI, 0); a.lineTo(x - 12, y + 3); a.lineTo(x - 38, y + 3); a.fill(); a.fillRect(x - 41, y + 1, 32, 4); a.fillStyle = "#dca474"; a.fillRect(x - 33, y + 5, 16, 13); a.fillStyle = RANKS$1[worker.rank]; a.fillRect(x - 36, y + 18, 22, 8); text(`${worker.side === "left" ? "W" : "E"}${Math.floor(worker.id / 2) + 1}`, x + 17, y - 7, 11, "#fff", 900, 48); text(`×${worker.power}`, x + 17, y + 11, 10, RANKS$1[worker.rank], 900, 48); });
                text(`${s.pending_convoy ? `${s.pending_convoy} LOADED · ` : ""}${s.rank_name.toUpperCase()} ×${s.workers[0]?.power ?? 1}`, 128, 179, 10, "#8de9dc", 900);
            }
            else if (page === 2) {
                text("TWIN CITY · LIVE SKYLINE", 128, 15, 13, "#ffcf76", 900);
                a.fillStyle = "#31494f";
                a.fillRect(8, 169, 240, 4);
                s.city.forEach((plot, index) => { const height = 48 + (plot?.level ?? 0) * 9; [28 + index * 39, 228 - index * 39].forEach((x, side) => { a.strokeStyle = plot ? (side ? `rgb(${plot.right.join(",")})` : `rgb(${plot.left.join(",")})`) : "#3a5057"; a.lineWidth = 3; a.strokeRect(x - 15, 169 - height, 30, height); if (plot) {
                    a.fillStyle = "#fff0a0";
                    for (let y = 161 - height; y < 159; y += 12) {
                        a.fillRect(x - 9, y, 4, 6);
                        a.fillRect(x + 5, y, 4, 6);
                    }
                    text(`L${plot.level}`, x, 181, 8, a.strokeStyle, 900, 30);
                } }); });
                text(`${skylineFloors} FLOORS`, 128, 92, 19, "#ffffff", 900, 92);
                text(`NEXT LIFT · ${Math.round(s.progress * 100)}%`, 128, 117, 10, colour, 900);
            }
            else if (page === 3) {
                text("DEPOSIT PROFILE", 128, 14, 13, "#ffcf76", 900);
                panel(12, 34, 88, 128);
                a.fillStyle = colour;
                a.beginPath();
                a.moveTo(56, 43);
                a.lineTo(90, 77);
                a.lineTo(80, 148);
                a.lineTo(39, 155);
                a.lineTo(21, 81);
                a.closePath();
                a.fill();
                a.strokeStyle = "#fff";
                a.stroke();
                text(s.deposit_pattern, 177, 61, 22, colour, 900, 142);
                text(s.deposit_name.toUpperCase(), 177, 91, 13, "#fff1aa", 900, 142);
                text(`${Math.max(0, Math.round((1 - s.progress) * 100))}% ORE LEFT`, 177, 119, 12, "#fff", 900, 142);
                text(`${s.visible_cells.length}/4 MINERAL LEDS`, 177, 144, 10, "#70e2d6", 900, 142);
                text(s.deposit_story.toUpperCase(), 128, 180, 8, "#b8d0ce", 700);
            }
            else {
                text(`CAMPAIGN · AGE ${s.age + 1} OF 5`, 128, 15, 13, "#ffcf76", 900);
                text(`${Math.round(s.campaign_progress * 100)}%`, 128, 61, 42, "#fff2a8", 900);
                a.fillStyle = "#31484e";
                a.fillRect(21, 103, 214, 6);
                a.fillStyle = rank;
                a.fillRect(21, 103, 214 * s.campaign_progress, 6);
                [0, 1, 2, 3, 4].forEach((age) => { const x = 21 + age * 53.5; a.fillStyle = age <= s.age ? RANKS$1[age] : "#40555b"; a.beginPath(); a.arc(x, 106, age === s.age ? 8 : 5, 0, Math.PI * 2); a.fill(); text(String(age + 1), x, 128, 9, a.fillStyle, 900); });
                text(`${s.completed_veins}/30 VEINS · ${skylineFloors} FLOORS`, 128, 153, 10, "#b8d1cf", 900);
                text(`EST. ${s.campaign_estimate_hours}H · ${s.tempo_name}`, 128, 177, 10, "#70e2d6", 900);
            }
            a.setTransform(1, 0, 0, 1, 0, 0);
            const pixels = a.getImageData(0, 0, MATRIX_COLS, MATRIX_ROWS).data;
            const outputWidth = MATRIX_COLS * OUTPUT_SCALE;
            const outputHeight = MATRIX_ROWS * OUTPUT_SCALE;
            ctx.clearRect(0, 0, outputWidth, outputHeight);
            const bg = ctx.createRadialGradient(outputWidth / 2, outputHeight * .45, 0, outputWidth / 2, outputHeight * .45, outputWidth * .58);
            bg.addColorStop(0, "#17252a");
            bg.addColorStop(1, "#020507");
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, outputWidth, outputHeight);
            for (let row = 0; row < MATRIX_ROWS; row += 1)
                for (let col = 0; col < MATRIX_COLS; col += 1) {
                    const offset = (row * MATRIX_COLS + col) * 4;
                    const on = pixels[offset + 3] > 24;
                    const pulse = .94 + Math.sin(now * .0016 + col * .07) * .06;
                    ctx.fillStyle = on ? `rgba(${Math.min(255, pixels[offset] * 1.28 + 18)},${Math.min(255, pixels[offset + 1] * 1.28 + 18)},${Math.min(255, pixels[offset + 2] * 1.28 + 18)},${.98 * pulse})` : "rgba(118,76,38,.13)";
                    const size = on ? 1.58 : .44;
                    ctx.beginPath();
                    ctx.arc(col * OUTPUT_SCALE + 1, row * OUTPUT_SCALE + 1, size / 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            canvas.setAttribute("aria-label", `${page < 0 ? s.cue_label : PAGES[page]}. ${s.message}`);
        };
        draw();
        timer = window.setInterval(draw, 280);
        return () => window.clearInterval(timer);
    }, []);
    return SP_JSX.jsx("canvas", { ref: canvasRef, className: "sm-matrix", width: MATRIX_COLS * OUTPUT_SCALE, height: MATRIX_ROWS * OUTPUT_SCALE });
}

var stripMineLogoUrl = 'http://127.0.0.1:1337/plugins/StripMine/assets/stripmine-logo-216cf589.png';

const STRIPMINE_LOGO_URL = window.__STRIPMINE_PREVIEW_LOGO__ ?? stripMineLogoUrl;

function Button$1(props) { return SP_JSX.jsx(DFL.Button, { ...props }); }
const TEMPOS$1 = [
    { value: 1, name: "CHILL", estimate: "63 h" },
    { value: 2, name: "NORMAL", estimate: "31 h 30" },
    { value: 3, name: "NERVOUS", estimate: "21 h" },
    { value: 4, name: "COCAINE", estimate: "15 h 45" },
];
function Intro({ onComplete, tempo, onTempo }) {
    const [stage, setStage] = SP_REACT.useState(0);
    SP_REACT.useEffect(() => {
        const times = [1400, 2800, 4200, 5600, 9000];
        const timers = times.map((time, index) => window.setTimeout(() => setStage(index + 1), time));
        const finish = window.setTimeout(onComplete, 15000);
        return () => { timers.forEach(window.clearTimeout); window.clearTimeout(finish); };
    }, [onComplete]);
    return SP_JSX.jsxs("div", { className: `sm-intro sm-intro-${stage}`, children: [SP_JSX.jsx("div", { className: "sm-intro-grain" }), SP_JSX.jsxs("div", { className: "sm-intro-copy sm-copy-0", children: [SP_JSX.jsx("span", { children: "THE EARTH SPLIT OPEN" }), SP_JSX.jsx("strong", { children: "A VEIN OF LIGHT AWOKE." })] }), SP_JSX.jsxs("div", { className: "sm-intro-copy sm-copy-1", children: [SP_JSX.jsx("span", { children: "RICHES SURGED FROM THE DEEP" }), SP_JSX.jsx("strong", { children: "THE SEAM KEPT GROWING." })] }), SP_JSX.jsxs("div", { className: "sm-intro-copy sm-copy-2", children: [SP_JSX.jsx("span", { children: "MINERS TOILED, SHIFT AFTER SHIFT" }), SP_JSX.jsx("strong", { children: "AND RAISED A CITY." })] }), SP_JSX.jsxs("div", { className: "sm-intro-scene", "aria-label": "Three red lights spread to ten, then feed two rising cities", children: [SP_JSX.jsx("div", { className: "sm-intro-city west", children: Array.from({ length: 6 }, (_, index) => SP_JSX.jsx("b", {}, index)) }), SP_JSX.jsx("div", { className: "sm-intro-city east", children: Array.from({ length: 6 }, (_, index) => SP_JSX.jsx("b", {}, index)) }), SP_JSX.jsx("div", { className: "sm-intro-flow west", children: Array.from({ length: 4 }, (_, index) => SP_JSX.jsx("i", {}, index)) }), SP_JSX.jsx("div", { className: "sm-intro-flow east", children: Array.from({ length: 4 }, (_, index) => SP_JSX.jsx("i", {}, index)) }), SP_JSX.jsx("div", { className: "sm-intro-rail", children: Array.from({ length: 17 }, (_, index) => {
                            const growth = index >= 7 && index <= 9 ? "seed" : index === 6 || index === 10 ? "grow-1" : index === 5 || index === 11 ? "grow-2" : index >= 4 && index <= 13 ? "grow-3" : "";
                            return SP_JSX.jsx("i", { className: growth }, index);
                        }) })] }), SP_JSX.jsxs("div", { className: "sm-intro-title", children: [SP_JSX.jsx("span", { children: "A 17-LIGHT IDLE EPIC" }), SP_JSX.jsx("img", { className: "sm-intro-logo", src: STRIPMINE_LOGO_URL, alt: "StripMine" }), SP_JSX.jsx("p", { children: "Every journey leaves a light behind." }), SP_JSX.jsxs("div", { className: "sm-intro-tempo", children: [SP_JSX.jsx("b", { children: "SHIFT TEMPO" }), SP_JSX.jsx("div", { children: TEMPOS$1.map((option) => SP_JSX.jsxs(Button$1, { className: tempo === option.value ? "active" : "", onClick: () => onTempo(option.value), children: [option.name, " \u00D7", option.value, SP_JSX.jsx("small", { children: option.estimate })] }, option.value)) }), SP_JSX.jsx("em", { children: "Scoring presentation automatically adapts." })] }), SP_JSX.jsx(Button$1, { className: "sm-enter", onClick: onComplete, children: "Enter the mine" })] }), SP_JSX.jsx(Button$1, { className: "sm-skip", onClick: onComplete, children: "Skip intro" })] });
}

const RANKS = ["#ffd13f", "#35e57d", "#ff8423", "#fa4697", "#f4f7ff"];
const DEPOSIT_CENTERS = [10, 9, 11, 8, 10, 8];
const DEPOSIT_SECONDARY = [[255, 122, 44], [88, 217, 156], [239, 94, 55], [234, 87, 178], [255, 191, 63], [255, 79, 154]];
const rgb = (value, alpha = 1) => `rgba(${value[0]},${value[1]},${value[2]},${alpha})`;
const shade = (value, lift = 0, alpha = 1) => `rgba(${value.map((channel) => Math.max(0, Math.min(255, channel + lift))).join(",")},${alpha})`;
const hexRgb = (hex) => [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
const shadeHex = (hex, lift = 0, alpha = 1) => shade(hexRgb(hex), lift, alpha);
function building(ctx, x, base, index, plot, side, time) {
    const width = [104, 94, 116][index];
    const height = [188, 238, 211][index] + (plot ? Math.min(110, Math.max(1, plot.level) * 11) : 0);
    const colour = plot ? (side === "left" ? plot.left : plot.right) : null;
    const accent = colour ? rgb(colour) : "#745a39";
    const top = base - height;
    const mirrored = side === "right";
    const poly = (fill, points) => { ctx.fillStyle = fill; ctx.beginPath(); points.forEach(([px, py], point) => point ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath(); ctx.fill(); };
    ctx.save();
    if (!plot) {
        ctx.strokeStyle = "#6a4930";
        ctx.lineWidth = 6;
        ctx.strokeRect(x, top, width, height);
        ctx.strokeStyle = "#9a7046";
        ctx.lineWidth = 3;
        for (let y = top + 26; y < base; y += 37) {
            ctx.beginPath();
            ctx.moveTo(x - 7, y);
            ctx.lineTo(x + width + 7, y);
            ctx.stroke();
        }
        ctx.strokeStyle = "#4a3225";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x + 4, base - 3);
        ctx.lineTo(x + width - 4, top + 3);
        ctx.moveTo(x + width - 4, base - 3);
        ctx.lineTo(x + 4, top + 3);
        ctx.stroke();
        const ropeX = x + (mirrored ? 21 : width - 21);
        const sway = Math.sin(time * .0012 + x) * 3;
        ctx.strokeStyle = "rgba(188,155,98,.72)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ropeX, top - 24);
        ctx.quadraticCurveTo(ropeX + sway, (top + base) / 2, ropeX + sway * .4, base - 39);
        ctx.stroke();
        ctx.fillStyle = "#a77a3f";
        ctx.beginPath();
        ctx.arc(ropeX + sway * .4, base - 35, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#c29143";
        ctx.fillRect(x + 19, base - 46, width - 38, 22);
        ctx.fillStyle = "#3d2b21";
        ctx.fillRect(x + 24, base - 41, width - 48, 3);
        ctx.fillRect(x + 34, base - 34, width - 68, 3);
        ctx.restore();
        return;
    }
    ctx.globalAlpha = .34;
    ctx.fillStyle = "#020607";
    ctx.fillRect(x - 8, top + 14, 8, height - 14);
    ctx.fillRect(x + 8, base, width + 8, 7);
    ctx.globalAlpha = 1;
    if (index === 0) {
        ctx.fillStyle = "#5f3029";
        ctx.fillRect(x, top + 46, width, height - 46);
        for (let y = top + 52; y < base - 9; y += 14) {
            ctx.fillStyle = y % 28 ? "#8c4938" : "#744035";
            for (let xx = x + ((y / 14) % 2 ? 0 : 9); xx < x + width; xx += 20)
                ctx.fillRect(xx, y, 16, 9);
        }
        poly("#241c1c", [[x - 8, top + 51], [x + 18, top + 18], [x + 47, top + 51], [x + 74, top + 17], [x + width + 8, top + 51]]);
        poly(accent, [[x - 4, top + 47], [x + 18, top + 25], [x + 45, top + 47], [x + 74, top + 24], [x + width + 4, top + 47]]);
        const chimney = mirrored ? x + 10 : x + width - 27;
        ctx.fillStyle = "#231b1a";
        ctx.fillRect(chimney - 4, top - 24, 24, 71);
        ctx.fillStyle = "#8e583e";
        ctx.fillRect(chimney, top - 20, 16, 67);
        ctx.fillStyle = "#ca8253";
        ctx.fillRect(chimney - 4, top - 23, 24, 8);
        const furnace = ctx.createRadialGradient(x + width / 2, base - 31, 1, x + width / 2, base - 31, 34);
        furnace.addColorStop(0, "rgba(255,225,122,.95)");
        furnace.addColorStop(.4, "rgba(255,112,48,.72)");
        furnace.addColorStop(1, "transparent");
        ctx.fillStyle = furnace;
        ctx.fillRect(x + width / 2 - 38, base - 69, 76, 70);
        ctx.fillStyle = "#17191a";
        ctx.fillRect(x + width / 2 - 23, base - 54, 46, 54);
        ctx.fillStyle = "#ef8a3d";
        ctx.fillRect(x + width / 2 - 16, base - 42, 32, 35);
        ctx.fillStyle = "#ffe7a1";
        ctx.fillRect(x + width / 2 - 8, base - 35, 16, 24);
    }
    else if (index === 1) {
        ctx.fillStyle = "#d0b27c";
        ctx.fillRect(x, top + 38, width, height - 38);
        ctx.fillStyle = "#9d8059";
        for (let y = top + 46; y < base - 8; y += 16)
            ctx.fillRect(x + 4, y, width - 8, 2);
        poly("#241d20", [[x - 9, top + 45], [x + width / 2, top - 9], [x + width + 9, top + 45]]);
        poly(accent, [[x - 3, top + 39], [x + width / 2, top], [x + width + 3, top + 39]]);
        ctx.fillStyle = "#6a4930";
        ctx.fillRect(x, top + 38, width, 8);
        ctx.fillRect(x + 7, top + 38, 7, height - 38);
        ctx.fillRect(x + width - 14, top + 38, 7, height - 38);
        ctx.fillRect(x + width / 2 - 3, top + 43, 6, height - 43);
        for (let y = top + 76; y < base - 31; y += 51) {
            ctx.fillStyle = "#2a2522";
            ctx.fillRect(x - 8, y, width + 16, 9);
            ctx.fillStyle = "#a36d3e";
            ctx.fillRect(x - 5, y - 4, width + 10, 5);
            ctx.fillStyle = "#ead38f";
            for (let xx = x + 10; xx < x + width - 8; xx += 24) {
                ctx.fillRect(xx, y - 27, 14, 20);
                ctx.fillStyle = "#fff4be";
                ctx.fillRect(xx + 3, y - 24, 3, 14);
                ctx.fillStyle = "#ead38f";
            }
        }
        ctx.fillStyle = accent;
        ctx.fillRect(x + width - 25, top + 57, 18, 56);
        ctx.fillStyle = "#251c18";
        ctx.fillRect(x + width / 2 - 15, base - 42, 30, 42);
    }
    else {
        ctx.fillStyle = "#26383b";
        ctx.fillRect(x, top + 68, width, height - 68);
        for (let y = top + 77; y < base - 9; y += 18)
            for (let xx = x + 4 + ((y / 18) % 2 ? 0 : 12); xx < x + width - 5; xx += 25) {
                ctx.fillStyle = y % 36 ? "#40575a" : "#354c50";
                ctx.fillRect(xx, y, 20, 12);
                ctx.fillStyle = "#172427";
                ctx.fillRect(xx, y + 11, 20, 2);
            }
        ctx.fillStyle = "rgba(93,205,195,.35)";
        ctx.beginPath();
        ctx.arc(x + width / 2, top + 59, 48, Math.PI, 0);
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 6;
        ctx.stroke();
        for (let spoke = -2; spoke <= 2; spoke += 1) {
            ctx.strokeStyle = "rgba(210,255,244,.5)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + width / 2, top + 12);
            ctx.lineTo(x + width / 2 + spoke * 20, top + 61);
            ctx.stroke();
        }
        ctx.fillStyle = "#b88b3f";
        ctx.fillRect(x + width / 2 - 4, top - 15, 8, 31);
        ctx.fillRect(x + width / 2 - 23, top - 15, 46, 5);
        ctx.fillStyle = "#f0d778";
        ctx.fillRect(x + width / 2 - 2, top - 30, 4, 17);
        ctx.fillStyle = "#151d20";
        ctx.fillRect(x + width / 2 - 18, base - 45, 36, 45);
        ctx.fillStyle = accent;
        ctx.fillRect(x + width / 2 - 13, base - 38, 26, 31);
    }
    ctx.fillStyle = colour ? shade(colour, 28, .78) : "#fff0a0";
    for (let y = top + 63; y < base - 48; y += 39)
        for (let xx = x + 15; xx < x + width - 13; xx += 27) {
            ctx.fillRect(xx, y, 12, 15);
            ctx.fillStyle = "rgba(255,255,255,.62)";
            ctx.fillRect(xx + 2, y + 2, 2, 10);
            ctx.fillStyle = colour ? shade(colour, 28, .78) : "#fff0a0";
        }
    for (let tier = 1; tier <= Math.min(5, Math.ceil(plot.level / 2)); tier += 1) {
        const y = base - 48 - tier * 49;
        ctx.fillStyle = colour ? shade(colour, -38) : "#7b603f";
        ctx.fillRect(x - 5, y, width + 10, 6);
        ctx.fillStyle = colour ? shade(colour, 22, .92) : "#d2aa63";
        ctx.fillRect(x + 4, y + 1, width - 8, 2);
    }
    if (plot.level >= 3) {
        ctx.fillStyle = colour ? shade(colour, -20) : accent;
        ctx.fillRect(x + width * .28, top - 21, width * .44, 22);
    }
    if (plot.level >= 5) {
        ctx.fillStyle = colour ? shade(colour, 12) : accent;
        ctx.fillRect(x + width * .43, top - 45, width * .14, 26);
        ctx.fillStyle = "#bdece5";
        ctx.fillRect(x + width * .47, top - 40, width * .06, 11);
    }
    if (plot.level >= 7) {
        ctx.fillStyle = "#d7b75e";
        ctx.fillRect(x + width * .49 - 2, top - 73, 4, 30);
        ctx.fillRect(x + width * .39, top - 71, width * .22, 4);
    }
    if (plot.level >= 9) {
        const pulse = .55 + Math.sin(time * .004 + index) * .35;
        ctx.globalAlpha = pulse;
        ctx.fillStyle = "#fff3b5";
        ctx.fillRect(x + width * .5 - 5, top - 81, 11, 11);
        ctx.globalAlpha = 1;
    }
    ctx.restore();
}
function constructionLift(ctx, x, base, index, plot, side, progress, time) {
    const width = [104, 94, 116][index];
    const height = [188, 238, 211][index] + (plot ? Math.min(110, Math.max(1, plot.level) * 11) : 0);
    const currentTop = base - height;
    const floor = 36;
    const build = Math.max(3, floor * progress);
    const nextTop = currentTop - floor;
    ctx.save();
    ctx.globalAlpha = .82;
    ctx.strokeStyle = "#d5a957";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 7, nextTop, width + 14, floor);
    for (let yy = nextTop + 9; yy < currentTop; yy += 9) {
        ctx.beginPath();
        ctx.moveTo(x - 12, yy);
        ctx.lineTo(x + width + 12, yy);
        ctx.stroke();
    }
    ctx.fillStyle = "rgba(213,169,87,.22)";
    ctx.fillRect(x, currentTop - build, width, build);
    ctx.fillStyle = "#f0cb73";
    ctx.fillRect(x, currentTop - build, width, 3);
    const craneSide = side === "left" ? 1 : -1;
    const mastX = side === "left" ? x + width + 14 : x - 14;
    ctx.fillStyle = "#b17a3f";
    ctx.fillRect(mastX, nextTop - 35, 4, floor + 38);
    ctx.fillRect(mastX + Math.min(0, craneSide * -54), nextTop - 35, 58, 4);
    ctx.fillStyle = "#e9c76d";
    ctx.fillRect(mastX + craneSide * 31, nextTop - 34, 3, 19 + Math.sin(time * .002) * 3);
    ctx.font = "900 13px ui-monospace,monospace";
    ctx.textAlign = side === "left" ? "left" : "right";
    ctx.fillStyle = "#ffe8a6";
    ctx.fillText(`L${(plot?.level || 0) + 1} · ${Math.round(progress * 100)}%`, side === "left" ? x : x + width, nextTop - 8);
    ctx.restore();
}
const smooth = (value) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
function finaleSky(ctx, elapsed, time) {
    const open = smooth((elapsed - 15) / 7);
    if (open <= 0)
        return;
    const sky = ctx.createLinearGradient(0, 0, 0, 390);
    sky.addColorStop(0, `rgba(7,17,42,${open})`);
    sky.addColorStop(1, `rgba(19,54,67,${open * .72})`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 1920, 390 * open);
    for (let i = 0; i < 88; i += 1) {
        const x = (i * 337) % 1920;
        const y = 18 + (i * 173) % 315;
        const flicker = .38 + .42 * Math.sin(time * .0018 + i * 1.7);
        ctx.fillStyle = `rgba(232,250,255,${open * flicker})`;
        ctx.fillRect(x, y, i % 9 ? 2 : 4, i % 9 ? 2 : 4);
    }
}
function finaleBeacon(ctx, ground, elapsed, time, colour) {
    const rise = smooth((elapsed - 5) / 13);
    const fracture = smooth(elapsed / 5);
    const x = 960;
    if (elapsed < 10) {
        const size = 82 + Math.sin(time * .008) * 7;
        crystal(ctx, x, ground - 76, size, colour, [255, 255, 255], time * .001);
        ctx.strokeStyle = `rgba(4,10,13,${fracture})`;
        ctx.lineWidth = 7;
        for (let i = 0; i < 6; i += 1) {
            ctx.beginPath();
            ctx.moveTo(x, ground - 155);
            ctx.lineTo(x + Math.sin(i * 8.1) * 45, ground - 95 + i * 18);
            ctx.lineTo(x + Math.cos(i * 5.7) * 72, ground - 30);
            ctx.stroke();
        }
    }
    if (rise <= 0)
        return;
    const height = 370 * rise;
    const top = ground - height;
    ctx.save();
    ctx.shadowColor = "#e8ffff";
    ctx.shadowBlur = 34 * rise;
    const tower = ctx.createLinearGradient(x - 95, 0, x + 95, 0);
    tower.addColorStop(0, "#14272d");
    tower.addColorStop(.28, "#9dece1");
    tower.addColorStop(.5, "#f7ffff");
    tower.addColorStop(.72, "#9dece1");
    tower.addColorStop(1, "#14272d");
    ctx.fillStyle = tower;
    ctx.beginPath();
    ctx.moveTo(x - 92, ground);
    ctx.lineTo(x - 72, top + 82);
    ctx.lineTo(x - 28, top + 46);
    ctx.lineTo(x, top);
    ctx.lineTo(x + 28, top + 46);
    ctx.lineTo(x + 72, top + 82);
    ctx.lineTo(x + 92, ground);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,.72)";
    ctx.lineWidth = 4;
    ctx.stroke();
    const lit = smooth((elapsed - 10) / 9);
    for (let row = 0; row < 8; row += 1) {
        const y = ground - 42 - row * 35;
        if (y < top + 68 || row / 8 > lit)
            continue;
        ctx.fillStyle = row % 2 ? "#fff0a0" : "#76eadb";
        ctx.fillRect(x - 39, y, 21, 12);
        ctx.fillRect(x + 18, y, 21, 12);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - 35, y + 2, 5, 4);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x - 4, top - 56, 8, 57);
    ctx.fillRect(x - 30, top - 54, 60, 6);
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = 28;
    ctx.fillRect(x - 8, top - 70, 16, 16);
    ctx.shadowBlur = 0;
    const bridge = smooth((elapsed - 16) / 5);
    if (bridge > 0) {
        ctx.strokeStyle = "#d8c681";
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(x - 72, ground - 168);
        ctx.lineTo(x - 72 - 560 * bridge, ground - 168);
        ctx.moveTo(x + 72, ground - 168);
        ctx.lineTo(x + 72 + 560 * bridge, ground - 168);
        ctx.stroke();
        ctx.strokeStyle = "#65e3d1";
        ctx.lineWidth = 3;
        ctx.stroke();
    }
    ctx.restore();
    const fragments = Math.min(42, Math.floor(Math.max(0, elapsed - 3) * 5));
    for (let i = 0; i < fragments; i += 1) {
        const p = ((elapsed - 3) * .22 + i / fragments) % 1;
        const direction = i % 2 ? 1 : -1;
        const fx = x + direction * p * (360 + (i % 7) * 58);
        const fy = ground - 100 - Math.sin(p * Math.PI) * (170 + (i % 5) * 24);
        ctx.fillStyle = i % 3 ? "#dffff8" : "#ffe28a";
        ctx.fillRect(fx, fy, 4 + i % 5, 4 + i % 5);
    }
}
function crystal(ctx, x, y, size, colour, light, phase) {
    ctx.save();
    ctx.translate(x, y);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 4.2);
    glow.addColorStop(0, rgb(light, 0.34));
    glow.addColorStop(0.42, rgb(colour, 0.12));
    glow.addColorStop(1, rgb(colour, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(-size * 4.2, -size * 4.2, size * 8.4, size * 8.4);
    const shape = () => { ctx.beginPath(); ctx.moveTo(size * .06, -size); ctx.lineTo(size * .72, -size * .3); ctx.lineTo(size * .58, size * .74); ctx.lineTo(-size * .12, size); ctx.lineTo(-size * .74, size * .26); ctx.lineTo(-size * .54, -size * .65); ctx.closePath(); };
    ctx.shadowColor = rgb(light);
    ctx.shadowBlur = 20;
    shape();
    ctx.clip();
    const body = ctx.createLinearGradient(-size, size, size, -size);
    body.addColorStop(0, shade(colour, -48));
    body.addColorStop(.3, shade(colour, -12));
    body.addColorStop(.62, shade(colour, 24));
    body.addColorStop(1, shade(light, 8));
    ctx.fillStyle = body;
    ctx.fillRect(-size, -size, size * 2, size * 2);
    const facet = (fill, points) => { ctx.fillStyle = fill; ctx.beginPath(); points.forEach(([px, py], index) => index ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath(); ctx.fill(); };
    facet(shade(colour, -62, .72), [[-size * .74, size * .26], [-size * .1, -size * .05], [size * .06, -size], [-size * .54, -size * .65]]);
    facet(shade(light, 18, .42), [[size * .06, -size], [size * .72, -size * .3], [size * .1, size * .03], [-size * .1, -size * .05]]);
    facet("rgba(255,255,255,.18)", [[size * .72, -size * .3], [size * .58, size * .74], [size * .1, size * .03]]);
    facet(shade(colour, -22, .36), [[-size * .1, -size * .05], [size * .1, size * .03], [-size * .12, size], [-size * .74, size * .26]]);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,.55)";
    ctx.lineWidth = 1.5;
    [[size * .06, -size, -size * .1, -size * .05], [size * .72, -size * .3, size * .1, size * .03], [-size * .1, -size * .05, -size * .12, size], [size * .1, size * .03, size * .58, size * .74]].forEach(([x1, y1, x2, y2]) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); });
    for (let i = 0; i < 70; i += 1) {
        const px = -size * .72 + ((i * 37) % Math.max(1, Math.floor(size * 1.35)));
        const py = -size + ((i * 47) % Math.max(1, Math.floor(size * 1.9)));
        ctx.fillStyle = i % 8 ? "rgba(255,255,255,.10)" : "rgba(255,255,255,.44)";
        ctx.fillRect(px, py, i % 5 ? 1 : 2, 1);
    }
    const sweep = ((phase % 1) * 1.8 - 0.9) * size;
    ctx.globalCompositeOperation = "screen";
    const shine = ctx.createLinearGradient(sweep - 10, 0, sweep + 10, 0);
    shine.addColorStop(0, "transparent");
    shine.addColorStop(.5, "rgba(255,255,255,.72)");
    shine.addColorStop(1, "transparent");
    ctx.fillStyle = shine;
    ctx.fillRect(-size, -size, size * 2, size * 2);
    ctx.restore();
    ctx.save();
    ctx.translate(x, y);
    shape();
    ctx.strokeStyle = shade(light, 10, .92);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.68)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
}
function facetedCrystal(ctx, x, baseY, width, height, lean, colour, light, seed, shimmer) {
    const topX = x + lean;
    const left = x - width * .58;
    const right = x + width * .63;
    const shoulderY = baseY - height * .62;
    const shape = () => { ctx.beginPath(); ctx.moveTo(topX, baseY - height); ctx.lineTo(right, shoulderY); ctx.lineTo(x + width * .45, baseY - 8); ctx.lineTo(x - width * .16, baseY); ctx.lineTo(left, baseY - height * .22); ctx.lineTo(x - width * .43, baseY - height * .72); ctx.closePath(); };
    ctx.save();
    shape();
    ctx.clip();
    const body = ctx.createLinearGradient(left, baseY, right, baseY - height);
    body.addColorStop(0, shade(colour, -48));
    body.addColorStop(.28, shade(colour, -12));
    body.addColorStop(.58, shade(colour, 24));
    body.addColorStop(1, shade(light, 8));
    ctx.fillStyle = body;
    ctx.fillRect(left - 4, baseY - height - 4, width * 1.35, height + 8);
    const facet = (fill, points) => { ctx.fillStyle = fill; ctx.beginPath(); points.forEach(([px, py], index) => index ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath(); ctx.fill(); };
    facet(shade(colour, -62, .72), [[left, baseY - height * .22], [x - width * .09, baseY - height * .42], [topX, baseY - height], [x - width * .43, baseY - height * .72]]);
    facet(shade(light, 18, .42), [[topX, baseY - height], [right, shoulderY], [x + width * .1, baseY - height * .4], [x - width * .09, baseY - height * .42]]);
    facet("rgba(255,255,255,.18)", [[right, shoulderY], [x + width * .45, baseY - 8], [x + width * .1, baseY - height * .4]]);
    facet(shade(colour, -22, .36), [[x - width * .09, baseY - height * .42], [x + width * .1, baseY - height * .4], [x - width * .16, baseY], [left, baseY - height * .22]]);
    ctx.strokeStyle = "rgba(255,255,255,.48)";
    ctx.lineWidth = 2;
    [[topX, baseY - height, x - width * .09, baseY - height * .42], [right, shoulderY, x + width * .1, baseY - height * .4], [x - width * .09, baseY - height * .42, x - width * .16, baseY], [x + width * .1, baseY - height * .4, x + width * .45, baseY - 8]].forEach(([x1, y1, x2, y2]) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); });
    ctx.strokeStyle = "rgba(20,27,31,.48)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i += 1) {
        const yy = baseY - height * (.17 + ((i * 19 + seed * 7) % 71) / 100);
        const xx = left + ((i * 37 + seed * 13) % Math.max(1, Math.floor(width)));
        ctx.beginPath();
        ctx.moveTo(xx, yy);
        ctx.lineTo(xx + (i % 2 ? 12 : -10), yy + 9);
        ctx.lineTo(xx + (i % 3 ? 18 : -15), yy + 17);
        ctx.stroke();
    }
    for (let i = 0; i < 190; i += 1) {
        const px = left + ((i * 83 + seed * 29) % Math.max(1, Math.floor(width * 1.18)));
        const py = baseY - ((i * 47 + seed * 31) % Math.max(1, Math.floor(height)));
        ctx.fillStyle = i % 8 ? "rgba(255,255,255,.10)" : "rgba(255,255,255,.42)";
        ctx.fillRect(px, py, i % 5 ? 1 : 2, 1);
    }
    const sweep = ((shimmer * 115 + seed * 23) % (width * 2.5)) - width;
    ctx.globalCompositeOperation = "screen";
    const shine = ctx.createLinearGradient(x + sweep - 13, 0, x + sweep + 13, 0);
    shine.addColorStop(0, "transparent");
    shine.addColorStop(.5, "rgba(255,255,255,.66)");
    shine.addColorStop(1, "transparent");
    ctx.fillStyle = shine;
    ctx.fillRect(left, baseY - height, width * 1.25, height);
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
    shape();
    ctx.strokeStyle = shade(light, 10, .92);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.68)";
    ctx.lineWidth = 1;
    ctx.stroke();
}
function caveEntrance(ctx, x, ground, time, colour, light, foreground = false) {
    const outerLeft = x - 340;
    const outerRight = x + 340;
    const top = ground - 320;
    const mouthPoints = [
        [x - 276, ground], [x - 270, ground - 66], [x - 286, ground - 104], [x - 252, ground - 130],
        [x - 260, ground - 164], [x - 226, ground - 181], [x - 214, ground - 219], [x - 166, ground - 235],
        [x - 127, ground - 224], [x - 91, ground - 254], [x - 39, ground - 238], [x + 4, ground - 247],
        [x + 43, ground - 226], [x + 91, ground - 239], [x + 126, ground - 211], [x + 174, ground - 204],
        [x + 190, ground - 174], [x + 231, ground - 154], [x + 224, ground - 119], [x + 263, ground - 91],
        [x + 249, ground - 54], [x + 267, ground],
    ];
    const mouth = () => {
        ctx.beginPath();
        mouthPoints.forEach(([px, py], index) => index ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
        ctx.closePath();
    };
    if (!foreground) {
        ctx.save();
        const rock = ctx.createLinearGradient(outerLeft, top, outerRight, ground);
        rock.addColorStop(0, "#0d171b");
        rock.addColorStop(.37, "#304143");
        rock.addColorStop(.7, "#1c2c2f");
        rock.addColorStop(1, "#091216");
        ctx.fillStyle = rock;
        ctx.beginPath();
        ctx.moveTo(outerLeft, ground);
        ctx.lineTo(outerLeft + 8, ground - 95);
        ctx.lineTo(outerLeft + 42, ground - 132);
        ctx.lineTo(outerLeft + 31, ground - 193);
        ctx.lineTo(outerLeft + 88, ground - 224);
        ctx.lineTo(x - 192, top + 18);
        ctx.lineTo(x - 117, top - 5);
        ctx.lineTo(x - 52, top + 15);
        ctx.lineTo(x + 7, top - 12);
        ctx.lineTo(x + 83, top + 11);
        ctx.lineTo(x + 146, top - 1);
        ctx.lineTo(x + 225, top + 45);
        ctx.lineTo(outerRight - 31, ground - 192);
        ctx.lineTo(outerRight - 51, ground - 142);
        ctx.lineTo(outerRight - 7, ground - 89);
        ctx.lineTo(outerRight, ground);
        ctx.closePath();
        ctx.fill();
        const depth = ctx.createLinearGradient(x - 240, ground - 238, x + 226, ground);
        depth.addColorStop(0, "#101b1e");
        depth.addColorStop(.5, "#020709");
        depth.addColorStop(1, "#071114");
        ctx.fillStyle = depth;
        mouth();
        ctx.fill();
        ctx.save();
        mouth();
        ctx.clip();
        // Broken shelves, not concentric outlines: the tunnel is a natural excavation.
        ctx.fillStyle = "rgba(47,66,67,.74)";
        ctx.beginPath();
        ctx.moveTo(x - 286, ground - 172);
        ctx.lineTo(x - 207, ground - 218);
        ctx.lineTo(x - 127, ground - 205);
        ctx.lineTo(x - 82, ground - 171);
        ctx.lineTo(x - 151, ground - 184);
        ctx.lineTo(x - 223, ground - 145);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "rgba(36,53,55,.82)";
        ctx.beginPath();
        ctx.moveTo(x + 8, ground - 247);
        ctx.lineTo(x + 91, ground - 239);
        ctx.lineTo(x + 174, ground - 204);
        ctx.lineTo(x + 201, ground - 167);
        ctx.lineTo(x + 120, ground - 185);
        ctx.lineTo(x + 54, ground - 174);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "rgba(13,24,27,.92)";
        ctx.beginPath();
        ctx.moveTo(x - 260, ground - 120);
        ctx.lineTo(x - 175, ground - 151);
        ctx.lineTo(x - 108, ground - 128);
        ctx.lineTo(x - 38, ground - 143);
        ctx.lineTo(x + 29, ground - 122);
        ctx.lineTo(x + 118, ground - 139);
        ctx.lineTo(x + 224, ground - 109);
        ctx.lineTo(x + 267, ground);
        ctx.lineTo(x - 276, ground);
        ctx.closePath();
        ctx.fill();
        const vanishingX = x + 37;
        const horizon = ground - 83;
        const farTunnel = ctx.createRadialGradient(vanishingX, horizon - 12, 3, vanishingX, horizon - 12, 63);
        farTunnel.addColorStop(0, "rgba(93,130,126,.20)");
        farTunnel.addColorStop(.48, "rgba(24,45,46,.26)");
        farTunnel.addColorStop(1, "rgba(1,5,7,0)");
        ctx.fillStyle = farTunnel;
        ctx.fillRect(vanishingX - 76, horizon - 88, 152, 145);
        const leftOreGlow = ctx.createRadialGradient(x - 149, ground - 142, 2, x - 149, ground - 142, 88);
        leftOreGlow.addColorStop(0, rgb(light, .18 + Math.sin(time * .004) * .025));
        leftOreGlow.addColorStop(1, rgb(colour, 0));
        ctx.fillStyle = leftOreGlow;
        ctx.fillRect(x - 245, ground - 238, 192, 192);
        const rightOreGlow = ctx.createRadialGradient(x + 149, ground - 126, 2, x + 149, ground - 126, 76);
        rightOreGlow.addColorStop(0, rgb(colour, .14));
        rightOreGlow.addColorStop(1, rgb(colour, 0));
        ctx.fillStyle = rightOreGlow;
        ctx.fillRect(x + 69, ground - 206, 160, 160);
        // Rough mine floor, rails and sleepers converge off-centre into the working tunnel.
        ctx.fillStyle = "rgba(43,55,54,.44)";
        ctx.beginPath();
        ctx.moveTo(x - 249, ground);
        ctx.lineTo(vanishingX - 33, horizon);
        ctx.lineTo(vanishingX + 35, horizon);
        ctx.lineTo(x + 267, ground);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(171,193,185,.38)";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(x - 118, ground);
        ctx.lineTo(vanishingX - 18, horizon);
        ctx.moveTo(x + 104, ground);
        ctx.lineTo(vanishingX + 17, horizon);
        ctx.stroke();
        for (let tie = 0; tie < 8; tie += 1) {
            const p = tie / 8;
            const y = horizon + Math.pow(p, 1.62) * 84;
            const half = 18 + p * 96;
            ctx.strokeStyle = tie % 2 ? "rgba(111,83,51,.58)" : "rgba(185,137,70,.45)";
            ctx.lineWidth = 3 + p * 2;
            ctx.beginPath();
            ctx.moveTo(vanishingX - half, y);
            ctx.lineTo(vanishingX + half, y + (p > .55 ? 3 : 1));
            ctx.stroke();
        }
        // One crooked, distant timber frame sells a worked mine without turning it into architecture.
        ctx.strokeStyle = "rgba(118,83,48,.55)";
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(x - 61, ground - 74);
        ctx.lineTo(x - 68, ground - 159);
        ctx.moveTo(x + 120, ground - 72);
        ctx.lineTo(x + 112, ground - 151);
        ctx.moveTo(x - 69, ground - 157);
        ctx.lineTo(x + 113, ground - 149);
        ctx.stroke();
        ctx.strokeStyle = "rgba(198,145,71,.25)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 64, ground - 156);
        ctx.lineTo(x + 108, ground - 148);
        ctx.stroke();
        ctx.restore();
        // Fracture marks stop short of becoming a clean outline around the mouth.
        const fractures = [
            [-292, -229, -264, -214, -279, -194], [-224, -286, -201, -261, -214, -241], [-137, -301, -119, -277, -91, -269],
            [-42, -292, -17, -271, -28, -250], [78, -287, 92, -265, 123, -251], [177, -261, 158, -235, 189, -222],
            [256, -215, 229, -193, 247, -174], [-306, -139, -281, -127, -294, -104], [291, -144, 264, -127, 278, -104],
        ];
        ctx.strokeStyle = "rgba(114,146,143,.34)";
        ctx.lineWidth = 2;
        fractures.forEach(([ax, ay, bx, by, cx, cy]) => { ctx.beginPath(); ctx.moveTo(x + ax, ground + ay); ctx.lineTo(x + bx, ground + by); ctx.lineTo(x + cx, ground + cy); ctx.stroke(); });
        for (let i = 0; i < 30; i += 1) {
            const side = i % 3 ? -1 : 1;
            const px = x + side * (236 + (i * 41) % 91);
            const py = ground - 15 - ((i * 59) % 259);
            ctx.fillStyle = i % 6 ? "#314345" : rgb(colour, .28);
            ctx.fillRect(px, py, 7 + i % 18, 4 + i % 9);
        }
        ctx.restore();
        return;
    }
    ctx.save();
    // Asymmetric loose scree frames a broad, walkable opening.
    const rubble = [[-318, 0, 82, 38], [-263, -6, 58, 61], [-211, 2, 57, 27], [163, 3, 43, 25], [211, -9, 76, 48], [281, 1, 53, 31]];
    rubble.forEach(([dx, dy, width, height], index) => { ctx.fillStyle = index % 2 ? "#1a292c" : "#283a3c"; ctx.beginPath(); ctx.moveTo(x + dx, ground + dy); ctx.lineTo(x + dx + width * .18, ground + dy - height * .62); ctx.lineTo(x + dx + width * .47, ground + dy - height); ctx.lineTo(x + dx + width * .81, ground + dy - height * .53); ctx.lineTo(x + dx + width, ground + dy); ctx.closePath(); ctx.fill(); ctx.strokeStyle = "rgba(111,143,141,.28)"; ctx.lineWidth = 2; ctx.stroke(); });
    ctx.restore();
}
function convoyGate(ctx, x, ground, direction, time, pending) {
    const pulse = .62 + Math.sin(time * .012) * .18;
    ctx.save();
    ctx.fillStyle = "#071012";
    ctx.fillRect(x - 11, ground - 108, 22, 108);
    ctx.fillStyle = "#35474a";
    ctx.fillRect(x - 8, ground - 104, 16, 104);
    ctx.fillStyle = "#75908d";
    ctx.fillRect(x - 5, ground - 101, 4, 98);
    ctx.shadowColor = "#ffad35";
    ctx.shadowBlur = 24;
    ctx.fillStyle = `rgba(255,174,48,${pulse})`;
    ctx.beginPath();
    ctx.arc(x, ground - 116, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#0a1113";
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(x, ground - 82);
    ctx.lineTo(x + direction * 112, ground - 82);
    ctx.stroke();
    ctx.strokeStyle = "#d9a13b";
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.moveTo(x, ground - 82);
    ctx.lineTo(x + direction * 112, ground - 82);
    ctx.stroke();
    ctx.strokeStyle = "#1a2425";
    ctx.lineWidth = 6;
    for (let offset = 14; offset < 108; offset += 25) {
        ctx.beginPath();
        ctx.moveTo(x + direction * offset, ground - 88);
        ctx.lineTo(x + direction * (offset + 10), ground - 76);
        ctx.stroke();
    }
    ctx.fillStyle = "#091114";
    ctx.fillRect(x - 34, ground - 151, 68, 23);
    ctx.strokeStyle = "#b77e2e";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 34, ground - 151, 68, 23);
    ctx.fillStyle = "#ffd77a";
    ctx.font = "900 13px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`HOLD ${pending}/4`, x, ground - 135);
    ctx.restore();
}
function miner(ctx, worker, x, ground, time, strikeProgress, cargoColour, cargoLight) {
    const striking = strikeProgress !== null;
    const colour = RANKS[worker.rank];
    const skin = ["#dca474", "#b97852", "#efc093", "#8e573e", "#c98b62", "#f1c7a5"][worker.id % 6];
    const skinLight = ["#f0c39b", "#d79a70", "#ffd6aa", "#b97957", "#e6aa7d", "#ffe0bf"][worker.id % 6];
    const hair = ["#4b2c22", "#261f20", "#9a5c2f", "#37241f", "#c18a4f", "#19191c"][worker.id % 6];
    const coat = ["#28515b", "#51445f", "#415b3b", "#5c4635", "#314b68", "#5b3b4a"][worker.id % 6];
    const destination = worker.outbound ? worker.target : worker.home;
    const facing = Math.sign(destination - worker.position) || (worker.side === "left" ? 1 : -1);
    const phase = time * .011 + worker.id * 1.37;
    const gait = striking ? 0 : Math.sin(phase);
    const bob = striking ? 0 : Math.abs(gait) * 4;
    const legSwing = gait * 10;
    const part = (ox, oy, angle, width, height, fill, accent) => { ctx.save(); ctx.translate(ox, oy); ctx.rotate(angle); ctx.fillStyle = "#091012"; ctx.fillRect(-width / 2 - 2, -2, width + 4, height + 4); ctx.fillStyle = fill; ctx.fillRect(-width / 2, 0, width, height); if (accent) {
        ctx.fillStyle = accent;
        ctx.fillRect(-width / 2 + 2, 2, Math.max(2, width - 4), 3);
    } ctx.restore(); };
    const poly = (fill, points) => { ctx.fillStyle = fill; ctx.beginPath(); points.forEach(([px, py], index) => index ? ctx.lineTo(px, py) : ctx.moveTo(px, py)); ctx.closePath(); ctx.fill(); };
    const swing = strikeProgress ?? 0;
    const ease = (value) => value * value * (3 - 2 * value);
    const lerp = (from, to, amount) => from + (to - from) * amount;
    const walkingToolAngle = -0.52 + gait * .14;
    let toolAngle = striking ? -0.9 : walkingToolAngle;
    let impact = 0;
    if (striking) {
        if (swing < .48)
            toolAngle = lerp(-0.9, -1.38, ease(swing / .48));
        else if (swing < .69)
            toolAngle = lerp(-1.38, .62, Math.pow((swing - .48) / .21, 2.2));
        else if (swing < .78) {
            toolAngle = .62;
            impact = 1 - (swing - .69) / .09;
        }
        else
            toolAngle = lerp(.62, -0.9, ease((swing - .78) / .22));
    }
    const toolDirection = { x: Math.cos(toolAngle), y: Math.sin(toolAngle) };
    const rearGrip = { x: striking ? 23 : 22 + gait * 2, y: striking ? -63 : -62 + Math.abs(gait) };
    const frontGrip = { x: rearGrip.x + toolDirection.x * 19, y: rearGrip.y + toolDirection.y * 19 };
    const limbEnd = (origin, angle, length) => ({ x: origin.x - Math.sin(angle) * length, y: origin.y + Math.cos(angle) * length });
    const elbow = (shoulder, hand, bend) => {
        const dx = hand.x - shoulder.x;
        const dy = hand.y - shoulder.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const reach = Math.min(46, distance);
        const height = Math.sqrt(Math.max(0, 24 * 24 - (reach * reach) / 4));
        return { x: (shoulder.x + hand.x) / 2 - dy / distance * height * bend, y: (shoulder.y + hand.y) / 2 + dx / distance * height * bend };
    };
    const articulatedArm = (shoulder, hand, bend, fill) => {
        const joint = elbow(shoulder, hand, bend);
        ctx.save();
        ctx.lineCap = "square";
        ctx.lineJoin = "bevel";
        ctx.strokeStyle = "#081012";
        ctx.lineWidth = 14;
        ctx.beginPath();
        ctx.moveTo(shoulder.x, shoulder.y);
        ctx.lineTo(joint.x, joint.y);
        ctx.lineTo(hand.x, hand.y);
        ctx.stroke();
        ctx.strokeStyle = fill;
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.moveTo(shoulder.x, shoulder.y);
        ctx.lineTo(joint.x, joint.y);
        ctx.lineTo(hand.x, hand.y);
        ctx.stroke();
        ctx.fillStyle = skin;
        ctx.fillRect(hand.x - 5, hand.y - 5, 10, 10);
        ctx.restore();
    };
    const boot = (ankle, angle, fill, accent) => {
        ctx.save();
        ctx.translate(ankle.x, ankle.y);
        ctx.rotate(angle);
        poly("#080e10", [[-9, -5], [7, -5], [17, 0], [17, 8], [-11, 8], [-11, -1]]);
        poly(fill, [[-7, -3], [6, -3], [14, 1], [14, 5], [-8, 5], [-8, 0]]);
        ctx.fillStyle = accent;
        ctx.fillRect(-5, -2, 12, 2);
        ctx.restore();
    };
    ctx.save();
    ctx.translate(x, ground - bob);
    ctx.scale(facing, 1);
    ctx.globalAlpha = .3;
    ctx.fillStyle = "#020607";
    ctx.beginPath();
    ctx.ellipse(0, 2, 38 + Math.abs(gait) * 3, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    const rearLeg = legSwing * Math.PI / 180;
    const rearHip = { x: -8, y: -43 };
    const frontHip = { x: 10, y: -43 };
    part(rearHip.x, rearHip.y, rearLeg, 11, 36, "#283840", "#49606a");
    part(frontHip.x, frontHip.y, -rearLeg, 11, 36, "#324650", "#5d7580");
    const rearAnkle = limbEnd(rearHip, rearLeg, 36);
    const frontAnkle = limbEnd(frontHip, -rearLeg, 36);
    boot(rearAnkle, -rearLeg * .16, "#11191c", "#59656a");
    boot(frontAnkle, rearLeg * .16, "#11191c", "#667277");
    articulatedArm({ x: -18, y: -83 }, rearGrip, -0.68, shadeHex(coat, -20));
    ctx.fillStyle = "#081012";
    ctx.fillRect(-23, -91, 48, 53);
    ctx.fillStyle = coat;
    ctx.fillRect(-20, -88, 42, 47);
    poly(shadeHex(coat, 18), [[-20, -88], [2, -88], [-4, -41], [-20, -41]]);
    ctx.fillStyle = colour;
    ctx.fillRect(-18, -88, 38, 7);
    ctx.fillStyle = "#d7aa61";
    ctx.fillRect(-21, -52, 44, 7);
    ctx.fillStyle = "#614228";
    ctx.fillRect(-13, -50, 8, 10);
    ctx.fillRect(10, -50, 9, 12);
    ctx.fillStyle = "#ead59b";
    ctx.fillRect(-10, -49, 3, 4);
    ctx.fillStyle = "#19262b";
    ctx.fillRect(-30, -86, 11, 35);
    ctx.fillStyle = "#5d4832";
    ctx.fillRect(-28, -82, 7, 25);
    ctx.fillStyle = "#d9c187";
    ctx.fillRect(-26, -78, 3, 8);
    articulatedArm({ x: 19, y: -83 }, frontGrip, .72, shadeHex(coat, 8));
    ctx.fillStyle = "#071012";
    ctx.fillRect(-15, -122, 36, 36);
    ctx.fillStyle = hair;
    ctx.fillRect(-14, -121, 33, 12);
    ctx.fillRect(-14, -113, worker.id % 2 ? 7 : 5, 18);
    ctx.fillStyle = skin;
    ctx.fillRect(-9, -116, 29, 27);
    ctx.fillStyle = skinLight;
    ctx.fillRect(9, -113, 11, 14);
    ctx.fillStyle = hair;
    if (worker.id % 3 === 0) {
        ctx.fillRect(-4, -96, 25, 8);
        ctx.fillRect(13, -104, 9, 12);
    }
    else if (worker.id % 3 === 1)
        ctx.fillRect(-7, -94, 15, 5);
    else
        ctx.fillRect(14, -100, 8, 8);
    ctx.fillStyle = "#17191b";
    ctx.fillRect(11, -109, 4, 4);
    ctx.fillStyle = "#fff7d2";
    ctx.fillRect(12, -109, 2, 1);
    ctx.fillStyle = skinLight;
    ctx.fillRect(20, -106, 5, 7);
    ctx.fillStyle = "#8d5140";
    ctx.fillRect(10, -95, 9, 2);
    ctx.fillStyle = "#081011";
    ctx.fillRect(-22, -136, 51, 19);
    ctx.fillStyle = colour;
    ctx.fillRect(-18, -134, 42, 15);
    ctx.fillRect(-11, -143, 29, 10);
    ctx.fillStyle = shadeHex(colour, 36);
    ctx.fillRect(-9, -141, 22, 4);
    ctx.fillStyle = "#10191b";
    ctx.fillRect(-24, -121, 55, 6);
    ctx.fillStyle = colour;
    ctx.fillRect(-21, -123, 49, 5);
    ctx.fillStyle = "#f8eaa9";
    ctx.fillRect(22, -132, 9, 9);
    ctx.fillStyle = "#fff";
    ctx.fillRect(25, -130, 4, 3);
    const lampGlow = ctx.createRadialGradient(29, -128, 1, 29, -128, 43);
    lampGlow.addColorStop(0, shadeHex(colour, 35, .56));
    lampGlow.addColorStop(1, "transparent");
    ctx.fillStyle = lampGlow;
    ctx.fillRect(-14, -171, 86, 86);
    ctx.globalAlpha = .12;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(30, -129);
    ctx.lineTo(132, -162);
    ctx.lineTo(132, -91);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    if (worker.loaded && !striking) {
        const ore = rgb(cargoColour);
        const oreLight = rgb(cargoLight);
        ctx.save();
        ctx.shadowColor = oreLight;
        ctx.shadowBlur = worker.boost >= 3 ? 30 : worker.held ? 23 : 15;
        poly("#071012", [[-33, -78], [-55, -64], [-53, -24], [-43, -15], [-21, -20], [-19, -69]]);
        poly(ore, [[-35, -74], [-51, -61], [-49, -27], [-41, -20], [-25, -24], [-23, -66]]);
        poly(shadeHex(ore, -34), [[-51, -61], [-40, -53], [-41, -20], [-49, -27]]);
        poly(oreLight, [[-40, -69], [-28, -62], [-31, -42], [-40, -53]]);
        poly(shadeHex(oreLight, 24), [[-45, -72], [-40, -86], [-34, -72], [-28, -90], [-24, -66]]);
        ctx.fillStyle = worker.held ? "#ffe18b" : "#d7aa61";
        ctx.fillRect(-52, -58, 30, 4);
        ctx.fillRect(-44, -72, 4, 52);
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(255,255,255,.72)";
        ctx.fillRect(-35, -68, 7, 3);
        ctx.restore();
    }
    if (worker.rank >= 1) {
        ctx.fillStyle = colour;
        ctx.fillRect(-35, -88, 7, 40);
        ctx.fillStyle = "#eafff7";
        ctx.fillRect(-33, -80, 3, 12);
    }
    if (worker.rank >= 2) {
        ctx.fillStyle = shadeHex(colour, 26);
        ctx.fillRect(-25, -91, 13, 7);
        ctx.fillRect(14, -91, 13, 7);
    }
    if (worker.rank >= 3) {
        ctx.fillStyle = "#d9fbff";
        ctx.fillRect(5, -113, 15, 2);
        ctx.fillRect(8, -117, 2, 10);
    }
    if (worker.rank >= 4) {
        ctx.strokeStyle = "rgba(255,255,255,.75)";
        ctx.lineWidth = 2;
        ctx.strokeRect(-24, -145, 57, 25);
    }
    {
        const head = { x: rearGrip.x + toolDirection.x * 73, y: rearGrip.y + toolDirection.y * 73 };
        ctx.save();
        ctx.translate(head.x, head.y);
        ctx.rotate(toolAngle + Math.PI / 2);
        // Human-scale tool: shoulder-width head, with the long point on the striking side.
        ctx.scale(.72, .72);
        poly("#071012", [[-7, -3], [7, -3], [7, 87], [4, 94], [1, 98], [-3, 98], [-7, 88]]);
        poly("#5d3b26", [[-4, 0], [4, 0], [4, 85], [2, 92], [-2, 94], [-4, 86]]);
        poly("#815133", [[-2, 3], [0, 3], [0, 84], [-2, 89]]);
        poly("#a66b3a", [[1, 3], [3, 3], [3, 62], [1, 69]]);
        poly("#071012", [[-7, -12], [-13, -10], [-19, -6], [-24, 0], [-25, 7], [-20, 12], [-17, 7], [-12, 4], [-7, 3]]);
        poly("#819698", [[-7, -9], [-12, -7], [-17, -3], [-21, 2], [-22, 5], [-20, 8], [-16, 4], [-11, 1], [-7, 1]]);
        poly("#c9d9d7", [[-8, -8], [-12, -6], [-16, -3], [-19, 1], [-16, 0], [-11, -3], [-8, -4]]);
        poly("#071012", [[5, -14], [15, -13], [25, -9], [35, -3], [43, 6], [43, 11], [38, 15], [32, 11], [24, 7], [15, 4], [7, 3]]);
        poly("#819698", [[7, -11], [16, -10], [25, -7], [34, -2], [40, 6], [40, 10], [37, 12], [32, 8], [24, 4], [15, 1], [7, 1]]);
        poly("#c9d9d7", [[7, -10], [15, -9], [24, -6], [33, -1], [39, 6], [37, 7], [31, 4], [23, 1], [15, -2], [7, -3]]);
        poly("#f4ffff", [[9, -8], [16, -7], [23, -4], [30, 0], [26, -1], [18, -4], [10, -5]]);
        poly("#071012", [[-10, -15], [10, -15], [12, -10], [11, 11], [7, 15], [-8, 15], [-11, 10], [-12, -10]]);
        poly("#819698", [[-7, -12], [7, -12], [9, -8], [8, 9], [5, 12], [-5, 12], [-8, 8], [-9, -8]]);
        poly("#c9d9d7", [[-5, -11], [2, -11], [2, 10], [-4, 10], [-6, 7], [-6, -8]]);
        ctx.fillStyle = "#f4ffff";
        ctx.fillRect(-4, -10, 3, 15);
        ctx.restore();
        if (striking && impact > 0) {
            ctx.globalAlpha = impact * .62;
            ctx.fillStyle = rgb(cargoLight);
            for (let chip = 0; chip < 5; chip += 1) {
                const spread = 18 + chip * 9;
                ctx.fillRect(head.x + 5 + chip * 4, Math.min(-2, head.y) - spread * impact, 5 + chip % 2 * 3, 4);
            }
            ctx.globalAlpha = 1;
        }
    }
    const dust = striking ? impact : Math.abs(gait);
    ctx.globalAlpha = dust * .3;
    ctx.fillStyle = "#a0aaa1";
    ctx.fillRect(-facing * 26, -3, 13, 3);
    ctx.fillRect(-facing * 39, -10 - dust * 8, 7, 4);
    ctx.fillRect(-facing * 51, -18 - dust * 12, 3, 3);
    ctx.globalAlpha = 1;
    ctx.restore();
}
function World({ status }) {
    const canvasRef = SP_REACT.useRef(null);
    const statusRef = SP_REACT.useRef(status);
    statusRef.current = status;
    const celebrationRef = SP_REACT.useRef({ seq: status.cue_seq, start: performance.now() });
    const impactRef = SP_REACT.useRef(new Map());
    const finaleRef = SP_REACT.useRef({ active: false, start: 0, base: 0 });
    SP_REACT.useEffect(() => {
        let animation = 0;
        const draw = (time) => {
            const canvas = canvasRef.current;
            if (!canvas)
                return;
            const ctx = canvas.getContext("2d");
            if (!ctx)
                return;
            const s = statusRef.current;
            const finaleArmed = s.reward_pending && s.cue_kind === "finale_armed";
            if (s.complete && !finaleRef.current.active)
                finaleRef.current = { active: true, start: time, base: s.finale_elapsed };
            if (!s.complete)
                finaleRef.current.active = false;
            const finaleElapsed = s.complete ? Math.min(30, finaleRef.current.base + (time - finaleRef.current.start) / 1000) : finaleArmed ? Math.max(0, 5 - s.reward_remaining) : -1;
            if (celebrationRef.current.seq !== s.cue_seq)
                celebrationRef.current = { seq: s.cue_seq, start: time };
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, 1920, 720);
            // This is the exact 640×240 base composition from deep17, enlarged on a strict 3× grid.
            ctx.save();
            ctx.setTransform(3, 0, 0, 3, 0, 0);
            const sky = ctx.createLinearGradient(0, 0, 0, 240);
            sky.addColorStop(0, "#050b10");
            sky.addColorStop(.52, "#10272b");
            sky.addColorStop(1, "#061015");
            ctx.fillStyle = sky;
            ctx.fillRect(0, 0, 640, 240);
            const center = DEPOSIT_CENTERS[s.deposit] ?? 8;
            const oreGlow = ctx.createRadialGradient(40 + center / 16 * 560, 147, 5, 40 + center / 16 * 560, 147, 180);
            oreGlow.addColorStop(0, rgb(s.deposit_color, .21));
            oreGlow.addColorStop(.55, rgb(s.deposit_color, .063));
            oreGlow.addColorStop(1, rgb(s.deposit_color, 0));
            ctx.fillStyle = oreGlow;
            ctx.fillRect(0, 10, 640, 210);
            ctx.fillStyle = "#14262b";
            ctx.beginPath();
            ctx.moveTo(0, 72);
            for (let x = 0; x <= 640; x += 22)
                ctx.lineTo(x, 46 + ((x * 11) % 43));
            ctx.lineTo(640, 0);
            ctx.lineTo(0, 0);
            ctx.fill();
            ctx.fillStyle = "#0a151a";
            ctx.beginPath();
            ctx.moveTo(0, 39);
            for (let x = 0; x <= 640; x += 29)
                ctx.lineTo(x, 20 + ((x * 17) % 39));
            ctx.lineTo(640, 0);
            ctx.lineTo(0, 0);
            ctx.fill();
            ctx.fillStyle = "#31464a";
            for (let x = 12; x < 640; x += 47) {
                const y = 51 + ((x * 13) % 46);
                ctx.fillRect(x, y, 3, 3);
                ctx.fillRect(x + 7, y + 8, 2, 2);
            }
            ctx.fillStyle = "#192c31";
            ctx.fillRect(0, 181, 640, 59);
            ctx.fillStyle = "#405458";
            ctx.fillRect(0, 181, 640, 5);
            ctx.fillStyle = "#79603d";
            for (let x = 0; x < 640; x += 20)
                ctx.fillRect(x, 188, 13, 4);
            ctx.fillStyle = "#263b40";
            ctx.fillRect(119, 71, 5, 111);
            ctx.fillRect(516, 71, 5, 111);
            ctx.fillStyle = "#91ded4";
            for (let y = 82; y < 176; y += 18) {
                ctx.fillRect(118, y, 17, 3);
                ctx.fillRect(505, y, 17, 3);
            }
            ctx.fillStyle = "#e8c96d";
            ctx.fillRect(124, 77, 5, 5);
            ctx.fillRect(511, 77, 5, 5);
            const platformGlow = ctx.createLinearGradient(0, 160, 0, 190);
            platformGlow.addColorStop(0, "#83e5d20d");
            platformGlow.addColorStop(1, "transparent");
            ctx.fillStyle = platformGlow;
            ctx.fillRect(126, 146, 389, 43);
            ctx.fillStyle = "#13242a";
            ctx.fillRect(132, 163, 376, 18);
            ctx.fillStyle = "#50686a";
            for (let x = 136; x < 505; x += 16) {
                ctx.fillRect(x, 168, 10, 4);
                ctx.fillRect(x + 5, 174, 3, 7);
            }
            ctx.fillStyle = "#020608";
            ctx.fillRect(0, 211, 640, 29);
            s.colors.forEach((colour, index) => { const x = 12 + index * 37; ctx.fillStyle = "#132027"; ctx.fillRect(x, 218, 28, 13); ctx.fillStyle = rgb(colour); ctx.fillRect(x + 3, 221, 22, 6); ctx.globalAlpha = .35; ctx.fillStyle = "#fff"; ctx.fillRect(x + 5, 221, 7, 2); ctx.globalAlpha = 1; });
            ctx.restore();
            if (s.complete)
                finaleSky(ctx, finaleElapsed, time);
            const ground = 543;
            const left = [24, 132, 237];
            const right = [1794, 1695, 1578];
            s.city.forEach((plot, index) => { const localRise = s.complete ? smooth((finaleElapsed - 6 - index * 1.2) / 4) : 1; const shown = plot && s.complete ? { ...plot, level: Math.max(1, plot.level - 1 + localRise) } : plot; building(ctx, left[index], ground, index, shown, "left", time); building(ctx, right[index], ground, index, shown, "right", time); });
            if (!s.complete && !finaleArmed) {
                const activePlot = s.deposit % 3;
                constructionLift(ctx, left[activePlot], ground, activePlot, s.city[activePlot], "left", s.progress, time);
                constructionLift(ctx, right[activePlot], ground, activePlot, s.city[activePlot], "right", s.progress, time);
            }
            const cellX = (cell) => (40 + cell / 16 * 560) * 3;
            if (s.complete || finaleArmed) {
                finaleBeacon(ctx, ground, finaleElapsed, time, s.deposit_color);
                const formation = [735, 850, 1070, 1185];
                s.workers.forEach((worker, index) => miner(ctx, { ...worker, rank: 4, outbound: true, loaded: false, held: false }, formation[index], ground - 4, time, finaleArmed || finaleElapsed < 5 ? (time % (720 / s.tempo)) / (720 / s.tempo) : null, s.deposit_color, s.deposit_light));
            }
            else {
                const oreX = cellX(center);
                const secondary = DEPOSIT_SECONDARY[s.deposit] ?? s.deposit_light;
                const baseY = 535;
                const icon = s.deposit_icon;
                const remaining = .24 + (1 - s.progress) * .76;
                caveEntrance(ctx, oreX, ground, time, s.deposit_color, s.deposit_light);
                // Ore grows from the inner walls while the centre remains an unmistakable open passage.
                const clusters = icon === "twin" ? [[-120, 70, 170, -10, s.deposit_color], [120, 70, 170, 10, secondary]]
                    : icon === "branch" ? [[-140, 54, 150, -16, s.deposit_color], [-78, 58, 180, 12, secondary], [128, 45, 105, 8, s.deposit_color]]
                        : icon === "flame" ? [[-120, 75, 190, 18, s.deposit_color], [115, 48, 130, -9, secondary]]
                            : icon === "prism" ? [[-112, 72, 205, -6, s.deposit_color], [112, 56, 158, 8, secondary]]
                                : icon === "core" ? [[-112, 66, 190, -4, s.deposit_color], [112, 66, 190, 4, secondary]]
                                    : [[-120, 65, 205, -6, s.deposit_color], [-58, 38, 96, -9, secondary], [120, 55, 125, 8, secondary]];
                clusters.forEach(([dx, width, height, lean, colour], index) => facetedCrystal(ctx, oreX + dx * remaining, baseY - (1 - remaining) * 13, width * remaining, height * remaining, lean * remaining, colour, s.deposit_light, index + s.deposit * 5, time * .0018));
                s.workers.forEach((worker) => {
                    const recorded = impactRef.current.get(worker.id);
                    if (!recorded)
                        impactRef.current.set(worker.id, { seq: worker.impact_seq, start: -Infinity });
                    else if (recorded.seq !== worker.impact_seq)
                        impactRef.current.set(worker.id, { seq: worker.impact_seq, start: time });
                    const impact = impactRef.current.get(worker.id);
                    const duration = 720 / s.tempo;
                    const swing = (time - impact.start) / duration;
                    miner(ctx, worker, cellX(worker.position), ground + 1, time, swing >= 0 && swing < 1 ? swing : null, s.deposit_color, s.deposit_light);
                });
                caveEntrance(ctx, oreX, ground, time, s.deposit_color, s.deposit_light, true);
                if (s.convoy_held) {
                    convoyGate(ctx, cellX(3) - 20, ground, 1, time, s.pending_convoy);
                    convoyGate(ctx, cellX(13) + 20, ground, -1, time, s.pending_convoy);
                }
            }
            // Match the HTML concept's local lighting: ore light falls across steel, tools and nearby silhouettes.
            if (!s.complete && !finaleArmed) {
                const oreX = cellX(center);
                ctx.save();
                ctx.globalCompositeOperation = "screen";
                const bounce = ctx.createRadialGradient(oreX, 485, 8, oreX, 485, 430);
                bounce.addColorStop(0, rgb(s.deposit_light, .29));
                bounce.addColorStop(.34, rgb(s.deposit_color, .1));
                bounce.addColorStop(1, rgb(s.deposit_color, 0));
                ctx.fillStyle = bounce;
                ctx.fillRect(Math.max(0, oreX - 440), 175, Math.min(880, 1920 - oreX + 440), 400);
                for (let x = 410; x < 1510; x += 48) {
                    const falloff = Math.max(0, 1 - Math.abs(x - oreX) / 540);
                    if (!falloff)
                        continue;
                    ctx.fillStyle = rgb(s.deposit_light, falloff * .47);
                    ctx.fillRect(x, ground - 66, 31, 3);
                    ctx.fillStyle = rgb(s.deposit_color, falloff * .22);
                    ctx.fillRect(x + 7, ground - 55, 17, 2);
                }
                ctx.restore();
            }
            // Fine geological seams, suspended work lamps and slow foundry smoke keep the mine alive without flat light panels.
            ctx.strokeStyle = "rgba(116,157,158,.11)";
            ctx.lineWidth = 1;
            for (let i = 0; i < 21; i += 1) {
                const y = 52 + i * 19;
                const x = (i * 263 + 97) % 1850;
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x + 37, y - 8);
                ctx.lineTo(x + 89, y + 3);
                ctx.lineTo(x + 136, y - 5);
                ctx.stroke();
            }
            [285, 658, 1021, 1423, 1810].forEach((x, index) => { const y = index % 2 ? 112 : 103; ctx.strokeStyle = "rgba(115,150,151,.48)"; ctx.beginPath(); ctx.moveTo(x, 84); ctx.lineTo(x, y); ctx.stroke(); ctx.fillStyle = "#d8bc6a"; ctx.fillRect(x - 7, y, 14, 4); const lamp = ctx.createRadialGradient(x, y + 6, 0, x, y + 6, 48); lamp.addColorStop(0, "rgba(255,221,139,.17)"); lamp.addColorStop(1, "transparent"); ctx.fillStyle = lamp; ctx.fillRect(x - 48, y - 8, 96, 80); });
            if (s.city[0])
                [94, 1819].forEach((originX, side) => { for (let i = 0; i < 7; i += 1) {
                    const travel = (time * .018 + i * 29) % 155;
                    const drift = Math.sin(time * .0013 + i * 1.9 + side) * 13 + (side ? -travel * .14 : travel * .14);
                    const radius = 7 + travel * .085;
                    ctx.globalAlpha = Math.max(0, .19 - travel / 1000);
                    ctx.fillStyle = i % 2 ? "#a5bbb7" : "#647c7b";
                    ctx.beginPath();
                    ctx.arc(originX + drift, 278 - travel, radius, 0, Math.PI * 2);
                    ctx.fill();
                } ctx.globalAlpha = 1; });
            // The wet reflection is clipped above the physical LED row, exactly as in deep17.
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 548, 1920, 78);
            ctx.clip();
            ctx.globalAlpha = .16;
            ctx.globalCompositeOperation = "screen";
            ctx.translate(0, 828);
            ctx.scale(1, -1);
            ctx.drawImage(canvas, 0, 255, 1920, 300, 0, 0, 1920, 300);
            ctx.restore();
            const fade = ctx.createLinearGradient(0, 548, 0, 626);
            fade.addColorStop(0, "rgba(4,11,14,.15)");
            fade.addColorStop(1, "rgba(4,11,14,.92)");
            ctx.fillStyle = fade;
            ctx.fillRect(0, 548, 1920, 78);
            const reflectionOreX = cellX(center);
            for (let i = 0; i < 34; i += 1) {
                const y = 553 + i * 2.1;
                const offset = Math.sin(time * .0015 + i * 1.7) * (4 + i * .25);
                ctx.fillStyle = i % 3 ? "rgba(200,235,228,.055)" : rgb(s.deposit_color, .085);
                ctx.fillRect(Math.max(0, reflectionOreX - 250 + offset), y, 500 - i * 9, 1);
            }
            ctx.fillStyle = "rgba(215,176,86,.58)";
            for (let x = 18; x < 1902; x += 42) {
                ctx.fillRect(x, 570, 22, 5);
                ctx.fillStyle = "rgba(12,20,22,.9)";
                ctx.fillRect(x + 15, 570, 7, 5);
                ctx.fillStyle = "rgba(215,176,86,.58)";
            }
            // Dust, cable glints and moving mine light.
            for (let i = 0; i < 92; i += 1) {
                const x = (i * 373 + time * (0.002 + (i % 4) * 0.0005)) % 1920;
                const y = 80 + ((i * 227 + time * 0.004) % 440);
                ctx.fillStyle = i % 7 ? "rgba(205,241,233,.09)" : rgb(s.deposit_light, 0.16);
                ctx.fillRect(x, y, i % 5 ? 2 : 4, i % 5 ? 2 : 4);
            }
            const celebrationAge = time - celebrationRef.current.start;
            if (s.cue_active && celebrationAge >= 0 && celebrationAge < 1050 && ["strike", "miss", "critical"].includes(s.cue_kind)) {
                const duration = s.cue_kind === "critical" ? 1050 : 720;
                const p = Math.min(1, celebrationAge / duration);
                const impactX = cellX(center);
                const impactY = 454;
                const impactColour = s.cue_kind === "miss" ? "#d29a58" : s.cue_kind === "critical" ? "#fff0a0" : rgb(s.deposit_light);
                ctx.save();
                ctx.globalCompositeOperation = "screen";
                const flash = Math.max(0, 1 - p * 1.7);
                const impactGlow = ctx.createRadialGradient(impactX, impactY, 4, impactX, impactY, 42 + p * 150);
                impactGlow.addColorStop(0, s.cue_kind === "miss" ? `rgba(210,154,88,${flash * .48})` : rgb(s.deposit_light, flash * .62));
                impactGlow.addColorStop(.3, rgb(s.deposit_color, flash * .22));
                impactGlow.addColorStop(1, rgb(s.deposit_color, 0));
                ctx.fillStyle = impactGlow;
                ctx.fillRect(impactX - 210, impactY - 210, 420, 420);
                for (let i = 0; i < (s.cue_kind === "critical" ? 24 : 13); i += 1) {
                    const angle = i * 2.399 + .35;
                    const travel = (26 + (i % 6) * 15) * Math.sin(Math.min(1, p) * Math.PI * .72);
                    const chipX = impactX + Math.cos(angle) * travel;
                    const chipY = impactY + Math.sin(angle) * travel * .62 - p * 19;
                    ctx.save();
                    ctx.translate(chipX, chipY);
                    ctx.rotate(angle + p * 3);
                    ctx.globalAlpha = (1 - p) * (s.cue_kind === "miss" ? .54 : .86);
                    ctx.fillStyle = i % 3 ? impactColour : rgb(s.deposit_color);
                    ctx.fillRect(-5, -3, 10 + i % 4, 6);
                    ctx.restore();
                }
                ctx.globalAlpha = (1 - p) * .74;
                ctx.strokeStyle = impactColour;
                ctx.lineWidth = s.cue_kind === "critical" ? 9 : 5;
                ctx.beginPath();
                ctx.ellipse(impactX, impactY, 26 + p * 136, 12 + p * 48, -0.08, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }
            if (s.cue_active && celebrationAge >= 0 && celebrationAge < 2500 && s.cue_kind && !["strike", "miss", "critical", "recall", "convoy_hold", "convoy_release"].includes(s.cue_kind)) {
                const p = celebrationAge / 2500;
                ctx.save();
                ctx.globalCompositeOperation = "screen";
                if (s.cue_kind.startsWith("cashout")) {
                    const flash = Math.max(0, 1 - p * 3.4);
                    const flashX = cellX(s.visible_cells[Math.floor(s.visible_cells.length / 2)] ?? center);
                    const halo = ctx.createRadialGradient(flashX, 450, 15, flashX, 450, 610);
                    halo.addColorStop(0, rgb(s.deposit_light, .54 * flash));
                    halo.addColorStop(.26, rgb(s.deposit_color, .22 * flash));
                    halo.addColorStop(1, rgb(s.deposit_color, 0));
                    ctx.fillStyle = halo;
                    ctx.fillRect(0, 0, 1920, 650);
                    ctx.globalAlpha = flash * .14;
                    ctx.fillStyle = rgb(s.deposit_light);
                    ctx.fillRect(0, 0, 1920, 626);
                    ctx.globalAlpha = 1;
                }
                for (let ring = 0; ring < 5; ring += 1) {
                    const local = Math.max(0, Math.min(1, p * 1.8 - ring * 0.11));
                    ctx.globalAlpha = (1 - local) * 0.6;
                    ctx.strokeStyle = ring % 2 ? rgb(s.deposit_light) : "#fff4bd";
                    ctx.lineWidth = 4 + ring * 2;
                    ctx.beginPath();
                    ctx.ellipse(cellX(s.visible_cells[Math.floor(s.visible_cells.length / 2)]), 475, 90 + local * 520, 34 + local * 165, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
                for (let i = 0; i < 72; i += 1) {
                    const travel = (p * (1.1 + (i % 5) * 0.14) + (i % 11) / 11) % 1;
                    const x = 960 + (i % 2 ? 1 : -1) * (75 + (i % 13) * 43) + Math.sin(i * 9.7 + p * 8) * 46;
                    const y = 560 - travel * (300 + (i % 7) * 22);
                    const size = i % 6 === 0 ? 10 : 5;
                    ctx.globalAlpha = (1 - travel) * 0.8;
                    ctx.fillStyle = i % 4 ? rgb(s.deposit_light) : "#fff7cf";
                    ctx.fillRect(x - size, y - 2, size * 2, 4);
                    ctx.fillRect(x - 2, y - size, 4, size * 2);
                }
                ctx.restore();
            }
            // Texture without smoothing keeps the image authored rather than glossy-vector flat.
            for (let i = 0; i < 2600; i += 1) {
                const x = (i * 977 + 71) % 1920;
                const y = (i * 613 + 29) % 720;
                ctx.fillStyle = i % 7 ? "rgba(0,0,0,.04)" : "rgba(205,255,242,.035)";
                ctx.fillRect(x, y, 1, 1);
            }
            animation = requestAnimationFrame(draw);
        };
        animation = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(animation);
    }, []);
    return SP_JSX.jsx("canvas", { ref: canvasRef, className: "sm-world", width: 1920, height: 720, "aria-label": `${status.worker_count} miners extracting ${status.deposit_name}. ${Math.round(status.progress * 100)} percent revealed.` });
}

// SteamClient.Input.ControllerInputGamepadButton and the standard browser
// Gamepad layout use the same face-button indices for A, X and Y.
const ACTION_BY_BUTTON = {
    0: "strike",
    2: "convoy",
    3: "overcharge",
};
function browserPads() {
    try {
        return Array.from(navigator.getGamepads?.() ?? []);
    }
    catch {
        return [];
    }
}
class StripMineControls {
    alive = false;
    callbacks;
    steamHook;
    steamAvailable = false;
    heldSteam = new Set();
    heldBrowser = new Map();
    lastAction = new Map();
    pollTimer;
    hookTimer;
    constructor(callbacks) {
        this.callbacks = callbacks;
    }
    start() {
        if (this.alive)
            return;
        this.alive = true;
        this.ensureSteamHook();
        this.pollTimer = window.setInterval(() => this.readBrowser(), 25);
        this.hookTimer = window.setInterval(() => this.ensureSteamHook(), 1000);
    }
    stop() {
        this.alive = false;
        window.clearInterval(this.pollTimer);
        window.clearInterval(this.hookTimer);
        this.steamHook?.unregister?.();
        this.steamHook = undefined;
        this.steamAvailable = false;
        this.heldSteam.clear();
        this.heldBrowser.clear();
    }
    ensureSteamHook() {
        if (!this.alive || this.steamAvailable)
            return;
        try {
            const input = typeof SteamClient === "undefined" ? undefined : SteamClient?.Input;
            const register = input?.RegisterForControllerInputMessages;
            if (typeof register !== "function")
                return;
            this.steamHook = register.call(input, (index, button, pressed) => {
                this.onSteamButton(index, button, pressed);
            });
            this.steamAvailable = true;
            this.callbacks.onSource?.("steam");
        }
        catch {
            // SteamUI can expose the input service shortly after the route is mounted.
        }
    }
    dispatch(action, source) {
        const now = performance.now();
        // SteamInput and navigator.getGamepads can report the same physical press.
        if (now - (this.lastAction.get(action) ?? -1e3) < 180)
            return;
        this.lastAction.set(action, now);
        this.callbacks.onSource?.(source);
        this.callbacks.onAction(action);
    }
    onSteamButton(index, button, rawPressed) {
        if (!this.alive || !Number.isInteger(index) || index < 0 || index >= 0xffffffff ||
            !Number.isInteger(button) || button < 0 || button > 255 ||
            ![true, false, 0, 1].includes(rawPressed))
            return;
        const pressed = Boolean(rawPressed);
        const key = `${index}:${button}`;
        const wasHeld = this.heldSteam.has(key);
        if (pressed)
            this.heldSteam.add(key);
        else
            this.heldSteam.delete(key);
        if (!pressed || wasHeld)
            return;
        const action = ACTION_BY_BUTTON[button];
        if (action)
            this.dispatch(action, "steam");
    }
    readBrowser() {
        if (!this.alive)
            return;
        const present = new Set();
        let connected = false;
        for (const pad of browserPads()) {
            if (!pad?.connected)
                continue;
            connected = true;
            for (const button of [0, 2, 3]) {
                const key = `${pad.index}:${button}`;
                present.add(key);
                const current = pad.buttons[button];
                const pressed = Boolean(current?.pressed || (current?.value ?? 0) > .75);
                const wasHeld = this.heldBrowser.get(key) ?? pressed;
                this.heldBrowser.set(key, pressed);
                if (!pressed || wasHeld)
                    continue;
                const action = ACTION_BY_BUTTON[button];
                if (action)
                    this.dispatch(action, "browser");
            }
        }
        for (const key of this.heldBrowser.keys())
            if (!present.has(key))
                this.heldBrowser.delete(key);
        if (!this.steamAvailable && connected)
            this.callbacks.onSource?.("browser");
    }
}

const styles = `
.sm-intro-logo{display:block;width:min(490px,43vw);max-height:55vh;margin:-3vh 0 -2vh;object-fit:contain;filter:drop-shadow(0 18px 38px #000b) drop-shadow(0 0 30px #168b9a2e)}.sm-intro-title .sm-intro-logo+p{margin:5px 0 20px!important}@media(max-width:900px){.sm-intro-logo{width:min(430px,64vw);margin:-2vh 0 -1vh}}
.sm-qam-logo{display:block;width:38px;height:38px;border:1px solid #49636b;border-radius:6px;object-fit:contain;box-shadow:0 0 14px #23cdd73d}
.sm-app{position:fixed;inset:0;z-index:1000;overflow:hidden;color:#edf7f4;background:#03070a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.sm-app *{box-sizing:border-box}.sm-shell{position:absolute;inset:0;display:grid;grid-template-rows:66.667vh 33.333vh;background:#050a0e}.sm-world-stage{position:relative;min-height:0;overflow:hidden}.sm-world{display:block;width:100%;height:100%;object-fit:cover;image-rendering:pixelated}.sm-vignette{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 56%,transparent 43%,#010305c4 100%),repeating-linear-gradient(0deg,#0000 0 3px,#00000016 3px 4px);mix-blend-mode:multiply}.sm-hud{position:absolute;inset:22px 28px auto;display:flex;align-items:flex-start;justify-content:space-between;gap:24px;text-shadow:0 3px 0 #000,0 0 18px #000;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;pointer-events:none}.sm-hud-left,.sm-hud-right{display:flex;flex-direction:column}.sm-hud-left span,.sm-hud-right span{color:#8fe7db;font-size:11px;font-weight:900;letter-spacing:.17em}.sm-hud-left strong{font-size:clamp(21px,2.4vw,42px);color:#fff0a3;letter-spacing:-.045em}.sm-hud-left small{margin-top:5px;color:#b2c8c6;font-size:11px;letter-spacing:.04em}.sm-hud-right{text-align:right;align-items:flex-end}.sm-hud-right strong{font:900 clamp(41px,5.5vw,86px)/.92 ui-monospace,monospace;letter-spacing:-.08em}.sm-hud-right small{margin-top:8px;padding:5px 8px;border:1px solid #ffffff36;background:#091116a8;color:#e9f7f4;font-size:10px;letter-spacing:.08em}.sm-world-nav{position:absolute;left:26px;bottom:19px;display:flex;gap:8px}.sm-world-nav button,.sm-audio button{min-height:34px;padding:7px 11px;border:1px solid #526b72!important;border-radius:5px!important;background:#09131bdd!important;color:#afc1c5!important;font:900 10px ui-monospace,monospace!important;letter-spacing:.08em!important}.sm-world-nav button:hover,.sm-audio button:hover{background:#18313a!important;color:#f4fffd!important}.sm-audio{position:absolute;right:24px;bottom:19px;display:flex;gap:8px}.sm-audio button.on{border-color:#66d9ca!important;background:#183d3a!important;color:#edfffb!important;box-shadow:0 0 17px #45dec536}.sm-alert{position:absolute;right:25px;top:122px;max-width:390px;padding:10px 13px;border:1px solid #bb7670;background:#49282ee8;border-radius:5px;color:#ffded7;font-size:11px;line-height:1.45;box-shadow:0 8px 25px #0008}.sm-command{position:relative;display:grid;grid-template-columns:minmax(370px,.95fr) minmax(410px,1.2fr) minmax(310px,.84fr);min-height:0;border-top:4px solid #aa7b38;background:linear-gradient(180deg,#2d3b40 0,#17242a 6%,#080e12 100%);box-shadow:inset 0 1px #ffe39c99,inset 0 14px 34px #0006}.sm-command:before{content:"";position:absolute;inset:8px;pointer-events:none;background:repeating-linear-gradient(135deg,#ffffff04 0 1px,transparent 1px 7px)}.sm-matrix-wrap,.sm-strip-panel,.sm-actions{position:relative;min-width:0;padding:clamp(12px,1.4vw,22px);border-right:1px solid #33484f}.sm-matrix-head,.sm-strip-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px;color:#8ea6ac;font:900 9px ui-monospace,monospace;letter-spacing:.13em}.sm-matrix-head strong,.sm-strip-head strong{color:#ffe09a;font-size:10px;white-space:nowrap}.sm-matrix-frame{height:calc(100% - 24px);min-height:0;padding:7px;border:1px solid #5d5146;border-radius:6px;background:#05090c;box-shadow:inset 0 0 22px #000,0 0 17px #f3b55823}.sm-matrix{display:block;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;filter:brightness(1.15) saturate(1.18)}.sm-strip-panel{display:flex;flex-direction:column;justify-content:center}.sm-shift{margin-bottom:10px}.sm-kicker{display:block;color:#8aa3a9;font:900 9px ui-monospace,monospace;letter-spacing:.17em}.sm-shift strong{display:block;margin:6px 0 4px;color:#f8d878;font:900 clamp(15px,1.55vw,24px)/1.05 ui-monospace,monospace;letter-spacing:-.035em}.sm-shift p{display:flex;gap:13px;margin:0;color:#82d9cd;font:800 9px ui-monospace,monospace}.sm-rail{display:grid;grid-template-columns:repeat(17,minmax(0,1fr));gap:4px;padding:9px 10px;border:1px solid #465c62;border-radius:6px;background:#020507;box-shadow:inset 0 0 18px #000,0 0 0 3px #18252b}.sm-rail i{position:relative;display:block;min-height:23px;border-radius:3px}.sm-rail i:after{content:"";position:absolute;inset:2px;background:linear-gradient(145deg,#ffffff7d,transparent 44%);border-radius:2px}.sm-strip-scale{display:flex;justify-content:space-between;margin-top:6px;color:#78949b;font:800 8px ui-monospace,monospace;letter-spacing:.08em}.sm-progress{position:relative;height:8px;margin-top:12px;border:1px solid #40575d;background:#030709;border-radius:99px;overflow:hidden}.sm-progress i{display:block;height:100%;background:linear-gradient(90deg,#2abdaf,var(--ore));box-shadow:0 0 12px var(--ore);transition:width .2s}.sm-meta{display:flex;justify-content:space-between;gap:8px;margin-top:8px;color:#a8bcbe;font:800 9px ui-monospace,monospace}.sm-meta span:last-child{text-align:right}.sm-actions{border-right:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr 1fr;gap:8px}.sm-actions-title{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;color:#8ea6ac;font:900 9px ui-monospace,monospace;letter-spacing:.15em}.sm-actions-title strong{color:#ffe09a}.sm-action{position:relative;display:flex!important;align-items:center!important;justify-content:flex-start!important;gap:11px!important;min-width:0!important;padding:9px 11px!important;border:1px solid #566970!important;border-radius:7px!important;background:linear-gradient(145deg,#2a3940,#101a20)!important;color:#eef7f4!important;text-align:left!important;box-shadow:inset 0 1px #ffffff17,0 5px 12px #0004!important}.sm-action:hover{background:linear-gradient(145deg,#405158,#192830)!important;transform:translateY(-1px)}.sm-action.primary{grid-row:2/4;border-color:#ae833e!important;background:linear-gradient(145deg,#5a4b2d,#201d16)!important}.sm-action.active{border-color:#70ddce!important;box-shadow:inset 0 1px #ffffff20,0 0 20px #4be0ca35!important}.sm-action kbd{display:grid;place-items:center;flex:none;width:31px;height:31px;border:1px solid #779096;border-radius:50%;background:#071014;color:#ffe092;font:900 15px ui-monospace,monospace;box-shadow:inset 0 0 8px #000}.sm-action span{min-width:0}.sm-action b,.sm-action small{display:block}.sm-action b{font:900 11px ui-monospace,monospace;letter-spacing:.02em}.sm-action small{margin-top:3px;color:#99b0b4;font-size:9px}.sm-action.disabled{opacity:.44}.sm-settings-line{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:8px}.sm-settings-line button{padding:4px 7px!important;min-height:25px!important;border:1px solid #465c62!important;background:#122229!important;color:#9eb9bd!important;border-radius:4px!important;font-size:9px!important}.sm-settings-line span{color:#7ce1d2;font:800 9px ui-monospace,monospace}.sm-gamepad-focus,.sm-app button:focus-visible{outline:3px solid #a8f5ed!important;outline-offset:3px;box-shadow:0 0 0 6px #09282d,0 0 22px #77f3e9!important;z-index:5}.sm-toast{position:absolute;left:50%;top:18%;transform:translateX(-50%);padding:11px 24px;border:1px solid var(--ore);border-radius:4px;background:#071015db;color:#fff3bd;font:900 18px ui-monospace,monospace;letter-spacing:.05em;text-align:center;text-shadow:0 0 16px var(--ore);animation:sm-toast 2.35s both;pointer-events:none}.sm-reset-confirm{position:absolute;inset:0;z-index:20;display:grid;place-items:center;background:#020507db}.sm-reset-card{width:min(500px,80vw);padding:28px;border:1px solid #976f49;border-radius:10px;background:#16242a;box-shadow:0 30px 80px #000}.sm-reset-card h2{margin:0 0 8px;color:#ffe19a}.sm-reset-card p{color:#b6c8c8;line-height:1.5}.sm-reset-card div{display:flex;gap:10px;margin-top:20px}.sm-reset-card button{padding:10px 15px!important;border:1px solid #647a7f!important;border-radius:6px!important;background:#263940!important;color:#fff!important}.sm-reset-card button.danger{border-color:#bd6868!important;background:#512d31!important}
.sm-score-hud{position:absolute;left:28px;top:112px;display:flex;flex-direction:column;padding:10px 14px;border-left:3px solid #f3c55c;background:linear-gradient(90deg,#071014d9,transparent);font-family:ui-monospace,monospace;text-shadow:0 2px 8px #000}.sm-score-hud span{color:#79dace;font-size:9px;font-weight:900;letter-spacing:.18em}.sm-score-hud strong{color:#fff0ad;font-size:30px;line-height:1}.sm-score-hud small{margin-top:4px;color:#c2d4d1;font-size:9px;font-weight:800}.sm-top-controls{position:absolute;left:50%;top:20px;display:flex;align-items:stretch;gap:7px;transform:translateX(-50%);font-family:ui-monospace,monospace}.sm-tempo,.sm-world-bar-mode{display:flex;padding:4px;border:1px solid #465b61;border-radius:7px;background:#061016e8;box-shadow:0 8px 22px #0008}.sm-tempo button,.sm-world-bar-mode button{padding:5px 8px!important;border:0!important;border-right:1px solid #34494f!important;border-radius:3px!important;background:transparent!important;color:#79969b!important;font:900 9px ui-monospace,monospace!important}.sm-tempo button{min-width:66px!important}.sm-world-bar-mode button{min-width:82px!important}.sm-tempo button:last-child,.sm-world-bar-mode button:last-child{border-right:0!important}.sm-tempo button b,.sm-tempo button small,.sm-world-bar-mode button b,.sm-world-bar-mode button small{display:block}.sm-tempo button small,.sm-world-bar-mode button small{color:#667f84}.sm-tempo button.active{background:#44381f!important;color:#ffe49b!important;box-shadow:inset 0 0 12px #ffc94a1f!important}.sm-tempo button.active small{color:#96e7dc}.sm-world-bar-mode button.active{background:#173b3a!important;color:#effffb!important;box-shadow:inset 0 0 12px #4de0ca2e!important}.sm-world-bar-mode button.active small{color:#94d9cf}.sm-score-cascade{position:absolute;z-index:8;left:50%;top:34%;width:min(590px,48vw);transform:translate(-50%,-50%);text-align:center;pointer-events:none;font-family:ui-monospace,monospace;text-shadow:0 4px 0 #000,0 0 24px var(--ore);animation:sm-score-out calc(var(--score-ms) * 3.2) both}.sm-score-cascade>span{display:block;color:#75e7d6;font-size:12px;font-weight:900;letter-spacing:.22em}.sm-score-cascade>strong{display:block;color:#fff4bd;font-size:clamp(48px,7vw,108px);line-height:.98;letter-spacing:-.08em}.sm-score-cascade>div{display:flex;justify-content:center;flex-wrap:wrap;gap:5px;margin-top:7px}.sm-score-cascade i{padding:4px 7px;border:1px solid #ecc35c82;border-radius:3px;background:#1e1b12df;color:#ffe59a;font-size:10px;font-style:normal;font-weight:900;opacity:0;animation:sm-score-step calc(var(--score-ms) * 1.8) both}.sm-score-cascade small{display:block;margin-top:8px;color:#d8ebe7;font-size:10px;font-weight:900;letter-spacing:.08em}.sm-score-cascade.record>strong{animation:sm-record .42s 2}.sm-settings-line button.workshop{border-color:#9d7940!important;background:#3f3522!important;color:#ffe3a0!important}.sm-workshop{position:absolute;inset:0;z-index:30;display:grid;place-items:center;background:#020609df}.sm-workshop-card{width:min(760px,84vw);padding:22px;border:1px solid #9b7948;border-radius:10px;background:linear-gradient(145deg,#26363b,#10191e);box-shadow:0 35px 100px #000}.sm-workshop-card header{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:14px;padding-bottom:15px;border-bottom:1px solid #3d5155}.sm-workshop-card header span{color:#ffe098;font:900 20px ui-monospace,monospace}.sm-workshop-card header strong{color:#7ee4d5;font:900 14px ui-monospace,monospace}.sm-workshop-card button{padding:8px 11px!important;border:1px solid #60777b!important;border-radius:5px!important;background:#1a2b31!important;color:#eaf5f2!important;font:900 10px ui-monospace,monospace!important}.sm-upgrades{display:grid;gap:9px;margin-top:15px}.sm-upgrade{display:grid;grid-template-columns:50px 1fr auto;align-items:center;gap:13px;padding:13px;border:1px solid #405359;border-radius:7px;background:#0a1318}.sm-upgrade>i{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;background:#3c3421;color:#ffdd83;font:900 25px serif;font-style:normal}.sm-upgrade span b,.sm-upgrade span small{display:block}.sm-upgrade span b{color:#f7e7b2;font:900 13px ui-monospace,monospace}.sm-upgrade span small{margin:3px 0 8px;color:#9eb5b6;font-size:10px}.sm-upgrade em{display:flex;gap:4px}.sm-upgrade u{display:block;width:25px;height:5px;background:#26393e;text-decoration:none}.sm-upgrade u.on{background:#e5b950;box-shadow:0 0 8px #ffc84a}.sm-upgrade button:disabled{opacity:.35}.sm-workshop-card footer{margin-top:15px;color:#819b9d;font:800 9px ui-monospace,monospace;text-align:center;letter-spacing:.08em}.sm-intro-tempo{display:flex;flex-direction:column;align-items:center;gap:7px;margin:-12px 0 13px;opacity:0;pointer-events:none;transition:opacity .5s}.sm-intro-5 .sm-intro-tempo{opacity:1;pointer-events:auto}.sm-intro-tempo>b{color:#8edfd5;font-size:9px;letter-spacing:.2em}.sm-intro-tempo>div{display:flex;gap:6px}.sm-intro-tempo button{min-width:108px!important;padding:7px 9px!important;border:1px solid #465b61!important;border-radius:4px!important;background:#091318!important;color:#91a7aa!important;font:900 10px ui-monospace,monospace!important}.sm-intro-tempo button small{display:block;margin-top:2px;color:#647d81;font-size:8px}.sm-intro-tempo button.active{border-color:#d1a64d!important;background:#493b21!important;color:#ffe198!important}.sm-intro-tempo button.active small{color:#9be4d9}.sm-intro-tempo em{color:#6f8c90;font-size:8px;font-style:normal;letter-spacing:.06em}
@keyframes sm-score-step{0%{opacity:0;transform:translateY(10px) scale(.82)}22%,80%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-5px)}}@keyframes sm-score-out{0%,70%{opacity:1}100%{opacity:0}}@keyframes sm-record{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}@keyframes sm-toast{0%{opacity:0;transform:translate(-50%,16px) scale(.94)}12%,72%{opacity:1;transform:translate(-50%,0) scale(1)}100%{opacity:0;transform:translate(-50%,-10px) scale(1.03)}}
.sm-intro{position:fixed;inset:0;z-index:2000;overflow:hidden;background:radial-gradient(ellipse at 50% 57%,#0d2025 0,#020508 68%);color:#fff;font-family:ui-monospace,SFMono-Regular,monospace}.sm-intro:before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,#0000 72%,#000 100%),repeating-linear-gradient(0deg,#0000 0 3px,#0004 3px 4px)}.sm-intro-grain{position:absolute;inset:0;opacity:.2;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.22'/%3E%3C/svg%3E")}.sm-intro-copy{position:absolute;left:50%;top:15%;transform:translateX(-50%);text-align:center;transition:opacity .7s,transform .7s}.sm-intro-copy span{display:block;color:#87dfd3;font-size:11px;font-weight:900;letter-spacing:.25em}.sm-intro-copy strong{display:block;margin-top:8px;color:#fff0a6;font-size:clamp(34px,6vw,82px);letter-spacing:-.08em}.sm-copy-1{opacity:0;transform:translate(-50%,18px)}.sm-intro-1 .sm-copy-0,.sm-intro-2 .sm-copy-0,.sm-intro-3 .sm-copy-0,.sm-intro-4 .sm-copy-0,.sm-intro-5 .sm-copy-0{opacity:0;transform:translate(-50%,-16px)}.sm-intro-1 .sm-copy-1,.sm-intro-2 .sm-copy-1,.sm-intro-3 .sm-copy-1{opacity:1;transform:translate(-50%,0)}.sm-intro-4 .sm-copy-1,.sm-intro-5 .sm-copy-1{opacity:0;transform:translate(-50%,-16px)}.sm-intro-scene{position:absolute;left:50%;top:58%;width:min(1160px,82vw);height:190px;transform:translate(-50%,-50%)}.sm-intro-rail{position:absolute;left:0;right:0;top:80px;display:grid;grid-template-columns:repeat(17,1fr);gap:10px;padding:12px 15px;border:1px solid #263e48;border-radius:9px;background:#020609;box-shadow:0 25px 70px #000,inset 0 0 35px #000}.sm-intro-rail i{height:34px;border-radius:4px;background:#075fd6;box-shadow:0 0 17px #075fd6;transition:background .5s,box-shadow .5s,transform .5s}.sm-intro-1 .sm-intro-rail i.ore,.sm-intro-2 .sm-intro-rail i.ore,.sm-intro-3 .sm-intro-rail i.ore,.sm-intro-4 .sm-intro-rail i.ore,.sm-intro-5 .sm-intro-rail i.ore{background:#ef4940;box-shadow:0 0 28px #ef4940;transform:scale(1.12)}.sm-intro-miner{position:absolute;left:2%;top:22px;width:58px;height:100px;opacity:0;transition:opacity .3s;animation:sm-walk 2.3s linear 2.9s both;filter:drop-shadow(0 12px 12px #000)}.sm-intro-2 .sm-intro-miner,.sm-intro-3 .sm-intro-miner,.sm-intro-4 .sm-intro-miner,.sm-intro-5 .sm-intro-miner{opacity:1}.sm-intro-miner i{position:absolute;display:block}.sm-intro-miner .helmet{left:10px;top:1px;width:38px;height:24px;border-radius:23px 23px 5px 5px;background:#ffd13f;box-shadow:0 0 13px #ffd13f99}.sm-intro-miner .face{left:16px;top:22px;width:28px;height:23px;background:#ddb080}.sm-intro-miner .body{left:8px;top:43px;width:42px;height:42px;background:#d2aa36}.sm-intro-miner .leg{top:79px;width:10px;height:24px;background:#283337;transform-origin:top}.sm-intro-miner .leg.l{left:12px;animation:sm-leg .38s infinite alternate}.sm-intro-miner .leg.r{right:12px;animation:sm-leg .38s infinite alternate-reverse}.sm-intro-miner .pick{left:39px;top:35px;width:5px;height:63px;background:#e2d4aa;transform:rotate(42deg);transform-origin:bottom}.sm-intro-3 .sm-intro-miner .pick{animation:sm-pick .58s infinite}.sm-intro-impact{position:absolute;left:64.5%;top:67px;width:90px;height:90px;opacity:0}.sm-intro-3 .sm-intro-impact,.sm-intro-4 .sm-intro-impact{animation:sm-impact 1.2s infinite}.sm-intro-impact i{position:absolute;left:43px;top:43px;width:5px;height:45px;background:#fff3b2;transform-origin:2px 2px;box-shadow:0 0 13px #fff}.sm-intro-impact i:nth-child(2){transform:rotate(60deg)}.sm-intro-impact i:nth-child(3){transform:rotate(120deg)}.sm-intro-impact i:nth-child(4){transform:rotate(180deg)}.sm-intro-impact i:nth-child(5){transform:rotate(240deg)}.sm-intro-impact i:nth-child(6){transform:rotate(300deg)}.sm-intro-title{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;opacity:0;transform:scale(.92);transition:opacity 1s,transform 1.2s;background:radial-gradient(ellipse at center,#0c1d20e8 0,#020508f8 63%)}.sm-intro-4 .sm-intro-title,.sm-intro-5 .sm-intro-title{opacity:1;transform:scale(1)}.sm-intro-title>span{color:#88e8dc;font-size:11px;font-weight:900;letter-spacing:.3em}.sm-intro-title h1{margin:12px 0 0;font:900 clamp(72px,12vw,190px)/.8 ui-monospace,monospace;letter-spacing:-.12em;text-shadow:0 0 55px #168b9a55}.sm-intro-title h1 span{color:#ffcc48}.sm-intro-title p{margin:26px 0;color:#b9cdca;font-size:15px;letter-spacing:.05em}.sm-enter{opacity:0!important;pointer-events:none!important;padding:12px 26px!important;border:1px solid #d8a847!important;border-radius:5px!important;background:#513e1d!important;color:#fff0b6!important;font:900 12px ui-monospace,monospace!important;letter-spacing:.08em!important}.sm-intro-5 .sm-enter{opacity:1!important;pointer-events:auto!important}.sm-skip{position:absolute!important;right:25px!important;top:22px!important;padding:7px 10px!important;border:1px solid #485b61!important;border-radius:4px!important;background:#081116c9!important;color:#9cb2b5!important;font:800 10px ui-monospace,monospace!important}.sm-skip:focus-visible,.sm-enter:focus-visible{outline:3px solid #a8f5ed!important;outline-offset:4px}
@keyframes sm-walk{0%{left:2%}100%{left:62%}}@keyframes sm-leg{from{transform:rotate(-19deg)}to{transform:rotate(19deg)}}@keyframes sm-pick{0%,100%{transform:rotate(-38deg)}48%{transform:rotate(42deg)}58%{transform:rotate(46deg)}72%{transform:rotate(-28deg)}}@keyframes sm-impact{0%,70%,100%{opacity:0;transform:scale(.3) rotate(0)}18%{opacity:1;transform:scale(1) rotate(12deg)}}
/* First launch: the seam expands, then its output raises two cities. */
.sm-copy-2{opacity:0;transform:translate(-50%,18px)}
.sm-intro-1 .sm-copy-0{opacity:1;transform:translate(-50%,0)}.sm-intro-1 .sm-copy-1{opacity:0;transform:translate(-50%,18px)}
.sm-intro-2 .sm-copy-0,.sm-intro-3 .sm-copy-0,.sm-intro-4 .sm-copy-0,.sm-intro-5 .sm-copy-0{opacity:0;transform:translate(-50%,-16px)}
.sm-intro-2 .sm-copy-1,.sm-intro-3 .sm-copy-1{opacity:1;transform:translate(-50%,0)}
.sm-intro-4 .sm-copy-1,.sm-intro-5 .sm-copy-1{opacity:0;transform:translate(-50%,-16px)}
.sm-intro-4 .sm-copy-2{opacity:1;transform:translate(-50%,0)}.sm-intro-5 .sm-copy-2{opacity:0;transform:translate(-50%,-16px)}
.sm-intro-rail i.seed,.sm-intro-1 .sm-intro-rail i.grow-1,.sm-intro-2 .sm-intro-rail i.grow-1,.sm-intro-2 .sm-intro-rail i.grow-2,.sm-intro-3 .sm-intro-rail i.grow-1,.sm-intro-3 .sm-intro-rail i.grow-2,.sm-intro-3 .sm-intro-rail i.grow-3,.sm-intro-4 .sm-intro-rail i.grow-1,.sm-intro-4 .sm-intro-rail i.grow-2,.sm-intro-4 .sm-intro-rail i.grow-3,.sm-intro-5 .sm-intro-rail i.grow-1,.sm-intro-5 .sm-intro-rail i.grow-2,.sm-intro-5 .sm-intro-rail i.grow-3{background:#ef4940;box-shadow:0 0 28px #ef4940;transform:scale(1.1)}
.sm-intro-city{position:absolute;z-index:2;bottom:108px;display:flex;align-items:flex-end;gap:4px;width:25%;height:76px;opacity:0}.sm-intro-city.west{left:1%}.sm-intro-city.east{right:1%;flex-direction:row-reverse}.sm-intro-city b{position:relative;display:block;flex:1;min-width:10px;height:36px;border:1px solid #ffb34f99;background:repeating-linear-gradient(0deg,#8b3f2a 0 8px,#4b2523 9px 12px);box-shadow:inset 0 0 0 2px #23171a,0 0 12px #ff75482e;transform:scaleY(0);transform-origin:bottom}.sm-intro-city b:after{content:"";position:absolute;inset:4px;background:repeating-linear-gradient(90deg,#ffd868 0 3px,transparent 3px 9px);opacity:.8}.sm-intro-city b:nth-child(2){height:52px}.sm-intro-city b:nth-child(3){height:72px}.sm-intro-city b:nth-child(4){height:43px}.sm-intro-city b:nth-child(5){height:61px}.sm-intro-city b:nth-child(6){height:30px}
.sm-intro-4 .sm-intro-city,.sm-intro-5 .sm-intro-city{opacity:1}.sm-intro-4 .sm-intro-city b,.sm-intro-5 .sm-intro-city b{animation:sm-city-rise .5s cubic-bezier(.15,.85,.2,1.18) forwards}.sm-intro-city b:nth-child(2){animation-delay:.32s!important}.sm-intro-city b:nth-child(3){animation-delay:.64s!important}.sm-intro-city b:nth-child(4){animation-delay:.96s!important}.sm-intro-city b:nth-child(5){animation-delay:1.28s!important}.sm-intro-city b:nth-child(6){animation-delay:1.6s!important}
.sm-intro-flow{position:absolute;z-index:3;top:94px;width:45%;height:12px;opacity:0}.sm-intro-flow.west{left:3%}.sm-intro-flow.east{right:3%}.sm-intro-flow i{position:absolute;top:0;width:11px;height:11px;border-radius:50%;background:#ffd94d;box-shadow:0 0 14px #ffd94d}.sm-intro-flow i:nth-child(2){animation-delay:-.18s!important}.sm-intro-flow i:nth-child(3){animation-delay:-.36s!important}.sm-intro-flow i:nth-child(4){animation-delay:-.54s!important}.sm-intro-4 .sm-intro-flow,.sm-intro-5 .sm-intro-flow{opacity:1}.sm-intro-4 .sm-intro-flow.west i,.sm-intro-5 .sm-intro-flow.west i{animation:sm-flow-west .72s linear infinite}.sm-intro-4 .sm-intro-flow.east i,.sm-intro-5 .sm-intro-flow.east i{animation:sm-flow-east .72s linear infinite}
.sm-intro-4 .sm-intro-title{opacity:0;pointer-events:none;transform:scale(.94)}.sm-intro-5 .sm-intro-title{opacity:1;transform:scale(1)}
.sm-intro-title{padding:3vh 4vw;gap:0}
.sm-intro-logo{width:min(440px,40vw);max-height:48vh;margin:8px 0 4px}
.sm-intro-title .sm-intro-logo+p{margin:2px 0 16px!important}
.sm-intro-tempo{margin:0 0 13px}
@keyframes sm-city-rise{0%{transform:scaleY(0);filter:brightness(2)}100%{transform:scaleY(1);filter:brightness(1)}}@keyframes sm-flow-west{0%{left:100%;opacity:0}12%,86%{opacity:1}100%{left:0;opacity:0}}@keyframes sm-flow-east{0%{left:0;opacity:0}12%,86%{opacity:1}100%{left:100%;opacity:0}}
@media(max-width:1100px){.sm-command{grid-template-columns:.9fr 1.1fr .9fr}.sm-matrix-wrap,.sm-strip-panel,.sm-actions{padding:11px}.sm-action{padding:7px!important;gap:7px!important}.sm-action kbd{width:26px;height:26px}.sm-action small{display:none}.sm-world-nav{bottom:12px}.sm-audio{bottom:12px}.sm-shift strong{font-size:15px}.sm-intro-rail{gap:5px}.sm-intro-miner{animation-name:sm-walk-small}@keyframes sm-walk-small{0%{left:2%}100%{left:61%}}}
@media(prefers-reduced-motion:reduce){.sm-intro-miner,.sm-intro-impact,.sm-intro-miner .leg,.sm-intro-miner .pick{animation-duration:.01ms!important;animation-iteration-count:1!important}.sm-action{transition:none}}
.sm-shift{margin-bottom:7px}.sm-skyline{display:grid;grid-template-columns:repeat(3,1fr) 20px repeat(3,1fr);align-items:end;gap:4px;height:27px;margin-top:6px;padding:3px 5px 0;border-bottom:1px solid #486066;background:linear-gradient(180deg,transparent,#07101499)}.sm-skyline i{display:block;height:calc(3px + min(var(--level),10) * 2px);min-height:3px;border:1px solid var(--tower);background:linear-gradient(90deg,#071014,var(--tower),#071014);box-shadow:0 0 8px var(--tower)}.sm-skyline b{align-self:center;color:#e9c467;font:900 12px ui-monospace,monospace;text-align:center}.sm-construction{display:block;margin-top:3px;color:#a8bdbc;font:800 8px ui-monospace,monospace;letter-spacing:.06em}
.sm-shell{grid-template-rows:78vh 22vh}.sm-command{grid-template-columns:minmax(520px,1.35fr) minmax(500px,1fr)}.sm-strip-panel{padding:12px 20px}.sm-actions{padding:12px 18px}.sm-command .sm-shift{display:grid;grid-template-columns:1fr auto;column-gap:14px;align-items:end}.sm-command .sm-shift>.sm-kicker,.sm-command .sm-shift>strong{grid-column:1}.sm-command .sm-shift>p{grid-column:1}.sm-command .sm-skyline{grid-column:2;grid-row:1/4;width:240px;height:46px}.sm-command .sm-construction{grid-column:2;text-align:right}.sm-command .sm-action{min-height:49px!important}.sm-command .sm-action.primary{grid-row:2/4}.sm-final-stage .sm-vignette{background:linear-gradient(180deg,#0002,#0000 72%,#0006),radial-gradient(ellipse at center,transparent 50%,#0005)}
.sm-finale-overlay{position:absolute;z-index:9;left:50%;top:13%;width:min(800px,78vw);transform:translateX(-50%);text-align:center;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-shadow:0 3px 0 #000,0 0 24px #76f4e5}.sm-finale-overlay>span{display:block;color:#8df2e4;font-size:12px;font-weight:900;letter-spacing:.35em}.sm-finale-overlay>strong{display:block;margin-top:8px;color:#fff3c2;font-size:clamp(27px,4vw,62px);line-height:1;letter-spacing:-.055em}.sm-finale-overlay>small{display:block;margin-top:13px;color:#d3e8e4;font-size:11px;letter-spacing:.1em}.sm-finale-overlay.armed>strong{animation:sm-last-strike 1.05s ease-in-out infinite}.sm-finale-overlay.complete{top:10%}.sm-finale-facts{display:flex;justify-content:center;gap:8px;margin-top:15px}.sm-finale-facts i{min-width:110px;padding:7px 10px;border-top:1px solid #e8c86c99;background:linear-gradient(180deg,#17252bc4,transparent);color:#a6c0c1;font-size:8px;font-style:normal;font-weight:900;letter-spacing:.12em}.sm-finale-facts b{display:block;margin-bottom:3px;color:#fff0ad;font-size:16px;letter-spacing:0}@keyframes sm-last-strike{0%,100%{transform:scale(1);filter:brightness(1)}50%{transform:scale(1.035);filter:brightness(1.35)}}
.sm-qam-loading{padding:22px;color:#8fe7db;font:900 11px ui-monospace,monospace;letter-spacing:.16em}.sm-qam{display:flex;flex-direction:column;gap:9px;padding:1px 1px 12px;color:#dceae8;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.sm-qam header{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;color:#78999d;font-size:8px;font-weight:900;letter-spacing:.12em}.sm-qam header strong{max-width:58%;overflow:hidden;color:#ffe097;font-size:9px;text-align:right;text-overflow:ellipsis;white-space:nowrap}.sm-qam-matrix{width:100%;aspect-ratio:8/5;padding:5px;border:1px solid #9d7138;border-radius:7px;background:#020507;box-sizing:border-box;box-shadow:inset 0 0 22px #000,0 0 20px #f5b3432e}.sm-qam-matrix .sm-matrix{width:100%;height:100%;filter:brightness(1.26) saturate(1.2)}.sm-qam-rail{display:grid;grid-template-columns:repeat(17,1fr);gap:2px;padding:5px;border:1px solid #425b62;border-radius:4px;background:#020507}.sm-qam-rail i{height:10px;border-radius:2px}.sm-qam-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.sm-qam-stats i{padding:7px 6px;border:1px solid #344a50;border-radius:4px;background:#0b171c;font-style:normal}.sm-qam-stats span,.sm-qam-stats b{display:block}.sm-qam-stats span{color:#6f969a;font-size:7px;font-weight:900;letter-spacing:.12em}.sm-qam-stats b{margin-top:3px;color:#f6e8b5;font-size:9px}.sm-qam-tempo{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}.sm-qam-tempo button,.sm-qam-controls button,.sm-qam-open{min-width:0!important;min-height:34px!important;border:1px solid #40575d!important;border-radius:4px!important;background:#0c1a20!important;color:#8aa4a8!important;font:900 8px ui-monospace,monospace!important}.sm-qam-tempo button b,.sm-qam-tempo button small{display:block}.sm-qam-tempo button small{margin-top:2px;color:#59777c}.sm-qam-tempo button.active{border-color:#c59a48!important;background:#493b21!important;color:#ffe29a!important;box-shadow:0 0 14px #f0bd4935!important}.sm-qam-controls{display:grid;grid-template-columns:repeat(2,1fr);gap:4px}.sm-qam-controls button.on{border-color:#5ad8c5!important;background:#173b3a!important;color:#e9fffb!important}.sm-qam-open{width:100%!important;min-height:43px!important;border-color:#b58b43!important;background:linear-gradient(145deg,#534224,#241d12)!important;color:#ffe5a0!important;font-size:10px!important;letter-spacing:.08em!important}.sm-qam button:focus-visible{outline:3px solid #9df7eb!important;outline-offset:2px}
/* The fullscreen game mirrors the HTML concept's 78/22 command deck: status, physical strip, actions. */
.sm-shell{grid-template-rows:78vh 22vh}.sm-command{grid-template-columns:minmax(285px,.76fr) minmax(430px,1.24fr) minmax(350px,1fr)}.sm-status-panel,.sm-strip-panel,.sm-actions{position:relative;min-width:0;padding:12px 16px;border-right:1px solid #33484f}.sm-status-panel{display:flex;flex-direction:column;justify-content:center}.sm-status-panel .sm-shift{display:block;margin:0}.sm-status-panel .sm-skyline{width:100%;height:31px;margin-top:7px}.sm-status-panel .sm-construction{display:block;text-align:left}.sm-strip-panel{padding:12px 17px}.sm-actions{padding:11px 14px;border-right:0}.sm-command .sm-action{min-height:49px!important}.sm-command .sm-action.primary{grid-row:2/4}.sm-world{image-rendering:auto}.sm-world-stage:after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(0,0,0,.035) 3px 4px)}
.sm-qam{padding:7px 6px 14px;border:1px solid #385159;border-radius:9px;background:linear-gradient(160deg,#15262d,#071015);box-shadow:inset 0 1px #ffffff0b,0 13px 30px #0005}.sm-qam header{padding:3px 3px 1px}.sm-qam-matrix{box-shadow:inset 0 0 22px #000,0 0 22px #f5b3433b}.sm-qam-matrix .sm-matrix{filter:brightness(1.4) saturate(1.28) contrast(1.08)}.sm-qam-rail{box-shadow:inset 0 0 12px #000,0 0 13px #4de6d426}.sm-qam-rail i{height:12px}.sm-qam-stats i{background:linear-gradient(145deg,#102128,#081317)}
.sm-world{object-fit:fill}
@media(max-width:1280px){.sm-command{grid-template-columns:minmax(250px,.72fr) minmax(360px,1.2fr) minmax(310px,1fr)}.sm-status-panel,.sm-strip-panel,.sm-actions{padding:9px 11px}.sm-action{padding:7px!important;gap:7px!important}.sm-action small{display:none}.sm-status-panel .sm-shift strong{font-size:13px}.sm-meta{font-size:7px}.sm-settings-line span{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
/* Canonical deep17 geometry. Keep this block synchronized with deep17.css. */
.sm-world-stage{background:#071117}.sm-world{object-fit:fill;image-rendering:pixelated}.sm-vignette{background:radial-gradient(ellipse at 50% 57%,transparent 40%,#020508b0 100%),repeating-linear-gradient(0deg,#0000 0 3px,#00000013 3px 4px)}
.sm-hud{inset:23px 25px auto;gap:20px;text-shadow:0 2px 0 #000,0 0 12px #000}.sm-hud-left,.sm-hud-right{gap:4px}.sm-hud-left span,.sm-hud-right span{font-size:10px;letter-spacing:.16em;color:#8fe6d9}.sm-hud-left strong{font-size:clamp(18px,2vw,30px);line-height:1;color:#fff3b0;letter-spacing:-.035em}.sm-hud-right strong{font-size:clamp(30px,4vw,58px);line-height:1;letter-spacing:-.07em}.sm-hud-left small,.sm-hud-right small,.sm-world-nav{display:none}
.sm-score-hud{left:25px;top:93px;padding:8px 12px;border-left:3px solid #efc25c}.sm-score-hud span{font-size:7px;letter-spacing:.17em}.sm-score-hud strong{font-size:24px}.sm-score-hud small{margin-top:3px;font-size:7px}.sm-top-controls{top:18px;gap:5px}.sm-tempo,.sm-world-bar-mode{padding:3px;border-radius:5px;box-shadow:none}.sm-tempo button,.sm-world-bar-mode button{padding:4px 6px!important;font-size:7px!important}.sm-tempo button{min-width:61px!important}.sm-world-bar-mode button{min-width:72px!important}.sm-tempo button small,.sm-world-bar-mode button small{margin-top:1px;font-size:6px}.sm-audio{right:22px;bottom:17px;gap:7px}.sm-audio button{min-height:0;padding:8px 11px!important;border-radius:4px!important;font-size:9px!important}
.sm-command{grid-template-columns:minmax(180px,.7fr) minmax(390px,1.55fr) minmax(310px,1fr);border-top:4px solid #9c7438;background:linear-gradient(180deg,#26343b 0,#17242a 7%,#0b1217 100%)}.sm-command:before{inset:8px;background:repeating-linear-gradient(135deg,#ffffff05 0 1px,transparent 1px 6px)}.sm-status-panel,.sm-strip-panel,.sm-actions{padding:12px 16px;border-right:1px solid #35464d}.sm-status-panel{justify-content:center}.sm-kicker,.sm-strip-head span{font-size:9px;letter-spacing:.17em}.sm-status-panel .sm-shift>strong{display:block;max-width:230px;margin:6px 0 8px;color:#f8d878;font:900 clamp(15px,1.5vw,21px)/1.15 ui-monospace,monospace}.sm-status-panel .sm-shift p{display:flex;flex-wrap:wrap;gap:5px 13px;margin:0;color:#83d9cd;font-size:9px}.sm-status-panel .sm-shift p span:last-child{width:100%;color:#96a8ad}.sm-status-panel .sm-skyline{height:18px;margin-top:5px}.sm-construction{margin-top:4px;font-size:7px}
.sm-strip-panel{justify-content:center}.sm-strip-head{margin-bottom:12px}.sm-strip-head strong{font-size:10px}.sm-rail{gap:4px;padding:9px 10px;border-color:#465860;border-radius:7px}.sm-rail i{min-height:0;aspect-ratio:1}.sm-strip-scale{display:grid;grid-template-columns:3fr 11fr 3fr;margin-top:10px;font-size:7px}.sm-progress{height:6px;margin-top:9px}.sm-meta{margin-top:6px;font-size:7px}
.sm-actions{grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr 1fr;gap:7px}.sm-actions-title{display:none}.sm-action-audio{grid-column:1/-1;display:grid;grid-template-columns:auto 1fr 1fr;align-items:center;gap:6px}.sm-action-audio>span{color:#79969b;font:900 7px ui-monospace,monospace;letter-spacing:.15em}.sm-action-audio button{min-width:0!important;min-height:27px!important;padding:5px 7px!important;border:1px solid #43565d!important;border-radius:4px!important;background:#09141a!important;color:#8fa7ab!important;font:900 8px ui-monospace,monospace!important;letter-spacing:.04em!important}.sm-action-audio button.on{border-color:#5bd6c4!important;background:#153b39!important;color:#edfffb!important;box-shadow:0 0 13px #45dec52b!important}.sm-action{min-height:0!important;padding:7px 9px!important;border-color:#43545b!important;border-radius:7px!important;background:linear-gradient(145deg,#26363d,#111a1f)!important;box-shadow:inset 0 1px #ffffff15,0 5px 0 #05090c,0 8px 18px #0006!important}.sm-action.primary{grid-column:1/-1;grid-row:auto!important}.sm-action kbd{flex:0 0 27px;width:auto;height:auto;aspect-ratio:1;border:2px solid #3b8f66;border-radius:50%;background:radial-gradient(circle at 35% 28%,#8af0ad,#2aab64 55%,#0b5931);color:#06150c;font-size:14px;box-shadow:inset 0 -3px #063b20,0 0 12px #48de8545}.sm-action:nth-of-type(2) kbd{border-color:#3e83b6;background:radial-gradient(circle at 35% 28%,#8ed5ff,#237ebd 55%,#0c456d);box-shadow:inset 0 -3px #093854,0 0 12px #47b5ff45}.sm-action:nth-of-type(3) kbd{border-color:#b99424;background:radial-gradient(circle at 35% 28%,#fff09a,#d7aa24 55%,#7b5808);box-shadow:inset 0 -3px #593c04,0 0 12px #ffcf3f45}.sm-action b{font-size:10px;letter-spacing:.04em}.sm-action small{margin-top:3px;font-size:8px}.sm-settings-line{display:none}
/* Decky companion: direct port of deep17's pocket control room. */
.sm-qam{gap:6px;padding:10px;border:1px solid #4a626a;border-radius:10px;background:linear-gradient(160deg,#17262e,#081116);box-shadow:0 18px 45px #0008,0 0 0 5px #101c22}.sm-qam-title{display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:6px;padding:2px 2px 3px;color:#8ea7ad;font-size:8px;font-weight:900;letter-spacing:.11em}.sm-qam-title>span{display:grid;place-items:center;width:19px;height:19px;border:1px solid #40565d;border-radius:50%;color:#d5e5e3}.sm-qam-title>i{color:#79e5d6;font-size:7px;font-style:normal}.sm-qam-matrix-panel{padding:7px;border:1px solid #765f3b;border-radius:7px;background:#03080b;box-shadow:inset 0 0 26px #000,0 0 22px #63ead51f}.sm-qam-matrix-panel header{padding:0;margin:0 0 5px;color:#ffd58e;text-shadow:0 0 9px #ffb34f66}.sm-qam-matrix-panel header strong{color:#9affeb;text-shadow:0 0 10px #50efcf}.sm-qam-matrix{padding:0;border:0;border-radius:2px;box-shadow:inset 0 0 22px #000,0 0 24px #ffad4f42,0 0 38px #63ead527}.sm-qam-matrix .sm-matrix{display:block;width:100%;height:100%;image-rendering:auto;filter:saturate(1.34) brightness(1.28) contrast(1.05)}.sm-qam-pages{display:flex;align-items:center;justify-content:center;gap:5px;margin-top:8px}.sm-qam-pages i{display:block;width:12px;height:3px;border-radius:5px;background:#57442f}.sm-qam-pages i.active{background:#75f0d7;box-shadow:0 0 9px #75f0d7}.sm-qam-pages span{margin-left:5px;color:#b8eee5;font-size:7px;font-weight:850;letter-spacing:.12em;text-shadow:0 0 8px #5debd3}.sm-qam-matrix-panel footer{display:flex;justify-content:space-between;margin-top:6px;color:#78949a;font-size:6px;font-weight:900;letter-spacing:.12em}.sm-qam-stats{gap:4px;margin-top:1px}.sm-qam-stats i{padding:6px;border-color:#344a50;background:#0a161b}.sm-qam-stats span{font-size:6px}.sm-qam-stats b{margin-top:2px;color:#f4e3ab;font-size:8px}.sm-qam-tempo{gap:3px}.sm-qam-tempo button,.sm-qam-controls button{min-height:31px!important;padding:6px 3px!important;font-size:7px!important}.sm-qam-controls{gap:3px}.sm-qam-open{min-height:38px!important;margin-top:0!important;padding:8px!important;font-size:8px!important}.sm-qam-rail{display:none}
.sm-app{width:100vw;height:100vh;z-index:2147483000}.sm-qam-volume{display:grid;grid-template-columns:minmax(0,1fr);gap:3px;padding:6px 8px;border:1px solid #344a50;border-radius:5px;background:#081317}.sm-qam-volume>div{width:100%!important;max-width:100%!important;min-width:0!important;min-height:40px!important;padding:0!important}.sm-qam-volume label,.sm-qam-volume [class*=Label]{max-width:100%!important;color:#d9e8e5!important;font:900 8px ui-monospace,monospace!important;letter-spacing:.08em}.sm-qam-volume input{display:block;width:100%!important;max-width:100%!important;margin:0!important;accent-color:#71e6d4}.sm-qam-matrix{aspect-ratio:4/3}.sm-qam-matrix-panel{width:100%}
/* Decky side-panel containment: never inherit an oversized Steam page width. */
.sm-qam,.sm-qam *{box-sizing:border-box}.sm-qam{width:100%;max-width:100%;min-width:0;overflow:hidden;align-items:stretch;text-align:center}.sm-qam>*{width:100%;max-width:100%;min-width:0;margin-left:auto;margin-right:auto}.sm-qam-title{grid-template-columns:22px minmax(0,1fr) auto}.sm-qam-title strong,.sm-qam-title i{min-width:0;text-align:center}.sm-qam-matrix-panel header,.sm-qam-matrix-panel footer{width:100%;max-width:100%;min-width:0}.sm-qam-matrix-panel header span,.sm-qam-matrix-panel header strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sm-qam-stats,.sm-qam-tempo,.sm-qam-controls,.sm-qam-volume{width:100%;max-width:100%;min-width:0}.sm-qam-stats>*{min-width:0;text-align:center}.sm-qam-tempo{grid-template-columns:repeat(4,minmax(0,1fr))}.sm-qam-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.sm-qam button{max-width:100%!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sm-qam-bar-mode{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px;padding:5px;border:1px solid #344a50;border-radius:5px;background:#081317}.sm-qam-bar-mode>span{grid-column:1/-1;color:#77979b;font-size:6px;font-weight:900;letter-spacing:.14em}.sm-qam-bar-mode button{min-width:0!important;min-height:33px!important;padding:5px 2px!important;border:1px solid #40575d!important;border-radius:4px!important;background:#0c1a20!important;color:#829da1!important;font:900 7px ui-monospace,monospace!important}.sm-qam-bar-mode button b,.sm-qam-bar-mode button small{display:block}.sm-qam-bar-mode button small{margin-top:2px;color:#5f777c;font-size:5px}.sm-qam-bar-mode button.active{border-color:#6ddccc!important;background:#173b3a!important;color:#effffb!important;box-shadow:0 0 12px #4de0ca2e!important}.sm-qam-bar-mode button.active small{color:#a2d9d0}.sm-qam-footer-actions{display:grid;grid-template-columns:minmax(0,.72fr) minmax(0,1.28fr);gap:4px}.sm-qam-footer-actions button{width:100%!important;min-width:0!important;min-height:38px!important;margin:0!important;padding:7px 4px!important;border:1px solid #40575d!important;border-radius:4px!important;background:#0c1a20!important;color:#9fb5b7!important;font:900 8px ui-monospace,monospace!important;letter-spacing:.05em!important}.sm-qam-footer-actions .sm-qam-open{border-color:#b58b43!important;background:linear-gradient(145deg,#534224,#241d12)!important;color:#ffe5a0!important}.sm-qam-footer-actions .sm-qam-reset{border-color:#77545a!important;color:#d9b3b5!important}.sm-qam-reset-confirm{display:grid;gap:6px;padding:9px;border:1px solid #9c5959;border-radius:6px;background:#251417;text-align:center}.sm-qam-reset-confirm strong{color:#ffd1c8;font-size:10px;letter-spacing:.08em}.sm-qam-reset-confirm small{color:#b99d9d;font-size:7px;line-height:1.4}.sm-qam-reset-confirm>div{display:grid;grid-template-columns:1fr 1fr;gap:5px}.sm-qam-reset-confirm button{min-width:0!important;min-height:31px!important;border:1px solid #56666b!important;border-radius:4px!important;background:#122127!important;color:#dce9e7!important;font:900 8px ui-monospace,monospace!important}.sm-qam-reset-confirm button.danger{border-color:#b86666!important;background:#52272b!important;color:#ffe0d9!important}
.sm-qam-title{grid-template-columns:42px minmax(0,1fr) auto}
/* Large-screen command hierarchy: these are gameplay controls, not tiny HUD metadata. */
.sm-control-group{display:flex;flex-direction:column;gap:4px}.sm-control-group>span{padding-left:5px;color:#9ab2b5;font:900 7px ui-monospace,monospace;letter-spacing:.17em;text-shadow:0 2px 4px #000}.sm-world-bar-mode button.luminous{border-left:2px solid #2e9cff!important}.sm-world-bar-mode button.contrasted{border-left:2px solid #ff7842!important}.sm-world-bar-mode button.luminous.active{background:linear-gradient(135deg,#16465d,#173b3a)!important;color:#f0fffd!important;box-shadow:inset 0 0 16px #46e8d33a,0 0 13px #2e9cff2e!important}.sm-world-bar-mode button.contrasted.active{background:linear-gradient(135deg,#42291d,#17181b)!important;color:#ffe7c9!important;box-shadow:inset 0 0 16px #ff784226,0 0 13px #ff784229!important}.sm-world-bar-mode button.luminous.active small{color:#a9f1e7}.sm-world-bar-mode button.contrasted.active small{color:#ffb28e}
@media(min-width:1500px){.sm-top-controls{top:20px;gap:14px}.sm-control-group{gap:5px}.sm-control-group>span{font-size:11px}.sm-tempo,.sm-world-bar-mode{padding:5px;border-width:2px;border-radius:8px;box-shadow:0 10px 26px #0009}.sm-tempo button,.sm-world-bar-mode button{min-height:58px!important;padding:8px 12px!important;font-size:14px!important}.sm-tempo button{min-width:112px!important}.sm-world-bar-mode button{min-width:160px!important}.sm-tempo button small,.sm-world-bar-mode button small{margin-top:4px;font-size:9px}.sm-action-audio>span{font-size:10px}.sm-action-audio button{min-height:36px!important;padding:8px 11px!important;font-size:12px!important}.sm-action{padding:10px 16px!important;gap:15px!important}.sm-action kbd{flex-basis:52px;width:52px;height:52px;font-size:23px}.sm-action b{font-size:17px}.sm-action small{margin-top:5px;font-size:12px}.sm-actions{grid-template-rows:auto minmax(0,1fr) minmax(0,1fr)}}
/* Steam's route is shorter than the outer 16:9 viewport because its chrome remains
   mounted. Size the game from that real route box: viewport units otherwise add
   the Steam bars a second time and force vertical scrolling. */
.sm-app{position:absolute;inset:0;width:100%;height:100%;max-width:100%;max-height:100%;min-width:0;min-height:0;overflow:hidden}
.sm-shell{width:100%;height:100%;min-width:0;min-height:0;grid-template-rows:minmax(0,78fr) minmax(0,22fr);overflow:hidden}
.sm-world-stage,.sm-command,.sm-status-panel,.sm-strip-panel,.sm-actions{min-height:0;overflow:hidden}
`;

function Button({ className = "", onGamepadFocus, onGamepadBlur, ...props }) {
    const [focused, setFocused] = SP_REACT.useState(false);
    return SP_JSX.jsx(DFL.Button, { ...props, className: `${className}${focused ? " sm-gamepad-focus" : ""}`, onGamepadFocus: (event) => { setFocused(true); onGamepadFocus?.(event); }, onGamepadBlur: (event) => { setFocused(false); onGamepadBlur?.(event); } });
}
const hex = (value) => `rgb(${value.join(",")})`;
const veinPercent = (status) => status.reward_pending || status.complete
    ? "100"
    : status.progress >= .99
        ? Math.min(99.9, status.progress * 100).toFixed(1)
        : String(Math.floor(status.progress * 100));
const formatDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0)
        return "—";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.max(1, Math.round((seconds % 3600) / 60));
    return hours ? `~ ${hours}h ${minutes}m` : `~ ${minutes} min`;
};
const formatActive = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};
const formatScore = (value) => value.toLocaleString("en-US");
const TEMPOS = ["CHILL", "NORMAL", "NERVOUS", "COCAINE"];
const TEMPO_DETAILS = ["×1 · 63H", "×2 · 31H30", "×3 · 21H", "×4 · 15H45"];
const QAM_PAGES = ["SETTLEMENT", "CREW", "TWIN CITY", "DEPOSIT", "PROGRESSION"];
const sharedAudio = new StripMineAudio();
function ScoreCascade({ status }) {
    const event = status.last_cashout;
    if (!event || !status.cue_active || !status.cue_kind.startsWith("cashout"))
        return null;
    return SP_JSX.jsxs("div", { className: `sm-score-cascade ${event.total >= status.best_delivery ? "record" : ""}`, style: { "--score-ms": `${status.score_presentation_ms}ms` }, children: [SP_JSX.jsx("span", { children: event.label }), SP_JSX.jsxs("strong", { children: ["+", formatScore(event.total)] }), SP_JSX.jsx("div", { children: event.steps.map((step, index) => SP_JSX.jsx("i", { style: { animationDelay: `${Math.round(index * status.score_presentation_ms * .42)}ms` }, children: index ? `×${step.multiplier} ${step.label}` : `${step.after} ${step.label}` }, `${step.label}-${index}`)) }), SP_JSX.jsxs("small", { children: [event.workers.length > 1 ? `${event.workers.length}-MINER CONVOY · ` : "", "CITY VALUE ", formatScore(status.city_value)] })] }, event.seq);
}
function FinaleOverlay({ status }) {
    const armed = status.reward_pending && status.cue_kind === "finale_armed";
    if (!armed && !status.complete)
        return null;
    const elapsed = status.finale_elapsed;
    const act = armed ? ["THE LAST SHIFT", "FOUR MINERS · ONE ANCIENT CORE"] : elapsed < 5
        ? ["THE LAST STRIKE", "THE CORE REMEMBERS"] : elapsed < 20
        ? ["THE CITY RISES", "LIGHT BECOMES A HOME"] : ["METROPOLIS COMPLETE", "THE BLUE HAS BECOME A CITY"];
    const skylineFloors = status.city.reduce((total, plot) => total + (plot?.level ?? 0) * 2, 0);
    return SP_JSX.jsxs("div", { className: `sm-finale-overlay${armed ? " armed" : elapsed >= 20 ? " complete" : ""}`, children: [SP_JSX.jsx("span", { children: act[0] }), SP_JSX.jsx("strong", { children: armed ? "PRESS A · LAST STRIKE" : act[1] }), armed ? SP_JSX.jsx("small", { children: "The strike resolves automatically if the city must finish alone." }) : elapsed >= 20 ? SP_JSX.jsxs("div", { className: "sm-finale-facts", children: [SP_JSX.jsxs("i", { children: [SP_JSX.jsx("b", { children: formatScore(status.city_value) }), "CITY VALUE"] }), SP_JSX.jsxs("i", { children: [SP_JSX.jsx("b", { children: "30" }), "VEINS"] }), SP_JSX.jsxs("i", { children: [SP_JSX.jsx("b", { children: "4" }), "LIGHT MINERS"] }), SP_JSX.jsxs("i", { children: [SP_JSX.jsx("b", { children: skylineFloors }), "FLOORS"] })] }) : SP_JSX.jsx("small", { children: elapsed < 5 ? "Three fractures. One breath of silence." : "Fragments are feeding the final towers." })] });
}
function Workshop({ status, onClose, onBuy }) {
    const entries = [
        { kind: "crew", icon: "⛏", title: "CREW", copy: "+25% payload per miner" },
        { kind: "logistics", icon: "⇄", title: "LOGISTICS", copy: "+8% travel · +12% extraction" },
        { kind: "industry", icon: "♜", title: "INDUSTRY", copy: "+25% foundry multiplier" },
    ];
    return SP_JSX.jsx("div", { className: "sm-workshop", children: SP_JSX.jsxs("div", { className: "sm-workshop-card", children: [SP_JSX.jsxs("header", { children: [SP_JSX.jsx("span", { children: "CITY WORKSHOP" }), SP_JSX.jsxs("strong", { children: [formatScore(status.ore), " ORE"] }), SP_JSX.jsx(Button, { onClick: onClose, children: "CLOSE" })] }), SP_JSX.jsx("div", { className: "sm-upgrades", children: entries.map((entry) => { const level = status.upgrades[entry.kind]; const cost = status.upgrade_costs[entry.kind]; return SP_JSX.jsxs("div", { className: "sm-upgrade", children: [SP_JSX.jsx("i", { children: entry.icon }), SP_JSX.jsxs("span", { children: [SP_JSX.jsxs("b", { children: [entry.title, " \u00B7 LV.", level] }), SP_JSX.jsx("small", { children: entry.copy }), SP_JSX.jsx("em", { children: Array.from({ length: status.max_upgrade_level }, (_, index) => SP_JSX.jsx("u", { className: index < level ? "on" : "" }, index)) })] }), SP_JSX.jsx(Button, { disabled: cost === null || status.ore < cost, onClick: () => onBuy(entry.kind), children: cost === null ? "MAX" : `${formatScore(cost)} ORE` })] }, entry.kind); }) }), SP_JSX.jsx("footer", { children: "Spend ore to compound the city. Lifetime City Value never decreases." })] }) });
}
function Game() {
    const [status, setStatus] = SP_REACT.useState(null);
    const [error, setError] = SP_REACT.useState("");
    const [showIntro, setShowIntro] = SP_REACT.useState(false);
    const [music, setMusic] = SP_REACT.useState(sharedAudio.musicEnabled);
    const [effects, setEffects] = SP_REACT.useState(sharedAudio.effectsEnabled);
    const [musicVolume] = SP_REACT.useState(Math.round(sharedAudio.musicVolume * 100));
    const [effectsVolume] = SP_REACT.useState(Math.round(sharedAudio.effectsVolume * 100));
    const [resetConfirm, setResetConfirm] = SP_REACT.useState(false);
    const [showWorkshop, setShowWorkshop] = SP_REACT.useState(false);
    const [controlSource, setControlSource] = SP_REACT.useState("waiting");
    const [toast, setToast] = SP_REACT.useState(null);
    const audio = sharedAudio;
    const introInitialized = SP_REACT.useRef(false);
    const strikePending = SP_REACT.useRef(false);
    SP_REACT.useEffect(() => {
        audio.setScreenActive(true);
        return () => audio.setScreenActive(false);
    }, [audio]);
    const acceptStatus = SP_REACT.useCallback((next) => {
        setStatus((previous) => {
            if (previous && next.cue_seq > previous.cue_seq) {
                if (next.cue_kind.startsWith("cashout"))
                    setToast(null);
                else
                    setToast({ seq: next.cue_seq, label: next.cue_label });
            }
            return next;
        });
        audio.onStatus(next);
        setMusic(audio.musicEnabled);
        setEffects(audio.effectsEnabled);
    }, [audio]);
    SP_REACT.useEffect(() => {
        let alive = true;
        let pending = false;
        const refresh = () => {
            if (pending)
                return;
            pending = true;
            void getStatus().then((next) => {
                if (!alive)
                    return;
                acceptStatus(next);
                if (!introInitialized.current) {
                    introInitialized.current = true;
                    setShowIntro(!next.intro_seen);
                }
            }).catch((reason) => { if (alive)
                setError(String(reason)); }).finally(() => { pending = false; });
        };
        refresh();
        const timer = window.setInterval(refresh, 120);
        return () => { alive = false; window.clearInterval(timer); };
    }, [acceptStatus]);
    const completeIntro = SP_REACT.useCallback(() => {
        setShowIntro(false);
        introInitialized.current = true;
        void setSetting("intro_seen", true).then(acceptStatus).catch(() => undefined);
    }, [acceptStatus]);
    const apply = async (work) => {
        try {
            acceptStatus(await work);
            setError("");
        }
        catch (reason) {
            setError(String(reason));
        }
    };
    const signalStrike = SP_REACT.useCallback(async () => {
        if (strikePending.current)
            return;
        strikePending.current = true;
        try {
            const result = await strike();
            acceptStatus(result.status);
            if (result.result === "cooldown")
                return;
            setError("");
        }
        catch (reason) {
            setError(String(reason));
        }
        finally {
            strikePending.current = false;
        }
    }, [acceptStatus]);
    const convoy = SP_REACT.useCallback(() => { void toggleConvoy().then(acceptStatus).catch((reason) => setError(String(reason))); }, [acceptStatus]);
    const overcharge = SP_REACT.useCallback(() => { void activateOvercharge().then((result) => acceptStatus(result.status)).catch((reason) => setError(String(reason))); }, [acceptStatus]);
    SP_REACT.useEffect(() => {
        if (showIntro)
            return;
        const controls = new StripMineControls({
            onSource: setControlSource,
            onAction: (action) => {
                if (action === "strike")
                    void signalStrike();
                else if (action === "convoy")
                    convoy();
                else
                    overcharge();
            },
        });
        controls.start();
        return () => controls.stop();
    }, [convoy, overcharge, showIntro, signalStrike]);
    SP_REACT.useEffect(() => {
        const onKey = (event) => {
            if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || showIntro)
                return;
            if (event.target?.closest("button,input,select,textarea"))
                return;
            if (event.code === "KeyA") {
                event.preventDefault();
                void signalStrike();
            }
            if (event.code === "KeyX") {
                event.preventDefault();
                convoy();
            }
            if (event.code === "KeyY") {
                event.preventDefault();
                overcharge();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [overcharge, convoy, showIntro, signalStrike]);
    if (!status)
        return SP_JSX.jsxs("div", { className: "sm-app", children: [SP_JSX.jsx("style", { children: styles }), SP_JSX.jsx("div", { className: "sm-reset-confirm", children: SP_JSX.jsxs("div", { className: "sm-reset-card", children: [SP_JSX.jsx("h2", { children: "Waking the mine\u2026" }), SP_JSX.jsx("p", { children: error || "Reading the saved expedition." })] }) })] });
    const ore = hex(status.deposit_color);
    const lead = status.workers[0];
    const movement = lead?.held ? "WAITING AT GATE" : lead?.outbound ? "OUTBOUND" : "RETURNING LOADED";
    const nextReward = status.age === 0 && status.worker_count < 4 ? "NEW MINER" : status.age > 0 && status.deposit < status.worker_count ? `${status.rank_name.toUpperCase()} RANK` : "CITY UPGRADE";
    const ledState = status.hardware_owner === "SignalBar" ? "SIGNALBAR EVENT · BAR YIELDED" : status.hardware_owner === "other" ? "BAR RELEASED" : status.hardware_available ? status.led_enabled ? `PHYSICAL BAR LIVE · ${status.optical_bar ? "CONTRASTED" : "LUMINOUS"}` : "BAR DISPLAY OFF" : `SCREEN SIMULATION · ${status.optical_bar ? "CONTRASTED" : "LUMINOUS"}`;
    const skylineFloors = status.city.reduce((total, plot) => total + (plot?.level ?? 0) * 2, 0);
    const constructionLevel = status.age * 2 + (status.deposit >= 3 ? 2 : 1) + status.upgrades.industry;
    const constructionName = ["FOUNDRY", "GUILD HOUSE", "OBSERVATORY"][status.deposit % 3];
    const finaleArmed = status.reward_pending && status.cue_kind === "finale_armed";
    const finaleActive = finaleArmed || status.complete;
    const strikeResult = status.cue_active ? status.cue_kind === "critical" ? "PERFECT SIGNAL ×3" : status.cue_kind === "strike" ? "SIGNAL LOCKED ×1.5" : status.cue_kind === "miss" ? "DISTANT ECHO +PROGRESS" : "" : "";
    const progressLabel = veinPercent(status);
    return SP_JSX.jsxs(DFL.Focusable, { className: "sm-app", navEntryPreferPosition: DFL.NavEntryPositionPreferences.PREFERRED_CHILD, style: { "--ore": ore }, children: [SP_JSX.jsx("style", { children: styles }), showIntro ? SP_JSX.jsx(Intro, { onComplete: completeIntro, tempo: status.tempo, onTempo: (value) => void setTempo(value).then(setStatus) }) : null, SP_JSX.jsxs("div", { className: "sm-shell", children: [SP_JSX.jsxs("section", { className: `sm-world-stage${finaleActive ? " sm-final-stage" : ""}`, children: [SP_JSX.jsx(World, { status: status }), SP_JSX.jsx("div", { className: "sm-vignette" }), !finaleActive ? SP_JSX.jsxs(SP_JSX.Fragment, { children: [SP_JSX.jsxs("div", { className: "sm-hud", children: [SP_JSX.jsxs("div", { className: "sm-hud-left", children: [SP_JSX.jsxs("span", { children: ["AGE ", status.age + 1, " \u00B7 ", status.age_name.toUpperCase()] }), SP_JSX.jsx("strong", { children: status.deposit_name.toUpperCase() }), SP_JSX.jsx("small", { children: status.deposit_story })] }), SP_JSX.jsxs("div", { className: "sm-hud-right", children: [SP_JSX.jsx("span", { children: lead ? `${lead.side === "left" ? "W" : "E"}${Math.floor(lead.id / 2) + 1} ${movement} · LED ${Math.round(lead.position) + 1}/17` : "SHIFT COMPLETE" }), SP_JSX.jsxs("strong", { style: { color: ore }, children: [progressLabel, "%"] }), SP_JSX.jsxs("small", { children: [formatDuration(status.remaining_seconds), " REMAINING"] })] })] }), SP_JSX.jsxs("div", { className: "sm-score-hud", children: [SP_JSX.jsx("span", { children: "CITY VALUE" }), SP_JSX.jsx("strong", { children: formatScore(status.city_value) }), SP_JSX.jsxs("small", { children: ["+", formatScore(status.production_per_minute), "/MIN \u00B7 BEST +", formatScore(status.best_delivery)] })] }), SP_JSX.jsxs("div", { className: "sm-top-controls", children: [SP_JSX.jsxs("div", { className: "sm-control-group", children: [SP_JSX.jsx("span", { children: "SHIFT TEMPO" }), SP_JSX.jsx("div", { className: "sm-tempo", "aria-label": "Shift tempo", children: TEMPOS.map((name, index) => SP_JSX.jsxs(Button, { className: status.tempo === index + 1 ? "active" : "", onClick: () => void setTempo(index + 1).then(acceptStatus), children: [SP_JSX.jsx("b", { children: name }), SP_JSX.jsx("small", { children: TEMPO_DETAILS[index] })] }, name)) })] }), SP_JSX.jsxs("div", { className: "sm-control-group", children: [SP_JSX.jsx("span", { children: "LIGHT PROFILE" }), SP_JSX.jsxs("div", { className: "sm-world-bar-mode", "aria-label": "Physical bar style", children: [SP_JSX.jsxs(Button, { "aria-pressed": !status.optical_bar, className: `luminous${!status.optical_bar ? " active" : ""}`, onClick: () => void setSetting("optical_bar", false).then(acceptStatus), children: [SP_JSX.jsx("b", { children: "LUMINOUS" }), SP_JSX.jsx("small", { children: "BRIGHT \u00B7 SOFT GLOW" })] }), SP_JSX.jsxs(Button, { "aria-pressed": status.optical_bar, className: `contrasted${status.optical_bar ? " active" : ""}`, onClick: () => void setSetting("optical_bar", true).then(acceptStatus), children: [SP_JSX.jsx("b", { children: "CONTRASTED" }), SP_JSX.jsx("small", { children: "DARK \u00B7 CLEAR GAPS" })] })] })] })] })] }) : null, SP_JSX.jsxs("div", { className: "sm-world-nav", children: [SP_JSX.jsx(Button, { onClick: () => DFL.Navigation.NavigateBack(), children: "\u2190 BACK TO STEAM" }), SP_JSX.jsx(Button, { onClick: () => setShowIntro(true), children: "REPLAY INTRO" })] }), status.hardware_owner === "SignalBar" ? SP_JSX.jsx("div", { className: "sm-alert", children: "SIGNALBAR LIGHT EVENT \u00B7 MINING CONTINUES \u00B7 BAR RETURNS AUTOMATICALLY" }) : status.hardware_owner === "other" || error ? SP_JSX.jsx("div", { className: "sm-alert", children: error || status.hardware_error }) : null, toast ? SP_JSX.jsx("div", { className: "sm-toast", children: toast.label }, toast.seq) : null, !finaleActive ? SP_JSX.jsx(ScoreCascade, { status: status }) : null, SP_JSX.jsx(FinaleOverlay, { status: status })] }), SP_JSX.jsxs("section", { className: "sm-command", children: [SP_JSX.jsx("div", { className: "sm-status-panel", children: SP_JSX.jsxs("div", { className: "sm-shift", children: [SP_JSX.jsxs("span", { className: "sm-kicker", children: ["SHIFT CONTROL \u00B7 ", status.tempo_name, " \u00D7", status.tempo] }), SP_JSX.jsx("strong", { children: status.complete ? "THE CITY REMEMBERS EVERY LIGHT" : status.reward_pending ? status.cue_label : status.convoy_held ? `CITY GATES HOLDING · ${status.pending_convoy}/4 LOADED` : status.overcharge_remaining > 0 ? "OVERCHARGE · EVERY DELIVERY ×2.25" : `FOLLOW THE CREW · STRIKE AT ${status.deposit_short}` }), SP_JSX.jsxs("p", { children: [SP_JSX.jsxs("span", { children: ["CREW ", status.worker_count, "/4"] }), SP_JSX.jsxs("span", { children: ["SKYLINE ", skylineFloors, " FLOORS"] }), SP_JSX.jsxs("span", { children: ["NEXT \u00B7 ", nextReward] })] }), SP_JSX.jsxs("div", { className: "sm-skyline", "aria-label": `Twin city skyline, ${skylineFloors} floors`, children: [status.city.map((plot, index) => SP_JSX.jsx("i", { title: plot ? `${plot.name} level ${plot.level}` : "Empty site", style: { "--level": plot?.level ?? 0, "--tower": plot ? hex(plot.left) : "#294047" } }, `west-${index}`)), SP_JSX.jsx("b", { children: "\u21C5" }), [...status.city].reverse().map((plot, index) => SP_JSX.jsx("i", { title: plot ? `${plot.name} level ${plot.level}` : "Empty site", style: { "--level": plot?.level ?? 0, "--tower": plot ? hex(plot.right) : "#294047" } }, `east-${index}`))] }), SP_JSX.jsxs("small", { className: "sm-construction", children: ["TWIN ", constructionName, " \u00B7 LEVEL ", constructionLevel, " \u00B7 ", progressLabel, "%"] })] }) }), SP_JSX.jsxs("div", { className: "sm-strip-panel", children: [SP_JSX.jsxs("div", { className: "sm-strip-head", children: [SP_JSX.jsx("span", { children: "PHYSICAL BAR \u00B7 LIVE 17-PIXEL MAP" }), SP_JSX.jsx("strong", { children: ledState })] }), SP_JSX.jsx("div", { className: "sm-rail", role: "img", "aria-label": `17 LED light bar, ${status.deposit_short} at ${progressLabel} percent`, children: status.colors.map((colour, index) => { const fill = hex(colour); return SP_JSX.jsx("i", { style: { background: fill, boxShadow: `0 0 12px ${fill}` } }, index); }) }), SP_JSX.jsxs("div", { className: "sm-strip-scale", children: [SP_JSX.jsx("span", { children: "WEST CITY \u00B7 3 LEDS" }), SP_JSX.jsx("span", { children: "ACTIVE MINE" }), SP_JSX.jsx("span", { children: "EAST CITY \u00B7 3 LEDS" })] }), SP_JSX.jsx("div", { className: "sm-progress", children: SP_JSX.jsx("i", { style: { width: `${status.campaign_progress * 100}%` } }) }), SP_JSX.jsxs("div", { className: "sm-meta", children: [SP_JSX.jsxs("span", { children: ["CAMPAIGN ", Math.round(status.campaign_progress * 100), "% \u00B7 ACTIVE ", formatActive(status.active_seconds), " \u00B7 EST. ", status.campaign_estimate_hours, "H"] }), SP_JSX.jsxs("span", { children: ["ORE ", formatScore(status.ore), " \u00B7 ", status.completed_veins, "/30 VEINS"] })] })] }), SP_JSX.jsxs("div", { className: "sm-actions", children: [SP_JSX.jsxs("div", { className: "sm-actions-title", children: [SP_JSX.jsx("span", { children: "PLAYER ACTIONS" }), SP_JSX.jsx("strong", { children: status.paused ? "SHIFT PAUSED" : `A · X · Y · ${controlSource === "steam" ? "STEAM INPUT" : controlSource === "browser" ? "GAMEPAD" : "WAITING"}` })] }), SP_JSX.jsxs("div", { className: "sm-action-audio", children: [SP_JSX.jsx("span", { children: "AUDIO" }), SP_JSX.jsxs(Button, { className: music ? "on" : "", onClick: () => { const enabled = !music; if (audio.setMusic(enabled))
                                                    setMusic(enabled); }, children: ["\u266B OST ", musicVolume, "% \u00B7 ", music ? "ON" : "OFF"] }), SP_JSX.jsxs(Button, { className: effects ? "on" : "", onClick: () => { const enabled = !effects; setEffects(enabled); audio.setEffects(enabled); if (enabled)
                                                    audio.play("critical"); }, children: ["\u2726 SFX ", effectsVolume, "% \u00B7 ", effects ? "ON" : "OFF"] })] }), SP_JSX.jsxs(Button, { className: `sm-action primary${strikeResult ? " active" : ""}`, preferredFocus: true, disabled: status.paused || status.complete || (status.reward_pending && !finaleArmed), onClick: () => void signalStrike(), children: [SP_JSX.jsx("kbd", { children: "A" }), SP_JSX.jsxs("span", { children: [SP_JSX.jsx("b", { children: finaleArmed ? "LAST STRIKE" : strikeResult || "SIGNAL STRIKE" }), SP_JSX.jsx("small", { children: finaleArmed ? "Break the Ancient Core" : strikeResult ? "Impact registered · mineral progress increased" : "Time it at the vein · next load ×1.5 or ×3" })] })] }), SP_JSX.jsxs(Button, { className: `sm-action${status.convoy_held ? " active" : ""}`, disabled: status.complete, onClick: convoy, children: [SP_JSX.jsx("kbd", { children: "X" }), SP_JSX.jsxs("span", { children: [SP_JSX.jsx("b", { children: status.convoy_held ? `BANK ${status.pending_convoy} LOADED` : "HOLD CONVOY" }), SP_JSX.jsx("small", { children: status.convoy_held ? "Release the group multiplier" : "Stack returning miners at the gates" })] })] }), SP_JSX.jsxs(Button, { className: `sm-action${status.overcharge_remaining > 0 ? " active" : ""}${status.overcharge_cooldown > 0 && status.overcharge_remaining <= 0 ? " disabled" : ""}`, disabled: status.complete || (status.overcharge_cooldown > 0 && status.overcharge_remaining <= 0), onClick: overcharge, children: [SP_JSX.jsx("kbd", { children: "Y" }), SP_JSX.jsxs("span", { children: [SP_JSX.jsx("b", { children: status.overcharge_remaining > 0 ? `OVERCHARGE ${Math.ceil(status.overcharge_remaining)}S` : status.overcharge_cooldown > 0 ? `RECHARGE ${Math.ceil(status.overcharge_cooldown / 60)}M` : "OVERCHARGE" }), SP_JSX.jsx("small", { children: "Thirty seconds at \u00D72.25 power" })] })] }), SP_JSX.jsxs("div", { className: "sm-settings-line", children: [SP_JSX.jsx("span", { children: status.message }), SP_JSX.jsxs("div", { children: [SP_JSX.jsx(Button, { className: "workshop", onClick: () => setShowWorkshop(true), children: "\u2692 WORKSHOP" }), SP_JSX.jsx(Button, { onClick: () => void apply(setPaused(!status.paused)), children: status.paused ? "RESUME" : "PAUSE" }), SP_JSX.jsxs(Button, { onClick: () => void apply(setSetting("led_enabled", !status.led_enabled)), children: ["LED ", status.led_enabled ? "ON" : "OFF"] }), status.hardware_owner === "other" ? SP_JSX.jsx(Button, { onClick: () => void apply(retryLed()), children: "RETRY BAR" }) : null, SP_JSX.jsx(Button, { onClick: () => setResetConfirm(true), children: "RESET" })] })] })] })] })] }), showWorkshop ? SP_JSX.jsx(Workshop, { status: status, onClose: () => setShowWorkshop(false), onBuy: (kind) => void buyUpgrade(kind).then((result) => acceptStatus(result.status)).catch((reason) => setError(String(reason))) }) : null, resetConfirm ? SP_JSX.jsx("div", { className: "sm-reset-confirm", children: SP_JSX.jsxs("div", { className: "sm-reset-card", children: [SP_JSX.jsx("h2", { children: "Start a new expedition?" }), SP_JSX.jsxs("p", { children: ["This permanently erases the current city, crew ranks and all ", status.completed_veins, " cleared veins. The origin story will play again."] }), SP_JSX.jsxs("div", { children: [SP_JSX.jsx(Button, { onClick: () => setResetConfirm(false), children: "Keep this city" }), SP_JSX.jsx(Button, { className: "danger", onClick: () => void resetCampaign().then((next) => { acceptStatus(next); setResetConfirm(false); setShowIntro(true); }).catch((reason) => setError(String(reason))), children: "Erase and restart" })] })] }) }) : null] });
}
function QuickPanel() {
    const [status, setStatus] = SP_REACT.useState(null);
    const [music, setMusic] = SP_REACT.useState(sharedAudio.musicEnabled);
    const [effects, setEffects] = SP_REACT.useState(sharedAudio.effectsEnabled);
    const [musicVolume, setMusicVolume] = SP_REACT.useState(Math.round(sharedAudio.musicVolume * 100));
    const [effectsVolume, setEffectsVolume] = SP_REACT.useState(Math.round(sharedAudio.effectsVolume * 100));
    const [resetConfirm, setResetConfirm] = SP_REACT.useState(false);
    const audio = sharedAudio;
    SP_REACT.useEffect(() => { let alive = true; const refresh = () => void getStatus().then((next) => { if (alive) {
        setStatus(next);
        audio.onStatus(next);
        setMusic(audio.musicEnabled);
        setEffects(audio.effectsEnabled);
    } }).catch(() => undefined); refresh(); const timer = window.setInterval(refresh, 250); return () => { alive = false; window.clearInterval(timer); }; }, [audio]);
    const update = (work) => void work.then(setStatus).catch(() => undefined);
    if (!status)
        return SP_JSX.jsxs(DFL.PanelSection, { title: "StripMine", children: [SP_JSX.jsx("style", { children: styles }), SP_JSX.jsx("div", { className: "sm-qam-loading", children: "WAKING THE MINE\u2026" })] });
    const floors = status.city.reduce((total, plot) => total + (plot?.level ?? 0) * 2, 0);
    const west = status.workers.filter((worker) => worker.side === "left").length;
    const east = status.workers.length - west;
    const pageIndex = Math.floor(performance.now() / MATRIX_PAGE_MS) % QAM_PAGES.length;
    const pageLabel = status.complete ? "FINALE" : status.reward_pending ? "REWARD" : status.cue_active && status.last_cashout && status.cue_kind.startsWith("cashout") ? "SCORE" : QAM_PAGES[pageIndex];
    const progressLabel = veinPercent(status);
    return SP_JSX.jsxs(DFL.PanelSection, { title: "StripMine", children: [SP_JSX.jsx("style", { children: styles }), SP_JSX.jsxs("div", { className: "sm-qam", children: [SP_JSX.jsxs("div", { className: "sm-qam-title", children: [SP_JSX.jsx("img", { className: "sm-qam-logo", src: STRIPMINE_LOGO_URL, alt: "", "aria-hidden": "true" }), SP_JSX.jsx("strong", { children: "STRIPMINE \u00B7 CONTROL ROOM" }), SP_JSX.jsx("i", { children: status.signalbar_event_active ? "● SIGNALBAR EVENT" : "● LIVE" })] }), SP_JSX.jsxs("div", { className: "sm-qam-matrix-panel", children: [SP_JSX.jsxs("header", { children: [SP_JSX.jsxs("span", { children: ["LIVE STORY MATRIX \u00B7 ", Math.round(MATRIX_DOTS / 1000), "K DOTS"] }), SP_JSX.jsx("strong", { children: status.cue_active ? status.cue_label : `${status.deposit_short} · ${progressLabel}%` })] }), SP_JSX.jsx("div", { className: "sm-qam-matrix", children: SP_JSX.jsx(DotMatrix, { status: status }) }), SP_JSX.jsxs("div", { className: "sm-qam-pages", "aria-label": `${pageLabel} story page`, children: [QAM_PAGES.map((page, index) => SP_JSX.jsx("i", { className: !status.reward_pending && !status.complete && index === pageIndex ? "active" : "" }, page)), SP_JSX.jsx("span", { children: pageLabel })] }), SP_JSX.jsxs("footer", { children: [SP_JSX.jsxs("span", { children: [west, " WEST"] }), SP_JSX.jsx("span", { children: status.deposit_short }), SP_JSX.jsxs("span", { children: [east, " EAST"] })] })] }), SP_JSX.jsxs("div", { className: "sm-qam-stats", children: [SP_JSX.jsxs("i", { children: [SP_JSX.jsx("span", { children: "AGE" }), SP_JSX.jsxs("b", { children: [status.age + 1, " \u00B7 ", Math.round(status.campaign_progress * 100), "%"] })] }), SP_JSX.jsxs("i", { children: [SP_JSX.jsx("span", { children: "SKYLINE" }), SP_JSX.jsxs("b", { children: [floors, " FLOORS"] })] }), SP_JSX.jsxs("i", { children: [SP_JSX.jsx("span", { children: "CREW" }), SP_JSX.jsxs("b", { children: [status.worker_count, "/4 \u00B7 ", status.rank_name.toUpperCase()] })] })] }), SP_JSX.jsx("div", { className: "sm-qam-tempo", children: TEMPOS.map((name, index) => SP_JSX.jsxs(Button, { className: status.tempo === index + 1 ? "active" : "", onClick: () => update(setTempo(index + 1)), children: [SP_JSX.jsx("b", { children: name }), SP_JSX.jsxs("small", { children: ["\u00D7", index + 1] })] }, name)) }), SP_JSX.jsxs("div", { className: "sm-qam-controls", children: [SP_JSX.jsxs(Button, { className: music ? "on" : "", onClick: () => { const enabled = !music; if (audio.setMusic(enabled))
                                    setMusic(enabled); }, children: ["\u266B OST ", musicVolume, "% \u00B7 ", music ? "ON" : "OFF"] }), SP_JSX.jsxs(Button, { className: effects ? "on" : "", onClick: () => { const enabled = !effects; audio.setEffects(enabled); setEffects(enabled); if (enabled)
                                    audio.play("critical"); }, children: ["\u2726 SFX ", effectsVolume, "% \u00B7 ", effects ? "ON" : "OFF"] }), SP_JSX.jsx(Button, { className: status.paused ? "on" : "", onClick: () => update(setPaused(!status.paused)), children: status.paused ? "▶ RESUME" : "Ⅱ PAUSE" }), SP_JSX.jsxs(Button, { className: status.led_enabled ? "on" : "", onClick: () => update(setSetting("led_enabled", !status.led_enabled)), children: ["\u25B0 LED ", status.led_enabled ? "ON" : "OFF"] })] }), SP_JSX.jsxs("div", { className: "sm-qam-bar-mode", children: [SP_JSX.jsx("span", { children: "PHYSICAL BAR STYLE" }), SP_JSX.jsxs(Button, { "aria-pressed": !status.optical_bar, className: !status.optical_bar ? "active" : "", onClick: () => update(setSetting("optical_bar", false)), children: [SP_JSX.jsx("b", { children: "LUMINOUS" }), SP_JSX.jsx("small", { children: "BRIGHT \u00B7 SOFT GLOW" })] }), SP_JSX.jsxs(Button, { "aria-pressed": status.optical_bar, className: status.optical_bar ? "active" : "", onClick: () => update(setSetting("optical_bar", true)), children: [SP_JSX.jsx("b", { children: "CONTRASTED" }), SP_JSX.jsx("small", { children: "DARK \u00B7 CLEAR GAPS" })] })] }), SP_JSX.jsxs("div", { className: "sm-qam-volume", children: [SP_JSX.jsx(DFL.SliderField, { label: `MUSIC · ${musicVolume}%`, value: musicVolume, min: 0, max: 100, step: 5, showValue: false, onChange: (value) => { setMusicVolume(value); audio.setMusicVolume(value / 100); } }), SP_JSX.jsx(DFL.SliderField, { label: `SFX · ${effectsVolume}%`, value: effectsVolume, min: 0, max: 100, step: 5, showValue: false, onChange: (value) => { setEffectsVolume(value); audio.setEffectsVolume(value / 100); } })] }), SP_JSX.jsxs("div", { className: "sm-qam-footer-actions", children: [SP_JSX.jsx(Button, { className: "sm-qam-reset", onClick: () => setResetConfirm(true), children: "RESET GAME" }), SP_JSX.jsx(Button, { className: "sm-qam-open", onClick: () => { DFL.Navigation.CloseSideMenus(); DFL.Navigation.Navigate("/stripmine/play"); }, children: "OPEN FULL GAME" })] }), resetConfirm ? SP_JSX.jsxs("div", { className: "sm-qam-reset-confirm", children: [SP_JSX.jsx("strong", { children: "ERASE THIS CITY?" }), SP_JSX.jsx("small", { children: "Crew, upgrades, score and all completed veins will be reset. The origin story will play next." }), SP_JSX.jsxs("div", { children: [SP_JSX.jsx(Button, { onClick: () => setResetConfirm(false), children: "CANCEL" }), SP_JSX.jsx(Button, { className: "danger", onClick: () => void resetCampaign().then((next) => { setStatus(next); setResetConfirm(false); DFL.Navigation.CloseSideMenus(); DFL.Navigation.Navigate("/stripmine/play"); }).catch(() => undefined), children: "RESET + INTRO" })] })] }) : null] })] });
}
var index = definePlugin(() => {
    routerHook.addRoute("/stripmine/play", Game);
    return { name: "StripMine", titleView: SP_JSX.jsx("div", { className: DFL.staticClasses.Title, children: "StripMine" }), content: SP_JSX.jsx(QuickPanel, {}),
        icon: SP_JSX.jsxs("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", children: [SP_JSX.jsx("path", { d: "M3 17h18M5 17V9l4-4 4 4v8M16 17V7h3v10", stroke: "currentColor", strokeWidth: "1.8", strokeLinejoin: "round" }), SP_JSX.jsx("path", { d: "M7 13h4m6-3h1", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round" })] }),
        alwaysRender: true, onDismount() { sharedAudio.dispose(); routerHook.removeRoute("/stripmine/play"); } };
});

export { index as default };
//# sourceMappingURL=index.js.map
