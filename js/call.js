const PROXY_URL = 'https://chat.gigpino7.workers.dev';

let currentUser = '';
let currentSeed = '';
let currentRoom = '';
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let isCaller = false;
let isConnected = false;
let sdpPollInterval = null;
let lastSdpIndex = -1;
let pollRetryCount = 0;
const MAX_POLL_RETRIES = 3;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120000;

// Cloudflare STUN servers
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  const reloadBtn = document.getElementById('reload-sdp-btn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', loadRemoteSdpMessages);
  }
  
  // Проверяем URL параметры (если пришли из чата)
  const urlParams = new URLSearchParams(window.location.search);
  const seedFromUrl = urlParams.get('seed');
  const nameFromUrl = urlParams.get('name');
  
  if (seedFromUrl && nameFromUrl) {
    document.getElementById('roomInput').value = seedFromUrl;
    document.getElementById('userName').value = nameFromUrl;
    // Автоматически входим в комнату
    setTimeout(() => enterCall(), 500);
  }
});

// ===== CALL FUNCTIONS =====
function enterCall() {
  const nameInput = document.getElementById('userName');
  const roomInput = document.getElementById('roomInput');
  
  currentUser = nameInput.value.trim();
  currentSeed = roomInput.value.trim();
  currentRoom = 'sdp_' + currentSeed; // Уникальный файл для каждой комнаты
  
  if (!currentUser || !currentSeed) {
    alert('Enter name and Room ID!');
    return;
  }
  
  nameInput.value = '';
  roomInput.value = '';
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('call-screen').style.display = 'flex';
  document.getElementById('sdp-exchange').style.display = 'flex';
  document.getElementById('roomInfo').textContent = 'Room: ' + currentRoom;
  
  updateStatus('Ready to start call', 'disconnected');
}

async function startCall() {
  if (isConnected) {
    endCall();
    return;
  }
  
  try {
    // Get local media
    localStream = await navigator.mediaDevices.getUserMedia({ 
      video: true, 
      audio: true 
    });
    
    document.getElementById('localVideo').srcObject = localStream;
    
    // Create peer connection
    createPeerConnection();
    
    // Add local tracks
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    // Wait for ICE candidates
    await waitForIceGathering();
    
    // Encrypt and send offer via chat
    const sdpData = {
      type: 'offer',
      sdp: peerConnection.localDescription.sdp,
      from: currentUser,
      timestamp: Date.now()
    };
    
    await sendSdpMessage(sdpData);
    
    displayLocalSdp(JSON.stringify(sdpData));
    updateStatus('Offer sent! Waiting for answer...', 'connecting');
    
    isCaller = true;
    enableCallControls(true);
    
    // Start polling for answer
    pollForRemoteSdp();
    
  } catch (err) {
    console.error('Start call error:', err);
    alert('Failed to start call: ' + err.message);
    updateStatus('Error: ' + err.message, 'disconnected');
  }
}

async function receiveCall() {
  // This is called when we receive an offer from remote
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
    
    enableCallControls(true);
    
  } catch (err) {
    console.error('Receive call error:', err);
    alert('Failed to receive call: ' + err.message);
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('New ICE candidate');
    }
  };
  
  peerConnection.ontrack = (event) => {
    console.log('Received remote track');
    remoteStream = event.streams[0];
    document.getElementById('remoteVideo').srcObject = remoteStream;
  };
  
  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
    
    switch (peerConnection.connectionState) {
      case 'connected':
        isConnected = true;
        updateStatus('Connected!', 'connected');
        break;
      case 'disconnected':
      case 'failed':
      case 'closed':
        isConnected = false;
        updateStatus('Disconnected', 'disconnected');
        break;
      case 'connecting':
        updateStatus('Connecting...', 'connecting');
        break;
    }
  };
  
  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE state:', peerConnection.iceConnectionState);
  };
}

async function setRemoteSdp() {
  const input = document.getElementById('remoteSdpInput');
  const sdpText = input.value.trim();
  
  if (!sdpText) {
    alert('Paste SDP first!');
    return;
  }
  
  try {
    const sdpData = JSON.parse(sdpText);
    
    // Decrypt if it's encrypted
    let decryptedData;
    try {
      const bytes = CryptoJS.AES.decrypt(sdpData.encrypted, currentSeed);
      const decrypted = bytes.toString(CryptoJS.enc.Utf8);
      decryptedData = JSON.parse(decrypted);
    } catch (e) {
      // Not encrypted or wrong seed, use as-is
      decryptedData = sdpData;
    }
    
    if (!peerConnection) {
      createPeerConnection();
      
      // Add local tracks if we haven't already
      if (localStream) {
        localStream.getTracks().forEach(track => {
          peerConnection.addTrack(track, localStream);
        });
      } else {
        // Need to get media first
        await receiveCall();
      }
    }
    
    if (decryptedData.type === 'offer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: decryptedData.sdp
      }));
      
      // Create answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      
      await waitForIceGathering();
      
      const answerData = {
        type: 'answer',
        sdp: peerConnection.localDescription.sdp,
        from: currentUser,
        timestamp: Date.now()
      };
      
      await sendSdpMessage(answerData);
      displayLocalSdp(JSON.stringify(answerData));
      
      updateStatus('Answer sent! Waiting for connection...', 'connecting');
      
    } else if (decryptedData.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: decryptedData.sdp
      }));
      
      updateStatus('Connected!', 'connected');
    }
    
    input.value = '';
    
  } catch (err) {
    console.error('Set remote SDP error:', err);
    alert('Invalid SDP: ' + err.message);
  }
}

