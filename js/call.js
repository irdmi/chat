/**
 * CallModule - WebRTC логика для Secure Chat
 * Оптимизировано для минимизации запросов к API (batching ICE кандидатов)
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
    
    // Флаг для контроля отправки ICE кандидатов
    this.iceGatheringComplete = false;
  }

  async init(videoElRemote, videoElLocal) {
    this.remoteVideoEl = videoElRemote;
    this.localVideoEl = videoElLocal;
    console.log('[Call] UI initialized');
  }

  async startCall(audio = true, video = false) {
    try {
      console.log('[Call] Starting call...');
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
      });

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Ждем завершения сбора ICE кандидатов перед отправкой Offer
      // Это позволяет отправить всё одним пакетом
      await this.waitForIceGathering();

      console.log('[Call] Sending Offer with bundled ICE candidates');
      await this.sendSignal({
        type: 'offer',
        sdp: this.pc.localDescription.sdp
      });

      this.updateStatus('Calling...');
      this.startTimer();
      
      return 'OUTGOING';

    } catch (err) {
      console.error('[Call] Start failed:', err);
      alert('Не удалось получить доступ к камере/микрофону: ' + err.message);
      this.hangup();
      return 'ERROR';
    }
  }

  createPeerConnection() {
    const config = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    this.pc = new RTCPeerConnection(config);

    this.pc.ontrack = (event) => {
      console.log('[Call] Remote track received');
      if (this.remoteVideoEl && event.streams && event.streams[0]) {
        this.remoteVideoEl.srcObject = event.streams[0];
        this.remoteVideoEl.play().catch(e => console.warn('Auto-play prevented:', e));
      }
    };

    // Обработка ICE: больше не отправляем каждый кандидат отдельно!
    // Мы ждем окончания сбора в startCall/handleSignal
    this.pc.onicecandidate = (event) => {
      if (event.candidate === null) {
        this.iceGatheringComplete = true;
        console.log('[Call] ICE gathering complete');
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('[Call] ICE State:', this.pc.iceConnectionState);
      
      if (this.pc.iceConnectionState === 'connected') {
        this.updateStatus('Connected');
        this.checkRelayStatus();
      } else if (this.pc.iceConnectionState === 'failed') {
        this.updateStatus('Connection failed');
        this.pc.restartIce();
      } else if (this.pc.iceConnectionState === 'disconnected') {
        this.updateStatus('Disconnected');
      }
    };
  }

  // Вспомогательная функция для ожидания сбора ICE
  waitForIceGathering() {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') {
        resolve();
      } else {
        const checkState = () => {
          if (this.pc.iceGatheringState === 'complete') {
            this.pc.removeEventListener('icegatheringstatechange', checkState);
            resolve();
          }
        };
        this.pc.addEventListener('icegatheringstatechange', checkState);
        
        // Таймаут на случай, если событие не сработает (10 сек)
        setTimeout(() => {
          this.pc.removeEventListener('icegatheringstatechange', checkState);
          console.warn('[Call] ICE gathering timeout, proceeding anyway');
          resolve();
        }, 10000);
      }
    });
  }

  async handleSignal(data) {
    if (!this.pc) this.createPeerConnection();

    try {
      if (data.type === 'offer') {
        console.log('[Call] Received Offer, creating Answer...');
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        
        // Ждем сбора ICE кандидатов для ответа
        await this.waitForIceGathering();
        
        console.log('[Call] Sending Answer with bundled ICE candidates');
        await this.sendSignal({
          type: 'answer',
          sdp: this.pc.localDescription.sdp
        });
        
        this.updateStatus('Connecting...');
        this.startTimer();

      } else if (data.type === 'answer') {
        console.log('[Call] Received Answer');
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));

      } else if (data.type === 'ice') {
        // Обработка отдельных кандидатов (на всякий случай, если придут)
        const candidate = new RTCIceCandidate(data.candidate);
        if (!this.pc.remoteDescription) {
           console.warn('[Call] Received ICE before remote description, queuing...');
           // В простой реализации просто игнорируем или пробуем добавить позже
        } else {
          await this.pc.addIceCandidate(candidate).catch(e => console.warn('Add ICE failed', e));
        }
      }
    } catch (err) {
      console.error('[Call] Signal handling error:', err);
      if (!err.message.includes('Duplicate')) {
        throw err;
      }
    }
  }

  async sendSignal(payload) {
    if (!this.chat.currentSeed) {
      console.error('[Call] No seed for encryption');
      return;
    }

    try {
      const msg = JSON.stringify(payload);
      const encrypted = CryptoJS.AES.encrypt(msg, this.chat.currentSeed).toString();

      // ОДИН запрос на весь сигнал (Offer/Answer) вместо десятков на кандидатов
      const response = await fetch(`${this.proxyUrl}?action=write&file=${this.FILE_CALL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted })
      });

      if (!response.ok) {
        const text = await response.text();
        // Логируем ошибку, но не выбрасываем исключение сразу, чтобы не ломать поток
        console.error(`[Call] Send failed: ${response.status}`, text);
        throw new Error(`Server error: ${response.status}`);
      }
      
      console.log('[Call] Signal sent successfully:', payload.type);
    } catch (err) {
      console.error('[Call] Send signal failed:', err);
      throw err;
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
          const decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));

          if (decryptedData && (decryptedData.type === 'offer' || decryptedData.type === 'answer' || decryptedData.type === 'ice')) {
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
        console.log('[Call] Connection type:', this.isRelay ? 'RELAY' : 'DIRECT');
      }
    }
  }

  hangup() {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    if (this.remoteVideoEl) this.remoteVideoEl.srcObject = null;
    if (this.localVideoEl) this.localVideoEl.srcObject = null;
    
    this.stopTimer();
    this.updateStatus('Call ended');
    
    const overlay = document.getElementById('call-overlay');
    if (overlay) overlay.classList.add('hidden');
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
    if (this.callTimerInterval) {
      clearInterval(this.callTimerInterval);
      this.callTimerInterval = null;
    }
  }
}
