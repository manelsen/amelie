/**
 * MonitorSaude - Versão simplificada
 * Verifica se o WhatsApp está ativo e reinicia via pm2 se necessário
 */

const { execSync } = require('child_process');

class MonitorSaude {
  constructor(clienteWhatsApp) {
    this.clienteWhatsApp = clienteWhatsApp;
    this.intervalo = null;
  }

  iniciar() {
    // Verifica a cada 60 segundos
    this.intervalo = setInterval(() => {
      this.verificarEstado();
    }, 60000);
  }

  verificarEstado() {
    if (!this.clienteWhatsApp || !this.clienteWhatsApp.pronto) {
      console.log('[MonitorSaude] WhatsApp inativo! Reiniciando via pm2...');
      try {
        execSync('pm2 restart all');
      } catch (error) {
        console.error('Erro ao reiniciar pm2:', error);
      }
    }
  }

  parar() {
    if (this.intervalo) {
      clearInterval(this.intervalo);
    }
  }
}

module.exports = MonitorSaude;