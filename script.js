// Wordly Babelfish - Isolate & Orchestrate Strategy
document.addEventListener('DOMContentLoaded', () => {
    // --- Global State & Config ---
    const state = {
        isConnecting: false,
        isConnected: false,
        supportsSinkId: typeof HTMLAudioElement !== 'undefined' && typeof HTMLAudioElement.prototype.setSinkId === 'function'
    };

    const languageMap = { 'auto': 'Auto-Detect', 'af': 'Afrikaans', 'sq': 'Albanian', 'ar': 'Arabic', 'hy': 'Armenian', 'bn': 'Bengali', 'bg': 'Bulgarian', 'ca': 'Catalan', 'zh-HK': 'Cantonese', 'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', 'hr': 'Croatian', 'cs': 'Czech', 'da': 'Danish', 'nl': 'Dutch', 'en': 'English (US)', 'en-AU': 'English (AU)', 'en-GB': 'English (UK)', 'et': 'Estonian', 'fi': 'Finnish', 'fr': 'French (FR)', 'fr-CA': 'French (CA)', 'ka': 'Georgian', 'de': 'German', 'el': 'Greek', 'gu': 'Gujarati', 'he': 'Hebrew', 'hi': 'Hindi', 'hu': 'Hungarian', 'is': 'Icelandic', 'id': 'Indonesian', 'ga': 'Irish', 'it': 'Italian', 'ja': 'Japanese', 'kn': 'Kannada', 'ko': 'Korean', 'lv': 'Latvian', 'lt': 'Lithuanian', 'mk': 'Macedonian', 'ms': 'Malay', 'mt': 'Maltese', 'no': 'Norwegian', 'fa': 'Persian', 'pl': 'Polish', 'pt': 'Portuguese (PT)', 'pt-BR': 'Portuguese (BR)', 'pa': 'Punjabi', 'ro': 'Romanian', 'ru': 'Russian', 'sr': 'Serbian', 'sk': 'Slovak', 'sl': 'Slovenian', 'es': 'Spanish (ES)', 'es-MX': 'Spanish (MX)', 'sw': 'Swahili', 'sv': 'Swedish', 'ta': 'Tamil', 'tl': 'Tagalog', 'th': 'Thai', 'tr': 'Turkish', 'uk': 'Ukrainian', 'ur': 'Urdu', 'vi': 'Vietnamese', 'cy': 'Welsh' };

    // --- DOM Elements ---
    const loginPage = document.getElementById('login-page');
    const appPage = document.getElementById('app-page');
    const loginForm = document.getElementById('login-form');
    const connectionToggleBtn = document.getElementById('connection-toggle-btn');
    const duckingSlider = document.getElementById('ducking-slider');

    // ===================================================================================
    // --- MODULE 1: OUTGOING "JOIN" SESSION (Adapted from your original script) ---
    // ===================================================================================
    const outgoingModule = {
        websocket: null,
        status: 'disconnected',
        config: {},
        mediaStream: null,
        audioContext: null,
        audioLevel: 0,
        muted: false,
        
        connect: function(config) {
            this.config = config;
            return new Promise((resolve, reject) => {
                this.updateStatus('connecting', 'Connecting...');
                const endpoint = 'wss://dev-endpoint.wordly.ai/present';
                this.websocket = new WebSocket(endpoint);
                this.websocket.binaryType = 'arraybuffer';

                const timeout = setTimeout(() => { this.websocket.close(); reject(new Error("Join: Connection timed out.")); }, 10000);

                this.websocket.onopen = () => {
                    const connectRequest = {
                        type: 'connect', presentationCode: this.config.sessionId, accessKey: this.config.passcode,
                        languageCode: this.config.sourceLanguage, speakerId: `babelfish-join-${Date.now()}`,
                        name: 'My Voice (Babelfish)', connectionCode: 'wordly-babelfish-app', context: null
                    };
                    this.send(connectRequest);
                };
                this.websocket.onmessage = (event) => { clearTimeout(timeout); this.handleMessage(event, resolve, reject); };
                this.websocket.onerror = (err) => { clearTimeout(timeout); this.updateStatus('error', 'Join: Connection Error'); reject(err); };
                this.websocket.onclose = () => { clearTimeout(timeout);
                    if (this.status !== 'connected') { this.updateStatus('error', 'Join: Connection Failed'); reject(new Error("Join: Connection closed unexpectedly.")); }
                    else { this.updateStatus('disconnected', 'Disconnected'); }
                };
            });
        },
        
        handleMessage: function(event, resolve, reject) {
            if (!(event.data instanceof ArrayBuffer)) return;
            const decoder = new TextDecoder('utf-8');
            let message;
            try { message = JSON.parse(decoder.decode(event.data)); }
            catch (e) { /* This is binary audio for our own translation, handled by the Attend module logic */ return; }

            if (message.type === 'status' && message.success) {
                this.updateStatus('connected', 'Connected');
                this.send({ type: 'start', languageCode: this.config.sourceLanguage, sampleRate: 16000 });
                this.startAudioCapture();
                resolve(this);
            } else if (message.type === 'status' && !message.success) {
                this.updateStatus('error', `Join: Failed - ${message.message}`);
                this.disconnect();
                reject(new Error(message.message));
            }
        },

        startAudioCapture: function() {
            if (this.mediaStream) this.stopAudioCapture();
            const constraints = { audio: { deviceId: this.config.inputDeviceId ? { exact: this.config.inputDeviceId } : undefined, sampleRate: 16000, channelCount: 1, echoCancellation: true } };
            navigator.mediaDevices.getUserMedia(constraints).then(stream => {
                this.mediaStream = stream;
                this.audioContext = new AudioContext({ sampleRate: 16000 });
                const source = this.audioContext.createMediaStreamSource(stream);
                const processor = this.audioContext.createScriptProcessor(2048, 1, 1);
                const analyser = this.audioContext.createAnalyser();
                source.connect(analyser); analyser.connect(processor); processor.connect(this.audioContext.destination);
                processor.onaudioprocess = (e) => {
                    const data = e.inputBuffer.getChannelData(0);
                    const rms = this.getRMS(data);
                    this.audioLevel = rms;
                    this.updateVisualizer();
                    
                    // Direct link to the other module for ducking
                    incomingModule.applyDucking(rms > 0.02);
                    
                    if (!this.muted) this.send(this.toPCM(data));
                };
            }).catch(err => this.addSystemMessage("Could not get microphone.", true));
        },
        
        disconnect: function() {
            this.stopAudioCapture();
            if (this.websocket) { this.websocket.onclose = null; this.websocket.close(1000, 'User disconnected'); }
            this.updateStatus('disconnected', 'Disconnected');
        },

        send: function(data) {
            if (this.websocket?.readyState !== WebSocket.OPEN) return;
            if (data instanceof ArrayBuffer) this.websocket.send(data);
            else this.websocket.send(JSON.stringify(data));
        },
        getRMS: buffer => Math.sqrt(buffer.reduce((s, v) => s + v * v, 0) / buffer.length),
        toPCM: function(buffer) { const pcm = new Int16Array(buffer.length); for (let i = 0; i < buffer.length; i++) pcm[i] = Math.max(-1, Math.min(1, buffer[i])) * 0x7FFF; return pcm.buffer; },
        stopAudioCapture: function() { this.mediaStream?.getTracks().forEach(track => track.stop()); this.audioContext?.close().catch(()=>{}); this.audioLevel = 0; this.updateVisualizer(); },
        updateStatus: function(status, message) { this.status = status; this.config.ui.statusLight.className = `session-status-light ${status}`; this.addSystemMessage(message, status === 'error'); },
        addSystemMessage: function(text, isError=false) { const el = document.createElement('div'); el.textContent = text; this.config.ui.transcript.insertBefore(el, this.config.ui.transcript.firstChild); },
        updateVisualizer: function() { if (!this.config.ui.visualizer) return; this.config.ui.visualizer.style.width = `${Math.min(100, this.audioLevel * 800)}%`; this.config.ui.visualizer.classList.toggle('muted', this.muted); },
        toggleMute: function() { this.muted = !this.muted; this.config.ui.muteBtn.classList.toggle('muted', this.muted); },
    };

    // =====================================================================================
    // --- MODULE 2: INCOMING "ATTEND" SESSION (Adapted from your original script) ---
    // =====================================================================================
    const incomingModule = {
        websocket: null,
        status: 'disconnected',
        config: {},
        audioQueue: [],
        isPlaying: false,
        currentAudioElement: null,
        audioEnabled: true,

        connect: function(config) {
            this.config = config;
            return new Promise((resolve, reject) => {
                this.updateStatus('connecting', 'Connecting...');
                const endpoint = 'wss://dev-endpoint.wordly.ai/attend';
                this.websocket = new WebSocket(endpoint);
                this.websocket.binaryType = 'arraybuffer';
                const timeout = setTimeout(() => { this.websocket.close(); reject(new Error("Attend: Connection timed out.")); }, 10000);

                this.websocket.onopen = () => {
                    const connectRequest = { type: 'connect', presentationCode: this.config.sessionId, accessKey: this.config.passcode || undefined, languageCode: this.config.targetLanguage, };
                    this.send(connectRequest);
                };
                this.websocket.onmessage = (event) => { clearTimeout(timeout); this.handleMessage(event, resolve, reject); };
                this.websocket.onerror = (err) => { clearTimeout(timeout); this.updateStatus('error', 'Attend: Connection Error'); reject(err); };
                this.websocket.onclose = () => { clearTimeout(timeout);
                    if (this.status !== 'connected') { this.updateStatus('error', 'Attend: Connection Failed'); reject(new Error("Attend: Connection closed unexpectedly.")); }
                    else { this.updateStatus('disconnected', 'Disconnected'); }
                };
            });
        },

        handleMessage: function(event, resolve, reject) {
            const decoder = new TextDecoder('utf-8');
            let message;
            try { message = JSON.parse(decoder.decode(event.data)); } catch (e) { return; }

            if (message.type === 'status' && message.success) {
                this.updateStatus('connected', 'Connected');
                if (this.audioEnabled) this.send({ type: 'voice', enabled: true });
                resolve(this);
            } else if (message.type === 'status' && !message.success) {
                this.updateStatus('error', `Attend: Failed - ${message.message}`);
                this.disconnect();
                reject(new Error(message.message));
            } else if (message.type === 'speech') {
                this.playAudio(message.synthesizedSpeech.data);
            }
        },
        
        playAudio: function(data) {
            if (!this.audioEnabled) return;
            this.audioQueue.push({ data, deviceId: this.config.outputDeviceId });
            this.processAudioQueue();
        },

        processAudioQueue: function() {
            if (this.isPlaying || this.audioQueue.length === 0) return;
            this.isPlaying = true;
            const item = this.audioQueue.shift();
            const blob = new Blob([new Uint8Array(item.data)], { type: 'audio/wav' });
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            this.currentAudioElement = audio;
            audio.oncanplaythrough = async () => {
                if (item.deviceId && state.supportsSinkId) { try { await audio.setSinkId(item.deviceId); } catch (err) { console.error("setSinkId failed:", err); } }
                audio.play().catch(e => console.error("Playback failed:", e));
            };
            const cleanup = () => { URL.revokeObjectURL(url); this.isPlaying = false; this.currentAudioElement = null; setTimeout(() => this.processAudioQueue(), 0); };
            audio.onended = cleanup; audio.onerror = cleanup;
        },

        disconnect: function() {
            this.stopAudioPlayback();
            if (this.websocket) { this.websocket.onclose = null; this.websocket.close(1000, 'User disconnected'); }
            this.updateStatus('disconnected', 'Disconnected');
        },

        send: function(data) { if (this.websocket?.readyState === WebSocket.OPEN) this.websocket.send(JSON.stringify(data)); },
        stopAudioPlayback: function() { this.audioQueue = []; if (this.currentAudioElement) { this.currentAudioElement.pause(); this.currentAudioElement.src = ''; } this.isPlaying = false; },
        applyDucking: function(isSpeaking) { if (this.currentAudioElement) this.currentAudioElement.volume = isSpeaking ? parseFloat(duckingSlider.value) : 1.0; },
        updateStatus: function(status, message) { this.status = status; this.config.ui.statusLight.className = `session-status-light ${status}`; this.addSystemMessage(message, status === 'error'); },
        addSystemMessage: function(text, isError=false) { const el = document.createElement('div'); el.textContent = text; this.config.ui.transcript.insertBefore(el, this.config.ui.transcript.firstChild); },
        toggleAudio: function(enabled) { this.audioEnabled = enabled; if (this.status === 'connected') this.send({ type: 'voice', enabled: this.audioEnabled }); if (!this.audioEnabled) this.stopAudioPlayback(); },
    };

    // ===================================================================================
    // --- ORCHESTRATOR: Manages the overall application state and UI ---
    // ===================================================================================
    async function handleLogin(e) {
        e.preventDefault();
        showLoginStatus("Getting audio devices...");
        try { await initializeAudioDevices(); showLoginStatus("Ready to configure.", false); }
        catch (err) { return; }
        loginPage.style.display = 'none';
        appPage.style.display = 'flex';
        setupUIEventListeners();
    }
    
    function handleConnectionToggle() {
        if (state.isConnecting) { disconnectAll(); }
        else if (state.isConnected) { disconnectAll(); }
        else { connectAll(); }
    }

    async function connectAll() {
        if (state.isConnecting) return;
        state.isConnecting = true;
        updateConnectionButton(true, "Cancel");

        // Clear previous transcripts
        getConfigFromUI('outgoing').ui.transcript.innerHTML = '';
        getConfigFromUI('incoming').ui.transcript.innerHTML = '';
        
        try {
            await Promise.all([
                outgoingModule.connect(getConfigFromUI('outgoing')),
                incomingModule.connect(getConfigFromUI('incoming'))
            ]);
            state.isConnected = true;
        } catch (error) {
            console.error("Failed to connect one or more sessions:", error);
            outgoingModule.disconnect();
            incomingModule.disconnect();
            state.isConnected = false;
        } finally {
            state.isConnecting = false;
            updateConnectionButton(false);
        }
    }

    function disconnectAll() {
        outgoingModule.disconnect();
        incomingModule.disconnect();
        state.isConnected = false;
        state.isConnecting = false;
        updateConnectionButton(false);
    }
    
    function getConfigFromUI(type) {
        return {
            sessionId: document.getElementById(`${type}-session-id`).value,
            passcode: document.getElementById(`${type}-passcode`)?.value,
            inputDeviceId: document.getElementById(`${type}-input-device-select`).value,
            sourceLanguage: document.getElementById(`${type}-source-language-select`).value,
            targetLanguage: document.getElementById(`${type}-target-language-select`).value,
            outputDeviceId: document.getElementById(`${type}-output-device-select`).value,
            ui: {
                statusLight: document.querySelector(`#${type}-session .session-status-light`),
                transcript: document.querySelector(`#${type}-session .session-transcript`),
                visualizer: document.querySelector(`#${type}-session .audio-level`),
                muteBtn: document.querySelector(`#${type}-session .mute-btn`),
            }
        };
    }
    
    function updateConnectionButton(isConnecting, text) {
        const btn = connectionToggleBtn;
        btn.disabled = false;
        if (isConnecting) {
            btn.textContent = text || "Connecting...";
            btn.className = "disconnect-button"; // Red for "Cancel"
        } else {
            btn.textContent = state.isConnected ? "Disconnect All" : "Connect All";
            btn.className = state.isConnected ? "disconnect-button" : "connect-button";
        }
    }

    function setupUIEventListeners() {
        document.querySelector('#outgoing-session .mute-btn').onclick = () => outgoingModule.toggleMute();
        document.getElementById('incoming-audio-toggle').onchange = (e) => incomingModule.toggleAudio(e.target.checked);
    }

    async function refreshAllDeviceLists() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            stream.getTracks().forEach(track => track.stop());
            
            const inputDevices = devices.filter(d => d.kind === 'audioinput');
            const outputDevices = devices.filter(d => d.kind === 'audiooutput');
            
            populateDeviceDropdown('outgoing-input-device-select', inputDevices);
            populateDeviceDropdown('incoming-input-device-select', inputDevices);
            populateDeviceDropdown('outgoing-output-device-select', outputDevices, true);
            populateDeviceDropdown('incoming-output-device-select', outputDevices, true);
        } catch(err) {
            alert("Could not refresh devices. Please ensure microphone permission is granted.");
        }
    }

    async function initializeAudioDevices() {
        try { await refreshAllDeviceLists(); }
        catch (err) { showLoginStatus("Could not access audio devices. Please grant permission.", true); throw err; }
    }
    
    function populateDeviceDropdown(elementId, devices, isOutput = false) {
        const select = document.getElementById(elementId);
        const currentVal = select.value;
        select.innerHTML = '';
        if (isOutput && !state.supportsSinkId) { select.add(new Option('Default Device Only', '')); select.disabled = true; return; }
        select.add(new Option(`Default ${isOutput ? 'Output' : 'Input'}`, ''));
        devices.forEach(d => { if (d.deviceId !== 'default') select.add(new Option(d.label || `${isOutput ? 'Output' : 'Input'} ${select.options.length}`, d.deviceId)); });
        if ([...select.options].some(o => o.value === currentVal)) { select.value = currentVal; }
    }

    function populateLanguageDropdowns() {
        const selects = document.querySelectorAll('select[id$="-language-select"]');
        selects.forEach(select => {
            for (const [code, name] of Object.entries(languageMap)) select.add(new Option(name, code));
        });
        document.getElementById('outgoing-source-language-select').value = 'en';
        document.getElementById('outgoing-target-language-select').value = 'es-MX';
        document.getElementById('incoming-source-language-select').value = 'es-MX';
        document.getElementById('incoming-target-language-select').value = 'en';
    }

    function showLoginStatus(message, isError = false) {
        loginStatus.textContent = message;
        loginStatus.className = isError ? 'status-message error' : 'status-message success';
        loginStatus.style.display = 'block';
    }
    
    // --- Initial Setup ---
    init();
});