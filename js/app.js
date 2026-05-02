const PROXY_URL = 'https://chat.gigpino7.workers.dev';
const FILE_NAME = 'chat';

let currentUser = '';
let currentSeed = '';
let currentChatId = null;

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded');
  setupEventListeners();
  loadChatsFromStorage();
});

function setupEventListeners() {
  console.log('Setting up event listeners');
  
  // Menu button
  const menuBtn = document.getElementById('menu-btn');
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      console.log('Menu clicked');
      document.getElementById('sidebar').classList.add('open');
      document.getElementById('overlay').classList.add('show');
    });
  }
  
  // Close sidebar
  const closeBtn = document.getElementById('close-sidebar');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeSidebar);
  }
  
  const overlay = document.getElementById('overlay');
  if (overlay) {
    overlay.addEventListener('click', closeSidebar);
  }
  
  // Reload button
  const reloadBtn = document.getElementById('reload-btn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', loadMessages);
  }
  
  // Enter key for messages
  const msgInput = document.getElementById('msgInput');
  if (msgInput) {
    msgInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
  }
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}

// ===== CHAT FUNCTIONS =====
function enterChat() {
  console.log('enterChat called');
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
  console.log('createNewChat called');
  const name = prompt('Chat name:');
  const seed = prompt('Encryption seed:');
  if (!name || !seed) return;
  
  const id = crypto.randomUUID();
  const chats = JSON.parse(localStorage.getItem('chats') || '[]');
  chats.push({ id: id, name: name, seed: seed, created: Date.now() });
  localStorage.setItem('chats', JSON.stringify(chats));
  
  loadChatsFromStorage();
  closeSidebar();
  alert('Chat created!');
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
  console.log('loadMessages called');
  const msgDiv = document.getElementById('messages');
  if (!msgDiv) return;
  
  try {
    const url = PROXY_URL + '?action=read&file=' + encodeURIComponent(FILE_NAME) + '&t=' + Date.now();
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    
    if (!response.ok) throw new Error('HTTP ' + response.status);
    
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
  console.log('sendMessage called');
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (!text) return;
  
  const fullMessage = currentUser + ': ' + text;
  const encrypted = CryptoJS.AES.encrypt(fullMessage, currentSeed).toString();
  
  input.value = '';
  
  try {
    const resp = await fetch(PROXY_URL + '?action=write', {
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
