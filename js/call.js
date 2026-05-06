// js/call.js - WebRTC Call Module

export class CallModule {
  constructor(chatModule, proxyUrl) {
    this.chat = chatModule;        // объект с { currentSeed }
    this.proxyUrl = proxyUrl;      // URL Cloudflare Worker
    this.pc = null;                // RTCPeerConnection
    this.localStream = null;       // MediaStream локального видео/аудио
    this.FILE_CALL = 'chat-calls'; // отдельный файл в Gist для сигналов
    this.isRelay = false;          // флаг: используется ли TURN/relay
    this.remoteVideo = null;
    this.localVideo = null;
    this.callState = 'IDLE';       // IDLE, OUTGOING, INCOMING, CONNECTED
    this.timerInterval = null;
    this.callStartTime = 0;
    this.lastSignalId = null;      // для отслеживания уже обработанных сигналов
  }

  async init(videoElRemote, videoElLocal) {
    this.remoteVideo = videoElRemote;
    this.localVideo = videoElLocal;
    return Promise.resolve();
  }

  async startCall(audio = true, video = false) {
    try {
      // 1. Запрашиваем медиа
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
      
      if (this.localVideo) {
        this.localVideo.srcObject = this.localStream;
      }

      // 2. Создаём RTCPeerConnection с ICE-серверами
      this.pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      });

      // 3. Добавляем треки
      this.localStream.getTracks().forEach(track => {
        this.pc.addTrack(track, this.localStream);
      });

