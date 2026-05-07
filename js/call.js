/**
 * CallModule - WebRTC логика для Secure Chat
 * Обрабатывает создание соединения, обмен сигналами и управление медиа.
 */
export class CallModule {
  constructor(chatModule, proxyUrl) {
    this.chat = chatModule;        // Объект чата (нужен currentSeed)
    this.proxyUrl = proxyUrl;      // URL Cloudflare Worker
    this.pc = null;                // RTCPeerConnection
    this.localStream = null;       // Локальный MediaStream
    this.remoteVideoEl = null;     // Ссылка на DOM элемент удаленного видео
    this.localVideoEl = null;      // Ссылка на DOM элемент локального видео
    
    this.FILE_CALL = 'chat-calls'; // Имя файла в Gist для сигналов
    this.isRelay = false;          // Флаг использования TURN
    this.callTimerInterval = null; // Таймер длительности звонка
    this.isMuted = false;
    this.isVideoOff = false;
    
    // Очередь кандидатов, если remoteDescription еще не установлен
    this.pendingCandidates = [];
  }

  /**
   * Инициализация: сохранение ссылок на DOM элементы
   */
  async init(videoElRemote, videoElLocal) {
    this.remoteVideoEl = videoElRemote;
    this.localVideoEl = videoElLocal;
    console.log('[Call] UI initialized');
  }

  /**
   * Старт звонка (инициатор)
   * @param {boolean} audio - Запрашивать ли аудио
   * @param {boolean} video - Запрашивать ли видео
   */
  async startCall(audio = true, video = false) {
    try {
      // 1. Получаем доступ к медиаустройствам
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: audio,
        video: video ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      });

      // Отображаем локальное видео
      if (this.localVideoEl) {
        this.localVideoEl.srcObject = this.localStream;
      }

      // 2. Создаем PeerConnection с приоритетом STUN Cloudflare
      this.createPeerConnection();

      // 3. Добавляем треки в соединение
      this.localStream.getTracks().forEach(track => {
        this.pc.addTrack(track, this.localStream);
      });

      // 4. Создаем Offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Ждем, пока ICE соберет кандидатов (или отправляем сразу с trickle)
      // Для простоты отправляем offer сразу, кандидаты дошлются отдельно
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

  /**
   * Создание RTCPeerConnection
   */
  createPeerConnection() {
    const config = {
      iceServers: [
        // ПРИОРИТЕТ 1: Cloudflare STUN
        { urls: 'stun:stun.cloudflare.com:3478' },
        // ПРИОРИТЕТ 2: Google STUN
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    this.pc = new RTCPeerConnection(config);

    // Обработка входящего потока (удаленное видео/аудио)
    this.pc.ontrack = (event) => {
      console.log('[Call] Remote track received');
      if (this.remoteVideoEl && event.streams && event.streams[0]) {
        this.remoteVideoEl.srcObject = event.streams[0];
        // Пытаемся автовоспроизведение
        this.remoteVideoEl.play().catch(e => console.warn('Auto-play prevented:', e));
      }
    };

    // Обработка ICE кандидатов
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          type: 'ice',
          candidate: event.candidate
        });
      }
    };

    // Отслеживание состояния соединения
    this.pc.oniceconnectionstatechange = () => {
      console.log('[Call] ICE State:', this.pc.iceConnectionState);
      
      if (this.pc.iceConnectionState === 'connected') {
        this.updateStatus('Connected');
        this.checkRelayStatus();
      } else if (this.pc.iceConnectionState === 'failed') {
        this.updateStatus('Connection failed');
        // Попытка рестарта ICE
        this.pc.restartIce();
      } else if (this.pc.iceConnectionState === 'disconnected') {
        this.updateStatus('Disconnected');
      }
    };
    
    // Обработка состояния signaling (для отладки)
    this.pc.onsignalingstatechange = () => {
        console.log('[Call] Signaling State:', this.pc.signalingState);
    };
  }

  /**
   * Обработка входящих сигналов (Offer, Answer, ICE)
   */
  async handleSignal(data) {
    if (!this.pc) this.createPeerConnection();

    try {
      if (data.type === 'offer') {
        // Если получили Offer, значит мы принимающая сторона
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        
        // Создаем ответ
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        
        // Отправляем Answer обратно
        await this.sendSignal({
          type: 'answer',
          sdp: this.pc.localDescription.sdp
        });
        
        this.updateStatus('Connecting...');
        this.startTimer();

      } else if (data.type === 'answer') {
        // Если получили Answer, значит мы инициирующая сторона
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));

      } else if (data.type === 'ice') {
        const candidate = new RTCIceCandidate(data.candidate);
        
        // Если remoteDescription еще не установлен, сохраняем кандидата в очередь
        if (!this.pc.remoteDescription) {
          this.pendingCandidates.push(candidate);
          console.log('[Call] Queued ICE candidate (no remote desc yet)');
        } else {
          await this.pc.addIceCandidate(candidate);
        }
      }
    } catch (err) {
      console.error('[Call] Signal handling error:', err);
      // Игнорируем ошибки дубликатов кандидатов
      if (!err.message.includes('Duplicate')) {
        throw err;
      }
    }
  }

  /**
   * Отправка сигнала через Worker
   */
  async sendSignal(payload) {
    if (!this.chat.currentSeed) {
      console.error('[Call] No seed for encryption');
      return;
    }

    try {
      const msg = JSON.stringify(payload);
      // Шифрование сообщения текущим ключом сессии
      const encrypted = CryptoJS.AES.encrypt(msg, this.chat.currentSeed).toString();

      const response = await fetch(`${this.proxyUrl}?action=write&file=${this.FILE_CALL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Server error: ${response.status} ${text}`);
      }
      
      // console.log('[Call] Signal sent:', payload.type);
    } catch (err) {
      console.error('[Call] Send signal failed:', err);
      // Не прерываем выполнение, пробуем отправить следующие кандидаты
    }
  }

  /**
   * Загрузка сигналов из Gist (Polling)
   */
  async loadSignals() {
    if (!this.chat.currentSeed) return;

    try {
      const response = await fetch(`${this.proxyUrl}?action=read&file=${this.FILE_CALL}`);
      if (!response.ok) return;

      const data = await response.json();
      if (!data.messages) return;

      // Проходим по всем сообщениям
      for (const item of data.messages) {
        try {
          const bytes = CryptoJS.AES.decrypt(item.encrypted, this.chat.currentSeed);
          const decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));

          // Фильтруем только WebRTC сигналы
          if (decryptedData && (decryptedData.type === 'offer' || decryptedData.type === 'answer' || decryptedData.type === 'ice')) {
             // Простая защита от повторной обработки своих же сообщений можно добавить по ID, 
             // но для MVP полагаемся на логику WebRTC (дубликаты он съест или игнор)
             await this.handleSignal(decryptedData);
          }
        } catch (e) {
          // Ошибка расшифровки конкретного сообщения (не наш ключ или мусор) - игнорируем
        }
      }
    } catch (err) {
      // Ошибка сети - игнорируем до следующего поллинга
    }
  }

  /**
   * Проверка типа соединения (Direct P2P или Relay)
   */
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

  /**
   * Завершение звонка
   */
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
    
    // Сброс UI
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
  
  // Метод для обработки входящего вызова (если нужно расширение)
  async acceptCall() {
      // Логика аналогична созданию ответа в handleSignal, но вызывается явно из UI
      // Для текущего MVP достаточно автоматической обработки в handleSignal при получении offer
  }
}
