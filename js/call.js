const PROXY_URL = 'https://chat.gigpino7.workers.dev';

let currentUser = '';
let currentSeed = '';
let currentRoom = '';
let localStream = null;
let peerConnection = null;
let isConnected = false;
let isInitiator = false; // true = создали offer, false = принимаем offer
let hasSentSdp = false; // Отправили ли мы уже свой SDP
let pollInterval = null;
let lastProcessedIndex = -1;
let connectionTypeDisplay = null;

// Cloudflare STUN + Google backup
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const seedFromUrl = urlParams.get('seed');
  const nameFromUrl = urlParams.get('name');
  
  if (seedFromUrl && nameFromUrl) {
    document.getElementById('roomInput').value = seedFromUrl;
    document.getElementById('userName').value = nameFromUrl;
    setTimeout(() => enterCall(), 300);
  }
});

// ===== CORE FUNCTIONS =====
function enterCall() {
  const nameInput = document.getElementById('userName');
  const roomInput = document.getElementById('roomInput');
  
  currentUser = nameInput.value.trim();
  currentSeed = roomInput.value.trim();
  currentRoom = 'sdp_' + currentSeed;
  
  if (!currentUser || !currentSeed) {
    alert('Введите имя и ключ комнаты!');
    return;
  }
  
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('call-screen').style.display = 'flex';
  document.getElementById('roomInfo').textContent = 'Комната: ' + currentSeed;
  
  updateStatus('Подключение к комнате...', 'disconnected');
  updateConnectionType('Ожидание...');
  
  // Сразу начинаем мониторинг комнаты
  startMonitoring();
}

async function startCall() {
  if (isConnected) {
    endCall();
    return;
  }
  
  try {
    updateStatus('Запрос доступа к камере...', 'connecting');
    
    localStream = await navigator.mediaDevices.getUserMedia({ 
      video: true, 
      audio: true 
    });
    
    document.getElementById('localVideo').srcObject = localStream;
    createPeerConnection();
    
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    // Создаём OFFER
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    // Ждем ICE кандидаты (недолго)
    await waitForIceGathering(3000);
    
    // Отправляем OFFER
    const sdpData = {
      type: 'offer',
      sdp: peerConnection.localDescription.sdp,
      from: currentUser,
      timestamp: Date.now()
    };
    
    await sendSdpMessage(sdpData);
    hasSentSdp = true;
    isInitiator = true;
    
    updateStatus('Звонок... Ожидание ответа', 'connecting');
    updateConnectionType('Отправка Offer через GitHub Gist');
    
    enableCallControls(true);
    
  } catch (err) {
    console.error('Start call error:', err);
    updateStatus('Ошибка: ' + err.message, 'disconnected');
    alert('Не удалось начать звонок: ' + err.message);
  }
}

function createPeerConnection() {
  if (peerConnection) {
    peerConnection.close();
  }
  
  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('ICE candidate generated');
    }
  };
  
  peerConnection.ontrack = (event) => {
    console.log('Remote track received');
    const remoteVideo = document.getElementById('remoteVideo');
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    }
  };
  
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('Connection state:', state);
    
    if (state === 'connected') {
      isConnected = true;
      updateStatus('✓ Соединение установлено!', 'connected');
      
      // Определяем тип подключения
      const stats = peerConnection.getStats();
      let selectedType = 'STUN';
      
      stats.then(report => {
        report.forEach(value => {
          if (value.type === 'candidate-pair' && value.state === 'succeeded' && value.nominated) {
            const remoteCandidate = report.get(value.remoteCandidateId);
            if (remoteCandidate) {
              if (remoteCandidate.address.includes('172.') || remoteCandidate.address.includes('10.') || remoteCandidate.address.includes('192.')) {
                selectedType = 'P2P (локальная сеть)';
              } else if (remoteCandidate.protocol === 'udp') {
                selectedType = 'STUN (UDP)';
              } else {
                selectedType = 'STUN (TCP)';
              }
              updateConnectionType('Подключено через: ' + selectedType + ' • stun.cloudflare.com');
            }
          }
        });
      }).catch(() => {
        updateConnectionType('Подключено через: STUN • stun.cloudflare.com');
      });
      
    } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      isConnected = false;
      updateStatus('Соединение разорвано', 'disconnected');
      updateConnectionType('Отключено');
      enableCallControls(false);
    } else if (state === 'connecting') {
      updateStatus('Установление соединения...', 'connecting');
    }
  };
  
  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE state:', peerConnection.iceConnectionState);
  };
}