      // 4. Настраиваем обработчики
      this.pc.ontrack = (event) => {
        if (this.remoteVideo && event.streams[0]) {
          this.remoteVideo.srcObject = event.streams[0];
        }
      };

      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendSignal({ type: 'ice', candidate: event.candidate });
        }
      };

      this.pc.oniceconnectionstatechange = () => {
        this.updateStatus(this.pc.iceConnectionState);
        if (this.pc.iceConnectionState === 'connected' || 
            this.pc.iceConnectionState === 'completed') {
          this.checkRelayStatus();
        }
      };

      this.pc.onconnectionstatechange = () => {
        this.updateStatus(this.pc.connectionState);
      };

      // 5. Создаём и отправляем offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Ждём пока setLocalDescription заполнит sdp
      await new Promise(resolve => {
        if (this.pc.localDescription) {
          resolve();
        } else {
          this.pc.onnegotiationneeded = resolve;
        }
      });

      await this.sendSignal({ 
        type: 'offer', 
        sdp: this.pc.localDescription 
      });

      // 6. Запускаем таймер
      this.callState = 'OUTGOING';
      this.startTimer();
      this.updateStatus('Connecting...');

      // Начинаем polling сигналов
      this.startSignalPolling();

      return 'OUTGOING';
    } catch (err) {
      // Silently ignore start call errors
      throw err;
    }
  }

  async handleSignal(payload) {
    try {
      if (!this.pc) {
        // Silently ignore signals without peer connection
        return;
      }

      switch (payload.type) {
        case 'offer':
          if (this.callState !== 'INCOMING') {
            this.callState = 'INCOMING';
            await this.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            
            // Ждём пока setLocalDescription заполнит sdp
            await new Promise(resolve => {
              setTimeout(resolve, 100);
            });
            
            await this.sendSignal({ 
              type: 'answer', 
              sdp: this.pc.localDescription 
            });
            this.startTimer();
            this.updateStatus('Connected');
          }
          break;

        case 'answer':
          if (payload.sdp) {
            await this.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            this.callState = 'CONNECTED';
            this.updateStatus('Connected');
          }
          break;

        case 'ice':
          if (payload.candidate) {
            try {
              await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
            } catch (e) {
              // Silently ignore ICE candidate errors
            }
          }
          break;

        default:
          // Silently ignore unknown signal types
      }
    } catch (err) {
      // Silently ignore handle signal errors
    }
  }

  async sendSignal(payload) {
    try {
      const msg = {
        type: 'webrtc-signal',
        payload: payload,
        from: this.chat.currentUser || 'unknown',
        timestamp: Date.now()
      };

      // Шифруем сообщение текущим seed чата
      const encrypted = CryptoJS.AES.encrypt(
        JSON.stringify(msg), 
        this.chat.currentSeed || ''
      ).toString();

      // Отправляем зашифрованное сообщение в отдельный файл chat-calls
      // Воркер сам прочитает текущее содержимое и добавит новое сообщение
      const response = await fetch(
        `${this.proxyUrl}?action=write&file=${this.FILE_CALL}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ encrypted: encrypted })
        }
      );

      const result = await response.json();
      if (!result.success && response.status !== 200 && response.status !== 201) {
        // Игнорируем ошибки, если статус не успех, но продолжаем работу
        // Иногда воркер возвращает 200 без поля success
      }
      return result;
    } catch (err) {
      // Silently ignore send signal errors
      throw err;
    }
  }

  async loadSignals() {
    try {
      const url = `${this.proxyUrl}?action=read&file=${this.FILE_CALL}&t=${Date.now()}`;
      const response = await fetch(url, { 
        headers: { 'Accept': 'application/json' } 
      });

      if (!response.ok) {
        // Файл может не существовать ещё - это нормально
        if (response.status === 404) {
          return;
        }
        throw new Error('HTTP ' + response.status);
      }

      const data = await response.json();
      
      let messagesToProcess = [];
      
      // Поддержка разных форматов ответа от воркера
      // Формат 1: { messages: [{ encrypted: '...' }, ...] } - основной формат нашего воркера
      if (data.messages && Array.isArray(data.messages)) {
        messagesToProcess = data.messages.map(m => m.encrypted || m);
      } 
      // Формат 2: { content: ['encrypted1', 'encrypted2', ...] }
      else if (data.content && Array.isArray(data.content)) {
        messagesToProcess = data.content;
      } 
      // Формат 3: { files: { 'chat-calls': { content: '[...]' } } }
      else if (data.files && data.files[this.FILE_CALL]) {
        const fileData = data.files[this.FILE_CALL];
        if (fileData.content) {
          try {
            const parsed = JSON.parse(fileData.content);
            if (Array.isArray(parsed)) {
              messagesToProcess = parsed;
            }
          } catch(e) {}
        }
      }

      for (const encrypted of messagesToProcess) {
        try {
          const bytes = CryptoJS.AES.decrypt(encrypted, this.chat.currentSeed || '');
          const decrypted = bytes.toString(CryptoJS.enc.Utf8);
          
          if (decrypted) {
            const parsed = JSON.parse(decrypted);
            
            // Фильтруем только webrtc-signal
            if (parsed.type === 'webrtc-signal' && parsed.payload) {
              // Игнорируем свои собственные сигналы
              if (parsed.from !== (this.chat.currentUser || '')) {
                await this.handleSignal(parsed.payload);
              }
            }
          }
        } catch (e) {
          // Тихо игнорируем ошибки расшифровки - это могут быть старые сообщения с другим ключом
        }
      }
    } catch (err) {
      // Тихо игнорируем ошибки загрузки - файл может не существовать
    }
  }

  startSignalPolling() {
    // Останавливаем предыдущий polling если есть
    if (this.signalPollingInterval) {
      clearInterval(this.signalPollingInterval);
    }
    
    // Poll каждые 500ms во время звонка
    this.signalPollingInterval = setInterval(() => {
      if (this.callState === 'OUTGOING' || this.callState === 'INCOMING' || this.callState === 'CONNECTED') {
        this.loadSignals();
      }
    }, 500);
  }

  stopSignalPolling() {
    if (this.signalPollingInterval) {
      clearInterval(this.signalPollingInterval);
      this.signalPollingInterval = null;
    }
  }

  checkRelayStatus() {
    try {
      const senders = this.pc.getSenders();
      if (senders.length > 0 && senders[0].transport) {
        const iceTransport = senders[0].transport.iceTransport;
        if (iceTransport) {
          const candidates = iceTransport.getSelectedCandidatePair();
          if (candidates && candidates.remote) {
            this.isRelay = candidates.remote.type === 'relay';
            this.updateCallTypeBadge();
          }
        }
      }
    } catch (e) {
      // Silently ignore relay status check errors
    }
  }

  updateCallTypeBadge() {
    const badge = document.getElementById('call-type');
    if (badge) {
      if (this.isRelay) {
        badge.textContent = '🟡 Relay';
        badge.className = 'badge relay';
      } else {
        badge.textContent = '🟢 Direct';
        badge.className = 'badge direct';
      }
    }
  }

  hangup() {
    // Останавливаем медиа
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Закрываем peer connection
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    // Очищаем видео
    if (this.localVideo) {
      this.localVideo.srcObject = null;
    }
    if (this.remoteVideo) {
      this.remoteVideo.srcObject = null;
    }

    // Останавливаем таймер
    this.stopTimer();

    // Останавливаем polling
    this.stopSignalPolling();

    this.callState = 'IDLE';
    this.updateStatus('Call ended');
    
    // Скрываем оверлей через UI callback если есть
    if (this.onHangup) {
      this.onHangup();
    }
  }

  toggleMute() {
    if (!this.localStream) return;
    
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const btn = document.getElementById('btn-mute');
      if (btn) {
        btn.textContent = audioTrack.enabled ? '🔇' : '🎤';
        btn.classList.toggle('active', !audioTrack.enabled);
      }
    }
  }

  toggleVideo() {
    if (!this.localStream) return;
    
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      const btn = document.getElementById('btn-video');
      if (btn) {
        btn.textContent = videoTrack.enabled ? '📹' : '📷';
        btn.classList.toggle('active', !videoTrack.enabled);
      }
    }
  }

  startTimer() {
    this.callStartTime = Date.now();
    this.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.callStartTime) / 1000);
      const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const seconds = (elapsed % 60).toString().padStart(2, '0');
      
      const timerEl = document.getElementById('call-timer');
      if (timerEl) {
        timerEl.textContent = `${minutes}:${seconds}`;
      }
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  updateStatus(status) {
    const statusEl = document.getElementById('call-status');
    if (statusEl) {
      statusEl.textContent = status;
    }
  }
}
