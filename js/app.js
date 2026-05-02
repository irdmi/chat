// В начале файла: импорт
import { PasswordGenerator } from './password-gen.js';

// После объявления переменных
const pwdGen = new PasswordGenerator();
let pwdConfig = { length: 256, sets: ['az','AZ','09','sym'], excludeSafe: false };

// === Обработчики для генератора паролей ===
function openPwdModal() {
  document.getElementById('pwd-modal').classList.remove('hidden');
  updatePwdUI();
  generatePassword();
}

function closePwdModal() {
  document.getElementById('pwd-modal').classList.add('hidden');
}

function updatePwdUI() {
  document.getElementById('pwd-len').value = pwdConfig.length;
  document.getElementById('pwd-len-val').textContent = pwdConfig.length;
  document.querySelectorAll('.pwd-sets input[data-set]').forEach(cb => {
    cb.checked = pwdConfig.sets.includes(cb.dataset.set);
  });
  document.querySelector('.pwd-sets [data-set="safe"]').checked = pwdConfig.excludeSafe;
}

function generatePassword() {
  try {
    const pwd = pwdGen.generate(pwdConfig);
    document.getElementById('pwd-result').textContent = pwd;
    return pwd;
  } catch (e) {
    document.getElementById('pwd-result').textContent = `Error: ${e.message}`;
    return null;
  }
}

async function copyPassword() {
  const pwd = document.getElementById('pwd-result').textContent;
  if (pwd && pwd !== '—' && !pwd.startsWith('Error')) {
    await pwdGen.copy(pwd);
    showToast('✓ Password copied');
  }
}

function copyConfigLink() {
  const sets = pwdConfig.sets.join(',');
  const safe = pwdConfig.excludeSafe ? ',safe' : '';
  const hash = `#pwd:${pwdConfig.length}-${sets}${safe}`;
  const url = `${location.origin}${location.pathname}${hash}`;
  pwdGen.copy(url);
  showToast('✓ Config link copied');
}

function handlePwdHash() {
  const hash = location.hash.slice(1);
  const config = pwdGen.parseHash(hash);
  if (config) {
    pwdConfig = {
      length: config.length,
      sets: config.sets,
      excludeSafe: config.sets.includes('safe'),
      mode: config.mode
    };
    openPwdModal();
    generatePassword();
    // Если режим json/plain — можно показать результат и закрыть
    if (config.mode === 'plain' || config.mode === 'json') {
      const pwd = generatePassword();
      if (config.mode === 'plain') {
        document.body.innerHTML = `<pre style="font-family:monospace">${pwd}</pre>`;
      } else {
        document.body.innerHTML = `<pre>${JSON.stringify({ password: pwd, length: pwdConfig.length, sets: pwdConfig.sets }, null, 2)}</pre>`;
      }
    }
    // Очищаем хэш
    history.replaceState(null, '', location.pathname);
    return true;
  }
  return false;
}

// === Подключение событий ===
document.addEventListener('DOMContentLoaded', () => {
  // ... ваши существующие обработчики ...
  
  // Кнопка генератора в хедере
  const genBtn = document.createElement('button');
  genBtn.id = 'pwd-gen-btn';
  genBtn.className = 'small-btn';
  genBtn.textContent = '🔑 Gen';
  genBtn.title = 'Generate password';
  genBtn.onclick = openPwdModal;
  document.querySelector('.header')?.appendChild(genBtn);
  
  // Обработчики модального окна
  document.getElementById('pwd-close').onclick = closePwdModal;
  document.getElementById('pwd-generate').onclick = generatePassword;
  document.getElementById('pwd-copy').onclick = copyPassword;
  document.getElementById('pwd-share').onclick = copyConfigLink;
  
  // Слайдер длины
  document.getElementById('pwd-len').oninput = (e) => {
    pwdConfig.length = +e.target.value;
    document.getElementById('pwd-len-val').textContent = e.target.value;
  };
  
  // Чекбоксы наборов
  document.querySelectorAll('.pwd-sets input[data-set]').forEach(cb => {
    cb.onchange = (e) => {
      const set = e.target.dataset.set;
      if (set === 'safe') {
        pwdConfig.excludeSafe = e.target.checked;
      } else {
        if (e.target.checked) {
          if (!pwdConfig.sets.includes(set)) pwdConfig.sets.push(set);
        } else {
          pwdConfig.sets = pwdConfig.sets.filter(s => s !== set);
        }
      }
    };
  });
  
  // Закрытие по клику вне окна
  document.getElementById('pwd-modal').onclick = (e) => {
    if (e.target.id === 'pwd-modal') closePwdModal();
  };
  
  // Обработка хэша при загрузке
  if (!handlePwdHash()) {
    // Ваша существующая логика хэша (join: и т.д.)
    handleDeepLink?.();
  }
});

// Утилита для тостов (если нет в ui.js)
function showToast(msg, ms = 2000) {
  let toast = document.getElementById('global-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'global-toast';
    toast.className = 'toast hidden';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), ms);
}