async function handleRemoteSdp(sdpData) {
  // Игнорируем свои сообщения
  if (sdpData.from === currentUser) return;
  
  console.log('Processing remote SDP:', sdpData.type);
  
  if (sdpData.type === 'offer' && !isInitiator && !hasSentSdp) {
    // Мы - отвечающая сторона, получили OFFER
    updateStatus('Входящий звонок от ' + sdpData.from + '...', 'connecting');
    updateConnectionType('Получен Offer, подготовка Answer');
    
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ 
        video: true, 
        audio: true 
      });
      
      document.getElementById('localVideo').srcObject = localStream;
      createPeerConnection();
      
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });
      
      // Устанавливаем remote offer
      await peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: sdpData.sdp
      }));
      
      // Создаём ANSWER
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      
      await waitForIceGathering(3000);
      
      // Отправляем ANSWER
      const answerData = {
        type: 'answer',
        sdp: peerConnection.localDescription.sdp,
        from: currentUser,
        timestamp: Date.now()
      };
      
      await sendSdpMessage(answerData);
      hasSentSdp = true;
      isInitiator = false; // Мы отвечающая сторона
      
      updateStatus('Ответ отправлен! Соединение...', 'connecting');
      updateConnectionType('Answer отправлен через GitHub Gist');
      enableCallControls(true);
      
    } catch (err) {
      console.error('Handle offer error:', err);
      updateStatus('Ошибка при приеме звонка: ' + err.message, 'disconnected');
    }
    
  } else if (sdpData.type === 'answer' && isInitiator) {
    // Мы - инициатор, получили ANSWER
    updateStatus('Получен ответ! Соединение...', 'connecting');
    updateConnectionType('Получен Answer, подключение');
    
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: sdpData.sdp
      }));
    } catch (err) {
      console.error('Set answer error:', err);
    }
  }
}

// ===== MONITORING =====
function startMonitoring() {
  if (pollInterval) clearInterval(pollInterval);
  
  pollInterval = setInterval(async () => {
    if (isConnected) {
      stopMonitoring();
      return;
    }
    
    await checkForNewSdp();
  }, 2000);
}

function stopMonitoring() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function checkForNewSdp() {
  try {
    const url = PROXY_URL + '?action=read&file=' + encodeURIComponent(currentRoom);
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    
    if (!response.ok) return;
    
    const data = await response.json();
    
    if (!data.messages || !Array.isArray(data.messages)) return;
    
    // Проверяем только новые сообщения
    for (let i = data.messages.length - 1; i >= 0; i--) {
      if (i <= lastProcessedIndex) break;
      
      const msg = data.messages[i];
      if (!msg || !msg.encrypted) continue;
      
      try {
        const bytes = CryptoJS.AES.decrypt(msg.encrypted, currentSeed);
        const decrypted = bytes.toString(CryptoJS.enc.Utf8);
        const sdpData = JSON.parse(decrypted);
        
        lastProcessedIndex = i;
        await handleRemoteSdp(sdpData);
        
      } catch (e) {
        // Не расшифровалось - игнорируем
      }
    }
    
  } catch (err) {
    console.error('Monitor error:', err);
  }
}

// ===== HELPERS =====
async function sendSdpMessage(sdpData) {
  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(sdpData), currentSeed).toString();
  
  const resp = await fetch(PROXY_URL + '?action=write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: currentRoom, encrypted: encrypted })
  });
  
  const result = await resp.json();
  if (!result.success) throw new Error(result.error || 'Send failed');
}

async function waitForIceGathering(timeout = 3000) {
  return new Promise((resolve) => {
    if (peerConnection.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    
    const checkState = () => {
      if (peerConnection.iceGatheringState === 'complete') {
        peerConnection.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    };
    
    peerConnection.addEventListener('icegatheringstatechange', checkState);
    setTimeout(resolve, timeout);
  });
}

function updateStatus(text, state) {
  const statusBar = document.getElementById('status-bar');
  statusBar.textContent = text;
  statusBar.className = 'status-indicator status-' + state;
}

function updateConnectionType(text) {
  const connType = document.getElementById('connectionType');
  if (connType) {
    connType.textContent = 'Тип: ' + text;
  }
}

function enableCallControls(enabled) {
  const startBtn = document.getElementById('startCallBtn');
  const endBtn = document.getElementById('endCallBtn');
  const muteBtn = document.getElementById('muteBtn');
  
  if (startBtn) startBtn.disabled = enabled;
  if (endBtn) endBtn.disabled = !enabled;
  if (muteBtn) muteBtn.disabled = !enabled;
}

function toggleMute() {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const btn = document.getElementById('muteBtn');
      btn.textContent = audioTrack.enabled ? '🎤' : '🔇';
    }
  }
}

function endCall() {
  stopMonitoring();
  
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  isConnected = false;
  isInitiator = false;
  hasSentSdp = false;
  lastProcessedIndex = -1;
  
  document.getElementById('localVideo').srcObject = null;
  document.getElementById('remoteVideo').srcObject = null;
  
  updateStatus('Звонок завершен', 'disconnected');
  updateConnectionType('Ожидание...');
  enableCallControls(false);
}
