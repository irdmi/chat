/**
 * CallModule - WebRTC логика для Secure Chat
 */
export class CallModule {
  constructor(chatModule, proxyUrl) {
    this.chat = chatModule;
    this.proxyUrl = proxyUrl;
    this.pc = null;
    this.localStream = null;
    this.remoteVideoEl = null;
    this.localVideoEl = null;
    this.FILE_CALL = 'chat-calls';
    this.isRelay = false;
    this.callTimerInterval = null;
    this.isMuted = false;
    this.isVideoOff = false;
    this.pendingCandidates = []; // Очередь для кандидатов
    this.processingCandidates = false;
  }

  async init(videoElRemote, videoElLocal) {
    this.remoteVideoEl = videoElRemote;
    this.localVideoEl = videoElLocal;
    console.log('[Call] UI initialized');
  }

  async startCall(audio = true, video = false) {
    try {
      console.log('[Call] Requesting media...', { audio, video });
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: audio,
        video: video ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      });

      if (this.localVideoEl) {
        this.localVideoEl.srcObject = this.localStream;
      }

      this.createPeerConnection();

      this.localStream.getTracks().forEach(track => {
        this.pc.addTrack(track, this.localStream);
        console.log('[Call] Added track:', track.kind);
      });

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      console.log('[Call] Local description set, sending offer');

      // Ждем немного, чтобы ICE начал собирать кандидатов, но отправляем Offer сразу
      await this.sendSignal({ type: 'offer', sdp: this.pc.localDescription.sdp });

      this.updateStatus('Calling...');
      this.startTimer();
      
