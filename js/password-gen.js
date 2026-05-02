// js/password-gen.js
export class PasswordGenerator {
  constructor() {
    this.CHARS = {
      az: 'abcdefghijklmnopqrstuvwxyz',
      AZ: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 
      '09': '0123456789',
      sym: '!@#$%^&*()_+-=[]{}|;:,.<>?',
      safe: 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' // без i,l,1,O,0
    };
  }

  parseHash(hash) {
    // Формат: #pwd:256-az,AZ,09,sym,json
    if (!hash?.startsWith('pwd:')) return null;
    const parts = hash.slice(4).split('-');
    const [lenStr, setsStr, mode] = parts;
    const length = parseInt(lenStr) || 256;
    const sets = (setsStr || 'az,AZ,09,sym').split(',').filter(s => this.CHARS[s]);
    const outputMode = mode === 'json' ? 'json' : 'plain';
    return { length, sets, mode: outputMode };
  }

  generate({ length = 256, sets = ['az','AZ','09','sym'], excludeSafe = false }) {
    let pool = '';
    const required = [];
    
    for (const set of sets) {
      const chars = excludeSafe && set !== 'sym' ? this.CHARS.safe : this.CHARS[set];
      if (chars) {
        pool += chars;
        required.push(chars);
      }
    }
    if (!pool) throw new Error('No character sets selected');

    // Гарантируем хотя бы один символ из каждого набора
    const pwd = required.map(set => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length]);
    
    // Заполняем остаток
    for (let i = pwd.length; i < length; i++) {
      pwd.push(pool[crypto.getRandomValues(new Uint32Array(1))[0] % pool.length]);
    }
    
    // Перемешиваем (Fisher-Yates)
    for (let i = pwd.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
    }
    
    return pwd.join('');
  }

  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback для старых браузеров
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); return true; }
      finally { document.body.removeChild(ta); }
    }
  }
}
