// js/call-ui.js - Call UI Management

export class CallUI {
  constructor(callModule) {
    this.call = callModule;
    
    // Устанавливаем callback для hangup
    if (this.call) {
      this.call.onHangup = () => this.hide();
    }
  }

  show(peerName) {
    const peerEl = document.getElementById('call-peer');
    if (peerEl) {
      peerEl.textContent = peerName || 'Unknown';
    }
    
    const overlay = document.getElementById('call-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
    }
  }

  hide() {
    const overlay = document.getElementById('call-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
    }
  }

  bindControls() {
    const btnHangup = document.getElementById('btn-hangup');
    const btnMute = document.getElementById('btn-mute');
    const btnVideo = document.getElementById('btn-video');

    if (btnHangup) {
      btnHangup.onclick = () => {
        if (this.call) {
          this.call.hangup();
        }
      };
    }

    if (btnMute) {
      btnMute.onclick = () => {
        if (this.call) {
          this.call.toggleMute();
        }
      };
    }

    if (btnVideo) {
      btnVideo.onclick = () => {
        if (this.call) {
          this.call.toggleVideo();
        }
      };
    }
  }

  updatePeerName(name) {
    const peerEl = document.getElementById('call-peer');
    if (peerEl) {
      peerEl.textContent = name || 'Unknown';
    }
  }

  updateStatus(status) {
    const statusEl = document.getElementById('call-status');
    if (statusEl) {
      statusEl.textContent = status;
    }
  }
}
