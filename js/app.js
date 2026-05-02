// ===== CONFIG =====
const PROXY_URL = 'https://chat.gigpino7.workers.dev';
const FILE_NAME = 'chat';

// ===== STATE =====
let currentUser = '';
let currentSeed = '';
let currentChatId = null;
let messageQueue = [];
let isSending = false;

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadChatsFromStorage();
  checkUrlHash();
});

function setupEventListeners() {
  // Menu
  document.getElementById('menu-btn')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('hidden');
  });
  
  document.getElementById('close-sidebar')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('hidden');
  });
  
  // Password Generator
  document.getElementById('pwd-btn')?.addEventListener('click', openPwdModal);
  document.getElementById('pwd-len')?.addEventListener('input', (e) => {
    document.getElementById('pwd-len-val').textContent = e.target.value;
  });
  
  // Reload
  document.getElementById('reload-btn')?.addEventListener('click', loadMessages);
  
  // Enter key
  document.getElementById('msgInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
}

// ===== CHAT FUNCTIONS =====
function enterChat() {
  const nameInput = document.getElementById('userName');
  const seedInput = document.getElementById('seedPhrase');
  
  currentUser = nameInput.value.trim();
  currentSeed = seedInput.value.trim();
  
  if (!currentUser || !currentSeed) {
    showToast('⚠️ Enter name and seed', 'error');
    return;
  }
  
  seedInput.value = '';
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('chat-screen').classList.remove('hidden');
  document.getElementById('chat-title').textContent = currentUser;
  
  loadMessages();
}

function createNewChat() {
  const name = prompt('Chat name:');
  const seed = prompt('Encryption seed:');
  if (!name || !seed) return;
  
  const id = crypto.randomUUID();
  const chats = JSON.parse(localStorage.getItem('chats') || '[]');
  chats.push({ id, name, seed, created: Date.now() });
  localStorage.setItem('chats', JSON.stringify(chats));
  
  loadChatsFromStorage();
  showToast('✓ Chat created');
}

function loadChatsFromStorage() {
  const chats = JSON.parse(localStorage.getItem('chats') || '[]');
  const list = document.getElementById('chat-list');
  if (!list) return;
  
  list.innerHTML = '';
  chats.forEach(chat => {
    const li = document.createElement('li');
    li.textContent = chat.name;
    li.dataset.id = chat.id;
    if (chat.id === currentChatId) li.classList.add('active');
    li.onclick = () => switchChat(chat.id);
    list.appendChild(li);
  });
}

function switchChat(id) {
  const chats = JSON.parse(localStorage.getItem('chats') || '[]');
  const chat = chats.find(c => c.id === id);
  if (!chat) return;
  
  currentChatId = id;
  currentUser = chat.name;
  currentSeed = chat.seed;
  
  document.getElementById('chat-title').textContent = chat.name;
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('chat-screen').classList.remove('hidden');
  document.getElementById('sidebar').classList.add('hidden');
  
  loadChatsFromStorage();
  loadMessages();
}

// ===== MESSAGES =====
async function loadMessages() {
  const msgDiv = document.getElementById('messages');
  if (!msgDiv) return;
  
  try {
    const url = `${PROXY_URL}?action=read&file=${encodeURIComponent(FILE_NAME)}&t=${Date.now()}`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    msgDiv.innerHTML = '';
    
    if (data.messages && Array.isArray(data.messages)) {
      for (const msg of data.messages) {
        try {
          const bytes = CryptoJS.AES.decrypt(msg.encrypted, currentSeed);
          const decrypted = bytes.toString(CryptoJS.enc.Utf8);
          if (decrypted) {
            const div = document.createElement('div');
            div.className = 'msg-item';
            div.textContent = decrypted;
            msgDiv.appendChild(div);
          }
        } catch (e) {
          console.warn('Decrypt failed:', e);
        }
      }
      msgDiv.scrollTop = msgDiv.scrollHeight;
    }
  } catch (err) {
    console.error('Load error:', err);
    msgDiv.innerHTML = '<div class="msg-item" style="color:var(--error-color)">Load failed</div>';
  }
}