async function waitForIceGathering() {
  return new Promise((resolve) => {
    if (peerConnection.iceGatheringState === 'complete') {
      resolve();
    } else {
      const checkState = () => {
        if (peerConnection.iceGatheringState === 'complete') {
          peerConnection.removeEventListener('icegatheringstatechange', checkState);
          resolve();
        }
      };
      peerConnection.addEventListener('icegatheringstatechange', checkState);
      
      // Timeout after 5 seconds
      setTimeout(resolve, 5000);
    }
  });
}

async function sendSdpMessage(sdpData) {
  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(sdpData), currentSeed).toString();
  
  try {
    const resp = await fetch(PROXY_URL + '?action=write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentRoom, encrypted: encrypted })
    });
    
    const result = await resp.json();
    if (!result.success) throw new Error(result.error || 'Send failed');
    
  } catch (err) {
    console.error('Send SDP error:', err);
    throw err;
  }
}

async function loadRemoteSdpMessages() {
  try {
    const url = PROXY_URL + '?action=read&file=' + encodeURIComponent(currentRoom) + '&t=' + Date.now();
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    
    if (!response.ok) throw new Error('HTTP ' + response.status);
    
    const data = await response.json();
    
    if (data.messages && Array.isArray(data.messages)) {
      // Получаем только новые сообщения (после lastSdpIndex)
      for (let i = data.messages.length - 1; i > lastSdpIndex; i--) {
        const msg = data.messages[i];
        try {
          const bytes = CryptoJS.AES.decrypt(msg.encrypted, currentSeed);
          const decrypted = bytes.toString(CryptoJS.enc.Utf8);
          const sdpData = JSON.parse(decrypted);
          
          if (sdpData.from !== currentUser) {
            // Нашли сообщение от другого пользователя
            lastSdpIndex = i;
            document.getElementById('remoteSdpInput').value = msg.encrypted;
            updateStatus('Received ' + sdpData.type + ' from ' + sdpData.from, 'connecting');
            pollRetryCount = 0; // Сбрасываем счётчик ошибок
            return;
          }
        } catch (e) {
          console.warn('Decrypt failed:', e);
        }
      }
      
      // Если новых сообщений нет, но есть старые - показываем это
      if (data.messages.length > 0 && lastSdpIndex >= 0) {
        updateStatus('Waiting for partner...', 'connecting');
      }
    }
    
    if (lastSdpIndex < 0) {
      updateStatus('No messages yet', 'disconnected');
    }
    
  } catch (err) {
    console.error('Load SDP error:', err);
    pollRetryCount++;
    if (pollRetryCount >= MAX_POLL_RETRIES) {
      updateStatus('Connection error (retrying...)', 'disconnected');
      pollRetryCount = 0;
    }
  }
}

function pollForRemoteSdp() {
  // Очищаем предыдущий интервал если есть
  if (sdpPollInterval) {
    clearInterval(sdpPollInterval);
  }
  
  let pollTimeout = setTimeout(() => {
    if (sdpPollInterval) clearInterval(sdpPollInterval);
  }, POLL_TIMEOUT_MS);
  
  sdpPollInterval = setInterval(async () => {
    if (!isConnected) {
      await loadRemoteSdpMessages();
    } else {
      clearInterval(sdpPollInterval);
      clearTimeout(pollTimeout);
      sdpPollInterval = null;
    }
  }, POLL_INTERVAL_MS);
}

function displayLocalSdp(sdpText) {
  document.getElementById('localSdp').value = sdpText;
}

function copyLocalSdp() {
  const textarea = document.getElementById('localSdp');
  textarea.select();
  document.execCommand('copy');
  alert('Copied to clipboard!');
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
  // Останавливаем polling
  if (sdpPollInterval) {
    clearInterval(sdpPollInterval);
    sdpPollInterval = null;
  }
  
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  remoteStream = null;
  isConnected = false;
  isCaller = false;
  lastSdpIndex = -1;
  pollRetryCount = 0;
  
  document.getElementById('localVideo').srcObject = null;
  document.getElementById('remoteVideo').srcObject = null;
  
  updateStatus('Call ended', 'disconnected');
  enableCallControls(false);
}

function updateStatus(text, state) {
  const statusBar = document.getElementById('status-bar');
  statusBar.textContent = text;
  statusBar.className = 'status-indicator status-' + state;
}

function enableCallControls(enabled) {
  document.getElementById('startCallBtn').disabled = enabled;
  document.getElementById('endCallBtn').disabled = !enabled;
  document.getElementById('muteBtn').disabled = !enabled;
}
