// Wordly Babelfish - Final Corrected Workflow
document.addEventListener('DOMContentLoaded', () => {
    // --- Global State & Config ---
    const state = {
        sessionConfigs: {},
        outgoingSession: null,
        incomingSession: null,
        isConnecting: false,
        isConnected: false,
        supportsSinkId: typeof HTMLAudioElement !== 'undefined' && typeof HTMLAudioElement.prototype.setSinkId === 'function'
    };

    const languageMap = { 'auto': 'Auto-Detect', 'af': 'Afrikaans', 'sq': 'Albanian', 'ar': 'Arabic', 'hy': 'Armenian', 'bn': 'Bengali', 'bg': 'Bulgarian', 'ca': 'Catalan', 'zh-HK': 'Cantonese', 'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', 'hr': 'Croatian', 'cs': 'Czech', 'da': 'Danish', 'nl': 'Dutch', 'en': 'English (US)', 'en-AU': 'English (AU)', 'en-GB': 'English (UK)', 'et': 'Estonian', 'fi': 'Finnish', 'fr': 'French (FR)', 'fr-CA': 'French (CA)', 'ka': 'Georgian', 'de': 'German', 'el': 'Greek', 'gu': 'Gujarati', 'he': 'Hebrew', 'hi': 'Hindi', 'hu': 'Hungarian', 'is': 'Icelandic', 'id': 'Indonesian', 'ga': 'Irish', 'it': 'Italian', 'ja': 'Japanese', 'kn': 'Kannada', 'ko': 'Korean', 'lv': 'Latvian', 'lt': 'Lithuanian', 'mk': 'Macedonian', 'ms': 'Malay', 'mt': 'Maltese', 'no': 'Norwegian', 'fa': 'Persian', 'pl': 'Polish', 'pt': 'Portuguese (PT)', 'pt-BR': 'Portuguese (BR)', 'pa': 'Punjabi', 'ro': 'Romanian', 'ru': 'Russian', 'sr': 'Serbian', 'sk': 'Slovak', 'sl': 'Slovenian', 'es': 'Spanish (ES)', 'es-MX': 'Spanish (MX)', 'sw': 'Swahili', 'sv': 'Swedish', 'ta': 'Tamil', 'tl': 'Tagalog', 'th': 'Thai', 'tr': 'Turkish', 'uk': 'Ukrainian', 'ur': 'Urdu', 'vi': 'Vietnamese', 'cy': 'Welsh' };

    // --- DOM Elements ---
    const loginPage = document.getElementById('login-page');
    const appPage = document.getElementById('app-page');
    const loginForm = document.getElementById('login-form');
    const loginStatus = document.getElementById('login-status');
    const connectionToggleBtn = document.getElementById('connection-toggle-btn');
    const duckingSlider = document.getElementById('ducking-slider');

    // --- Main Initialization ---
    function init() {
        populateLanguageDropdowns();
        loginForm.addEventListener('submit', handleLogin);
        connectionToggleBtn.addEventListener('click', handleConnectionToggle);
        duckingSlider.addEventListener('input', (e) => {
            document.getElementById('ducking-value').textContent = `${Math.round(e.target.value * 100)}%`;
        });
        document.querySelectorAll('.refresh-btn').forEach(btn => {
            btn.addEventListener('click', refreshAllDeviceLists);
        });
    }

    // ===================================================================================
    // --- INITIALIZATION FLOW ---
    // ===================================================================================
    async function handleLogin(e) {
        e.preventDefault();
        showLoginStatus("Getting audio devices...");
        try {
            // This is the critical step: get permissions and devices BEFORE loading the main page.
            await refreshAllDeviceLists(); 
            
            // Store credentials from the form for later use
            state.sessionConfigs.outgoing = getConfigFromUI('outgoing', true);
            state.sessionConfigs.incoming = getConfigFromUI('incoming', true);

            // Now, transition to the main page
            loginPage.style.display = 'none';
            appPage.style.display = 'flex';
            setupUIEventListeners();
        } catch (err) {
            showLoginStatus("Could not access audio devices. Please grant permission and try again.", true);
        }
    }
    
    // ===================================================================================
    // --- Core Session Class (Unchanged) ---
    // ===================================================================================
    class WordlySession {
        constructor(type, config) {
            this.type = type; this.config = config; this.isCaptureSession = (this.type === 'join');
            this.websocket = null; this.status = 'disconnected'; this.audioQueue = [];
            this.isPlaying = false; this.currentAudioElement = null; this.audioEnabled = true;
            if (this.isCaptureSession) { this.muted = false; this.mediaStream = null; this.audioContext = null; this.audioLevel = 0; }
        }
        connect() {
            return new Promise((resolve, reject) => {
                this.updateStatus('connecting', 'Connecting...');
                const endpoint = this.isCaptureSession ? 'wss://dev-endpoint.wordly.ai/present' : 'wss://dev-endpoint.wordly.ai/attend';
                this.websocket = new WebSocket(endpoint);
                this.websocket.binaryType = 'arraybuffer';
                const timeout = setTimeout(() => { this.websocket.close(); reject(new Error(`${this.type}: Connection timed out.`)); }, 10000);
                this.websocket.onopen = () => {
                    const connectRequest = this.isCaptureSession ? {
                        type: 'connect', presentationCode: this.config.sessionId, accessKey: this.config.passcode,
                        languageCode: this.config.sourceLanguage, speakerId: `babelfish-join-${Date.now()}`,
                        name: 'My Voice (Babelfish)', connectionCode: 'wordly-babelfish-app', context: null
                    } : {
                        type: 'connect', presentationCode: this.config.sessionId, accessKey: this.config.passcode || undefined,
                        languageCode: this.config.targetLanguage,
                    };
                    this.send(connectRequest);
                };
                this.websocket.onmessage = (event) => { clearTimeout(timeout); this.handleMessage(event, resolve, reject); };
                this.websocket.onerror = (err) => { clearTimeout(timeout); this.updateStatus('error', `${this.type}: Connection Error`); reject(err); };
                this.websocket.onclose = () => {
                    clearTimeout(timeout);
                    if (this.status !== 'connected') { this.updateStatus('error', `${this.type}: Connection Failed`); reject(new Error(`${this.type}: Connection closed unexpectedly.`)); }
                    else { this.updateStatus('disconnected', 'Disconnected'); }
                };
            });
        }
        disconnect() {
            if (this.isCaptureSession) this.stopAudioCapture(); else this.stopAudioPlayback();
            if (this.websocket) { this.websocket.onclose = null; this.websocket.close(1000, 'User disconnected'); }
            this.updateStatus('disconnected', 'Disconnected');
        }
        send(data) { if (this.websocket?.readyState !== WebSocket.OPEN) return; if (data instanceof ArrayBuffer) this.websocket.send(data); else this.websocket.send(JSON.stringify(data)); }
        handleMessage(event, resolve, reject) {
            if (!(event.data instanceof ArrayBuffer)) return;
            const decoder = new TextDecoder('utf-8'); let message;
            try { message = JSON.parse(decoder.decode(event.data)); } catch (e) { this.playAudio(event.data); return; }
            if (message.type === 'status') {
                if (message.success) {
                    this.updateStatus('connected', 'Connected');
                    const commands = this.isCaptureSession ?
                        [{ type: 'change', languageCode: this.config.targetLanguage }, { type: 'start', languageCode: this.config.sourceLanguage, sampleRate: 16000 }, { type: 'voice', enabled: true }] :
                        [{ type: 'change', languageCode: this.config.targetLanguage }, { type: 'voice', enabled: this.audioEnabled }];
                    commands.forEach(cmd => this.send(cmd));
                    if (this.isCaptureSession) this.startAudioCapture();
                    resolve(this);
                } else { this.updateStatus('error', `Failed: ${message.message}`); this.disconnect(); reject(new Error(message.message)); }
            } else if (message.type === 'speech') { if (!this.isCaptureSession) this.playAudio(message.synthesizedSpeech.data);
            } else if (message.type === 'phrase' || message.type === 'result') { this.updateTranscript(message);
            } else if (message.type === 'error') { this.addSystemMessage(`Error: ${message.message}`, true); }
        }
        playAudio(data) { if (!this.audioEnabled) return; this.audioQueue.push({ data, deviceId: this.config.outputDeviceId }); this.processAudioQueue(); }
        processAudioQueue() {
            if (this.isPlaying || this.audioQueue.length === 0) return;
            this.isPlaying = true; const item = this.audioQueue.shift(); const blob = new Blob([new Uint8Array(item.data)], { type: 'audio/wav' });
            const url = URL.createObjectURL(blob); const audio = new Audio(url); this.currentAudioElement = audio;
            audio.oncanplaythrough = async () => { if (item.deviceId && state.supportsSinkId) { try { await audio.setSinkId(item.deviceId); } catch (err) { console.error("setSinkId failed:", err); } } audio.play().catch(e => console.error("Playback failed:", e)); };
            const cleanup = () => { URL.revokeObjectURL(url); this.isPlaying = false; this.currentAudioElement = null; setTimeout(() => this.processAudioQueue(), 0); };
            audio.onended = cleanup; audio.onerror = cleanup;
        }
        stopAudioPlayback() { this.audioQueue = []; if (this.currentAudioElement) { this.currentAudioElement.pause(); this.currentAudioElement.src = ''; } this.isPlaying = false; }
        startAudioCapture() {
            if (this.mediaStream) this.stopAudioCapture();
            const constraints = { audio: { deviceId: this.config.inputDeviceId ? { exact: this.config.inputDeviceId } : undefined, sampleRate: 16000, channelCount: 1, echoCancellation: true } };
            navigator.mediaDevices.getUserMedia(constraints).then(stream => {
                this.mediaStream = stream; this.audioContext = new AudioContext({ sampleRate: 16000 });
                const source = this.audioContext.createMediaStreamSource(stream); const processor = this.audioContext.createScriptProcessor(2048, 1, 1);
                const analyser = this.audioContext.createAnalyser(); source.connect(analyser); analyser.connect(processor); processor.connect(this.audioContext.destination);
                processor.onaudioprocess = (e) => {
                    const data = e.inputBuffer.getChannelData(0); const rms = this.getRMS(data); this.audioLevel = rms; this.updateVisualizer();
                    state.incomingSession?.applyDucking(rms > 0.02); if (!this.muted) this.send(this.toPCM(data));
                };
            }).catch(err => this.addSystemMessage("Could not get microphone.", true));
        }
        getRMS = buffer => Math.sqrt(buffer.reduce((s, v) => s + v * v, 0) / buffer.length);
        toPCM(buffer) { const pcm = new Int16Array(buffer.length); for (let i = 0; i < buffer.length; i++) pcm[i] = Math.max(-1, Math.min(1, buffer[i])) * 0x7FFF; return pcm.buffer; }
        stopAudioCapture() { this.mediaStream?.getTracks().forEach(track => track.stop()); this.audioContext?.close().catch(()=>{}); this.audioLevel = 0; this.updateVisualizer(); }
        applyDucking(isSpeaking) { if (this.currentAudioElement) this.currentAudioElement.volume = isSpeaking ? parseFloat(duckingSlider.value) : 1.0; }
        updateStatus(status, message) { this.status = status; this.config.ui.statusLight.className = `session-status-light ${status}`; this.addSystemMessage(message, status === 'error' || status === 'failed'); }
        updateTranscript(message) { const text = message.text || message.translatedText; if (!text) return; const el = document.createElement('div'); el.className = 'phrase'; el.textContent = text; this.config.ui.transcript.insertBefore(el, this.config.ui.transcript.firstChild); }
        addSystemMessage(text, isError = false) { const el = document.createElement('div'); el.className = isError ? 'phrase system-message error' : 'phrase system-message'; el.textContent = text; this.config.ui.transcript.insertBefore(el, this.config.ui.transcript.firstChild); }
        updateVisualizer() { if (!this.config.ui.visualizer) return; this.config.ui.visualizer.style.width = `${Math.min(100, this.audioLevel * 800)}%`; this.config.ui.visualizer.classList.toggle('muted', this.muted); }
        toggleMute() { this.muted = !this.muted; this.config.ui.muteBtn.classList.toggle('muted', this.muted); }
        toggleAudio(enabled) { this.audioEnabled = enabled; if (this.status === 'connected') this.send({ type: 'voice', enabled: this.audioEnabled }); if (!this.audioEnabled) this.stopAudioPlayback(); }
    }

    // --- ORCHESTRATOR ---
    function handleConnectionToggle() {
        if (state.isConnecting) { disconnectAll(); }
        else if (state.isConnected) { disconnectAll(); }
        else { connectAll(); }
    }

    async function connectAll() {
        if (state.isConnecting) return;
        state.isConnecting = true;
        updateConnectionButton(true, "Cancel");
        // Get the latest settings from the UI just before connecting
        const outConfig = getConfigFromUI('outgoing');
        const inConfig = getConfigFromUI('incoming');
        state.outgoingSession = new WordlySession('join', outConfig);
        state.incomingSession = new WordlySession('attend', inConfig);
        try {
            await Promise.all([ state.outgoingSession.connect(), state.incomingSession.connect() ]);
            state.isConnected = true;
        } catch (error) {
            console.error("Failed to connect one or more sessions:", error);
            if (state.outgoingSession.status === 'connected') state.outgoingSession.disconnect();
            if (state.incomingSession.status === 'connected') state.incomingSession.disconnect();
            state.isConnected = false;
        } finally {
            state.isConnecting = false;
            updateConnectionButton(false);
        }
    }

    function disconnectAll() {
        state.outgoingSession?.disconnect(); state.incomingSession?.disconnect();
        state.isConnected = false; state.isConnecting = false;
        updateConnectionButton(false);
    }
    
    function getConfigFromUI(type, fromLoginPage = false) {
        const idPrefix = type;
        const sourceElement = fromLoginPage ? document : appPage;
        // Use the stored credentials for subsequent connections
        const creds = fromLoginPage ? sourceElement : state.sessionConfigs;

        return {
            sessionId: creds.getElementById(`${idPrefix}-session-id`).value, 
            passcode: creds.getElementById(`${idPrefix}-passcode`)?.value,
            inputDeviceId: document.getElementById(`${idPrefix}-input-device-select`).value, 
            sourceLanguage: document.getElementById(`${idPrefix}-source-language-select`).value,
            targetLanguage: document.getElementById(`${idPrefix}-target-language-select`).value, 
            outputDeviceId: document.getElementById(`${idPrefix}-output-device-select`).value,
            ui: { statusLight: document.querySelector(`#${idPrefix}-session .session-status-light`), 
                  transcript: document.querySelector(`#${idPrefix}-session .session-transcript`),
                  visualizer: document.querySelector(`#${idPrefix}-session .audio-level`), 
                  muteBtn: document.querySelector(`#${idPrefix}-session .mute-btn`),
            }
        };
    }
    
    function updateConnectionButton(isConnecting, text) {
        const btn = connectionToggleBtn;
        btn.disabled = false;
        if (isConnecting) { btn.textContent = text || "Connecting..."; btn.className = "disconnect-button"; }
        else { btn.textContent = state.isConnected ? "Disconnect All" : "Connect All"; btn.className = state.isConnected ? "disconnect-button" : "connect-button"; }
    }

    function setupUIEventListeners() {
        document.querySelector('#outgoing-session .mute-btn').onclick = () => state.outgoingSession?.toggleMute();
        document.getElementById('incoming-audio-toggle').onchange = (e) => state.incomingSession?.toggleAudio(e.target.checked);
    }

    async function refreshAllDeviceLists() {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        stream.getTracks().forEach(track => track.stop());
        const inputDevices = devices.filter(d => d.kind === 'audioinput');
        const outputDevices = devices.filter(d => d.kind === 'audiooutput');
        populateDeviceDropdown('outgoing-input-device-select', inputDevices);
        populateDeviceDropdown('incoming-input-device-select', inputDevices);
        populateDeviceDropdown('outgoing-output-device-select', outputDevices, true);
        populateDeviceDropdown('incoming-output-device-select', outputDevices, true);
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
        selects.forEach(select => { for (const [code, name] of Object.entries(languageMap)) select.add(new Option(name, code)); });
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
    
    init();
});