      return 'OUTGOING';
    } catch (err) {
      console.error('[Call] Start failed:', err);
      alert('Ошибка доступа к медиа: ' + err.message);
      this.hangup();
      return 'ERROR';
    }
  }

  createPeerConnection() {
    const config = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10
    };

    this.pc = new RTCPeerConnection(config);

    this.pc.ontrack = (event) => {
      console.log('[Call] Remote track received:', event.track.kind);
      if (this.remoteVideoEl && event.streams && event.streams[0]) {
        this.remoteVideoEl.srcObject = event.streams[0];
        this.remoteVideoEl.play().catch(e => console.warn('Autoplay blocked:', e));
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[Call] ICE candidate generated');
        this.sendSignal({ type: 'ice', candidate: event.candidate });
      } else {
        console.log('[Call] ICE gathering complete');
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log('[Call] ICE State:', state);
      
      if (state === 'connected') {
        this.updateStatus('Connected');
        this.checkRelayStatus();
      } else if (state === 'failed') {
        this.updateStatus('Connection failed');
        // Пытаемся перезапустить ICE
        setTimeout(() => this.pc.restartIce(), 1000);
      } else if (state === 'disconnected') {
        this.updateStatus('Disconnected');
      } else {
        this.updateStatus(state);
      }
    };
  }

  async handleSignal(data) {
    if (!this.pc) this.createPeerConnection();

    try {
      if (data.type === 'offer') {
        console.log('[Call] Processing Offer');
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        
        await this.sendSignal({ type: 'answer', sdp: this.pc.localDescription.sdp });
        this.updateStatus('Connecting...');
        this.startTimer();
        
        // Обрабатываем накопленные кандидаты после установки remoteDescription
        await this.processPendingCandidates();

      } else if (data.type === 'answer') {
        console.log('[Call] Processing Answer');
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        await this.processPendingCandidates();

      } else if (data.type === 'ice') {
        console.log('[Call] Received ICE candidate');
        const candidate = new RTCIceCandidate(data.candidate);
        
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(candidate);
        } else {
          this.pendingCandidates.push(candidate);
          console.log('[Call] Candidate queued (no remote desc yet)');
        }
      }
    } catch (err) {
      console.error('[Call] Signal error:', err);
      if (!err.message.includes('Duplicate') && !err.message.includes('conflict')) {
        throw err;
      }
    }
  }

  async processPendingCandidates() {
    if (this.processingCandidates) return;
    this.processingCandidates = true;

    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn('[Call] Failed to add queued candidate:', e);
      }
    }
    this.processingCandidates = false;
  }

  async sendSignal(payload) {
    if (!this.chat.currentSeed) {
      console.error('[Call] No seed for encryption');
      return;
    }

    try {
      const msg = JSON.stringify(payload);
      const encrypted = CryptoJS.AES.encrypt(msg, this.chat.currentSeed).toString();

      const response = await fetch(`${this.proxyUrl}?action=write&file=${this.FILE_CALL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted })
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[Call] Send error:', response.status, text);
        throw new Error(`Send failed: ${response.status}`);
      }
    } catch (err) {
      console.error('[Call] Send signal failed:', err);
      // Не прерываем выполнение, чтобы не ломать звонок полностью
    }
  }

  async loadSignals() {
    if (!this.chat.currentSeed) return;

    try {
      const response = await fetch(`${this.proxyUrl}?action=read&file=${this.FILE_CALL}`);
      if (!response.ok) return;

      const data = await response.json();
      if (!data.messages) return;

      for (const item of data.messages) {
        try {
          const bytes = CryptoJS.AES.decrypt(item.encrypted, this.chat.currentSeed);
          const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
          if (!decryptedStr) continue;

          const decryptedData = JSON.parse(decryptedStr);
          if (decryptedData.type === 'offer' || decryptedData.type === 'answer' || decryptedData.type === 'ice') {
            await this.handleSignal(decryptedData);
          }
        } catch (e) {
          // Игнорируем ошибки расшифровки чужих сообщений
        }
      }
    } catch (err) {
      // Игнорируем ошибки сети
    }
  }

  checkRelayStatus() {
    if (!this.pc) return;
    const sender = this.pc.getSenders()[0];
    if (sender && sender.transport && sender.transport.iceTransport) {
      const pair = sender.transport.iceTransport.getSelectedCandidatePair();
      if (pair && pair.remote) {
        this.isRelay = (pair.remote.type === 'relay');
        const badge = document.getElementById('call-type');
        if (badge) {
          badge.textContent = this.isRelay ? '🟡 Relay' : '🟢 Direct';
          badge.className = 'badge ' + (this.isRelay ? 'relay' : 'direct');
        }
        console.log('[Call] Connection type:', this.isRelay ? 'RELAY (TURN needed)' : 'DIRECT (P2P)');
        
        if (this.isRelay) {
           console.warn('[Call] Using Relay. Without a TURN server, media may not flow through strict NATs.');
        }
      }
    }
  }

  hangup() {
    if (this.pc) { this.pc.close(); this.pc = null; }
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    if (this.remoteVideoEl) this.remoteVideoEl.srcObject = null;
    if (this.localVideoEl) this.localVideoEl.srcObject = null;
    
    this.stopTimer();
    this.updateStatus('Call ended');
    document.getElementById('call-overlay')?.classList.add('hidden');
  }

  toggleMute() {
    if (!this.localStream) return;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      this.isMuted = !audioTrack.enabled;
      audioTrack.enabled = !this.isMuted;
      const btn = document.getElementById('btn-mute');
      if (btn) btn.textContent = this.isMuted ? '🎤' : '🔇';
    }
  }

  toggleVideo() {
    if (!this.localStream) return;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      this.isVideoOff = !videoTrack.enabled;
      videoTrack.enabled = !this.isVideoOff;
      const btn = document.getElementById('btn-video');
      if (btn) btn.textContent = this.isVideoOff ? '📹' : '🚫📹';
    }
  }

  updateStatus(text) {
    const el = document.getElementById('call-status');
    if (el) el.textContent = text;
  }

  startTimer() {
    this.stopTimer();
    let seconds = 0;
    const el = document.getElementById('call-timer');
    if (!el) return;
    this.callTimerInterval = setInterval(() => {
      seconds++;
      const m = Math.floor(seconds / 60).toString().padStart(2, '0');
      const s = (seconds % 60).toString().padStart(2, '0');
      el.textContent = `${m}:${s}`;
    }, 1000);
  }

  stopTimer() {
    if (this.callTimerInterval) clearInterval(this.callTimerInterval);
  }
}
