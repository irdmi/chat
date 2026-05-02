const PROXY_URL = 'https://chat.gigpino7.workers.dev';
const FILE_NAME = 'chat';

let currentUser = '';
let currentSeed = '';
let currentChatId = null;

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadChatsFromStorage();
});

function setupEventListeners() {
  // Menu button
  document.getElementById('menu-btn')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('overlay').classList.add('show');
  });
  
  // Close sidebar
  document.getElementById('close-sidebar')?.addEventListener('click', closeSidebar);
  document.getElementById('overlay')?.addEventListener('click', closeSidebar);
  
  // Password generator button
  document.getElementById('pwd-btn')?.addEventListener('click', () => {
    document.getElementById('pwd-modal').classList.add('show');
    generatePassword();
  });
  
  // Password length slider
  document.getElementById('pwd-len')?.addEventListener('input', (e) => {
    document.getElementById('pwd-len-val').textContent = e.target.value;
  });
  
  // Reload button
  document.getElementById('reload-btn')?.addEventListener('click', loadMessages);
  
  // Enter key for messages
  document.getElementById('msgInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}

function closePwdModal() {
  document.getElementById('pwd-modal').classList.remove('show');
}

// ===== CHAT FUNCTIONS =====
function enterChat() {
  const nameInput = document.getElementById('userName');
  const seedInput = document.getElementById('seedPhrase');
  
  currentUser = nameInput.value.trim();
  currentSeed = seedInput.value.trim();
  
  if (!currentUser || !currentSeed) {
    alert('Enter name and seed!');
    return;
  }
  
  seedInput.value = '';
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('chat-screen').style.display = 'flex';
  document.getElementById('display-name').textContent = currentUser;
  
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
  closeSidebar();
}

function loadChatsFromStorage() {
  const chats = JSON.parse(localStorage.getItem('chats') || '[]');
  const list = document.getElementById('chat-list');
  if (!list) return;
  
  list.innerHTML = '';
  chats.forEach(chat => {
    const li = document.createElement('li');
    li.textContent = chat.name;
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
  
  document.getElementById('display-name').textContent = chat.name;
  closeSidebar();
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
    msgDiv.innerHTML = '<div class="msg-item" style="color:#f85">Load failed</div>';
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
      body: JSON.stringify({ file: FILE_NAME, encrypted: encrypted })
    });
    
    const result = await resp.json();
    if (!result.success) throw new Error(result.error || 'Unknown error');
    
    loadMessages();
  } catch (err) {
    console.error('Send error:', err);
    alert('Send error: ' + err.message);
    input.value = text;
  }
}

// ===== PASSWORD GENERATOR =====
function generatePassword() {
  const length = parseInt(document.getElementById('pwd-len').value);
  const useAZ = document.getElementById('pwd-az').checked;
  const useAZUpper = document.getElementById('pwd-AZ').checked;
  const use09 = document.getElementById('pwd-09').checked;
  const useSym = document.getElementById('pwd-sym').checked;
  
  let chars = '';
  if (useAZ) chars += 'abcdefghijklmnopqrstuvwxyz';
  if (useAZUpper) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (use09) chars += '0123456789';
  if (useSym) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';
  
  if (!chars) {
    document.getElementById('pwd-result').textContent = 'Select at least one';
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
    alert('✓ Copied!');
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
  alert('✓ Link copied!');
}