async function sendMessage() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (!text) return;
  
  const fullMessage = `${currentUser}: ${text}`;
  const encrypted = CryptoJS.AES.encrypt(fullMessage, currentSeed).toString();
  
  input.value = '';
  
  try {
    const resp = await fetch(`${PROXY_URL}?action=write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: FILE_NAME, encrypted })
    });
    
    const result = await resp.json();
    
    if (resp.status === 429) {
      // Rate limit
      document.getElementById('rate-modal').classList.remove('hidden');
      messageQueue.push(encrypted);
      return;
    }
    
    if (!result.success) throw new Error(result.error);
    
    loadMessages();
    showToast('✓ Sent');
  } catch (err) {
    console.error('Send error:', err);
    showToast('✗ Send failed: ' + err.message, 'error');
    input.value = text;
  }
}

function waitAndSend() {
  document.getElementById('rate-modal').classList.add('hidden');
  setTimeout(() => {
    processQueue();
  }, 5000);
}

function sendNow() {
  document.getElementById('rate-modal').classList.add('hidden');
  processQueue();
}

async function processQueue() {
  while (messageQueue.length > 0) {
    const encrypted = messageQueue.shift();
    try {
      await fetch(`${PROXY_URL}?action=write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: FILE_NAME, encrypted })
      });
    } catch (e) {
      console.error('Queue send failed:', e);
    }
  }
  loadMessages();
}

// ===== PASSWORD GENERATOR =====
function openPwdModal() {
  // Close other modals first
  document.getElementById('rate-modal').classList.add('hidden');
  document.getElementById('pwd-modal').classList.remove('hidden');
  generatePassword();
}

function closePwdModal() {
  document.getElementById('pwd-modal').classList.add('hidden');
}

function generatePassword() {
  const length = parseInt(document.getElementById('pwd-len').value);
  const useAZ = document.getElementById('pwd-az').checked;
  const useAZUpper = document.getElementById('pwd-AZ').checked;
  const use09 = document.getElementById('pwd-09').checked;
  const useSym = document.getElementById('pwd-sym').checked;
  const useSafe = document.getElementById('pwd-safe').checked;
  
  let chars = '';
  if (useAZ) chars += 'abcdefghijklmnopqrstuvwxyz';
  if (useAZUpper) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (use09) chars += '0123456789';
  if (useSym) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
  if (useSafe) chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  
  if (!chars) {
    document.getElementById('pwd-result').textContent = 'Select at least one set';
    return;
  }
  
  let password = '';
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  
  for (let i = 0; i < length; i++) {
    password += chars[array[i] % chars.length];
  }
  
  document.getElementById('pwd-result').textContent = password;
}

async function copyPassword() {
  const pwd = document.getElementById('pwd-result').textContent;
  if (pwd && pwd !== '—') {
    await navigator.clipboard.writeText(pwd);
    showToast('✓ Copied');
  }
}

function copyConfigLink() {
  const length = document.getElementById('pwd-len').value;
  const sets = [];
  if (document.getElementById('pwd-az').checked) sets.push('az');
  if (document.getElementById('pwd-AZ').checked) sets.push('AZ');
  if (document.getElementById('pwd-09').checked) sets.push('09');
  if (document.getElementById('pwd-sym').checked) sets.push('sym');
  
  const hash = `#pwd:${length}-${sets.join(',')}`;
  const url = window.location.origin + window.location.pathname + hash;
  
  navigator.clipboard.writeText(url);
  showToast('✓ Link copied');
}

function checkUrlHash() {
  const hash = window.location.hash.slice(1);
  if (hash.startsWith('pwd:')) {
    openPwdModal();
  }
}

// ===== UTILS =====
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}
