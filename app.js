const PROXY_URL = 'https://chat.gigpino7.workers.dev';
const FILE_NAME = 'chat';

let currentUser = '';
let currentSeed = ''; // Stored only in the tab's memory

// === ENTER THE CHAT ===
function enterChat() {
    const nameInput = document.getElementById('userName');
    const seedInput = document.getElementById('seedPhrase');
    
    currentUser = nameInput.value.trim();
    currentSeed = seedInput.value.trim();

    if (!currentUser || !currentSeed) {
        alert("Введите имя и ключ!");
        return;
    }

    // Hide the key field after login (optional)
    seedInput.value = ''; 
    seedInput.disabled = true;

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('chat-screen').style.display = 'flex';
    document.getElementById('display-name').textContent = currentUser;
    
    loadMessages();
}

// Enter
document.addEventListener('DOMContentLoaded', () => {
    const msgInput = document.getElementById('msgInput');
    if (msgInput) {
        msgInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });
    }
});

// === LOADING MESSAGES ===
async function loadMessages() {
    const msgDiv = document.getElementById('messages');
    
    try {
        // Read request: seed NOT passed
        const url = `${PROXY_URL}?action=read&file=${encodeURIComponent(FILE_NAME)}&t=${Date.now()}`;
        
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });
        
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // === DECIPHERING ONLY ON THE CLIENT ===
        msgDiv.innerHTML = '';
        if (data.messages && Array.isArray(data.messages)) {
            data.messages.forEach(msg => {
                try {
                    // Decrypt locally using the key from memory
                    const bytes = CryptoJS.AES.decrypt(msg.encrypted, currentSeed);
                    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
                    
                    if (decrypted) {
                        const div = document.createElement('div');
                        div.className = 'msg-item';
                        div.textContent = decrypted; 
                        msgDiv.appendChild(div);
                    }
                } catch (e) {
                    // Skipping messages that were not decrypted (invalid key)
                    console.warn('Decrypt failed:', e);
                }
            });
            msgDiv.scrollTop = msgDiv.scrollHeight;
        }
    } catch (err) {
        console.error('Load error:', err);
        msgDiv.innerHTML = '<center style="color:#f85">Ошибка загрузки</center>';
    }
}

// === SENDING A MESSAGE ===
async function sendMessage() {
    const input = document.getElementById('msgInput');
    const text = input.value.trim();
    if (!text) return;

    const fullMessage = `${currentUser}: ${text}`;
    
    // === CLIENT-ONLY ENCRYPTION ===
    const encrypted = CryptoJS.AES.encrypt(fullMessage, currentSeed).toString();

    input.value = ''; // clearing

    try {
        // We send ONLY the encrypted text. We do not transmit the seed.
        const resp = await fetch(`${PROXY_URL}?action=write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                file: FILE_NAME, 
                encrypted: encrypted // Only this goes to the server
            })
        });
        
        const result = await resp.json();
        if (!result.success) throw new Error(result.error || 'Unknown error');
        
        loadMessages(); // updating the list
    } catch (err) {
        console.error('Send error:', err);
        alert("Ошибка отправки: " + err.message);
        input.value = text; // return text on error
    }
}
