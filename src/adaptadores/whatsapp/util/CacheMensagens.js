/**
 * CacheMensagens - Gerenciamento de cache para deduplicação de mensagens
 */
const _ = require('lodash/fp');

const criarGerenciadorCache = (registrador) => {
  // Cache para deduplicação de mensagens
  const mensagensProcessadas = new Map();

  // Limpa mensagens antigas do cache periodicamente
  const limparCacheMensagensAntigas = () => {
    const agora = Date.now();
    
    // Remover mensagens processadas há mais de 15 minutos
    const idsAntigos = Array.from(mensagensProcessadas.entries())
      .filter(([_, timestamp]) => agora - timestamp > 15 * 60 * 1000)
      .map(([id, _]) => id);
      
    // Remover todos de uma vez
    if (idsAntigos.length > 0) {
      idsAntigos.forEach(id => mensagensProcessadas.delete(id));
      
    }
  };

  // Configurar limpeza periódica
  const iniciar = () => {
    const intervaloLimpeza = 30 * 60 * 1000; // 30 minutos
    setInterval(limparCacheMensagensAntigas, intervaloLimpeza);
    
  };

  return {
    cache: mensagensProcessadas,
    iniciar,
    limparCacheMensagensAntigas
  };
};

module.exports = criarGerenciadorCache;